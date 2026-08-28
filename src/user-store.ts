import { LIMITS } from './domain';
import { PBKDF2_ITERATIONS, verifyPassword } from './auth';
import { readJsonBody } from './validation';

/**
 * One Durable Object per account, addressed by the normalised email. That gives
 * uniqueness for free — two registrations for the same address land in the same
 * object — and keeps the password hash out of every other code path.
 */
export type UserRecord = {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  createdAt: string;
  groups: UserGroupRef[];
};

export type UserGroupRef = {
  groupId: string;
  name: string;
  revealYear: number;
  role: 'owner' | 'member';
  joinedAt: string;
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/**
 * Verified against when the account does not exist, so that a failed login costs
 * the same whether or not the address is registered.
 */
const ABSENT_ACCOUNT_HASH = `pbkdf2$${PBKDF2_ITERATIONS}$${'A'.repeat(22)}$${'B'.repeat(43)}`;

const publicUser = (user: UserRecord) => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
});

export class UserStore {
  constructor(private readonly ctx: DurableObjectState, private readonly _env: unknown) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const user = await this.ctx.storage.get<UserRecord>('user');

    if (url.pathname === '/register' && request.method === 'POST') {
      if (user) {
        return jsonResponse({ error: 'An account with this email already exists' }, 409);
      }

      const body = await readJsonBody(request);
      if (!body.ok) {
        return jsonResponse({ error: body.error }, 400);
      }

      const { id, email, displayName, passwordHash } = body.value;
      if (
        typeof id !== 'string' ||
        typeof email !== 'string' ||
        typeof displayName !== 'string' ||
        typeof passwordHash !== 'string'
      ) {
        return jsonResponse({ error: 'Invalid account payload' }, 400);
      }

      const record: UserRecord = {
        id,
        email,
        displayName,
        passwordHash,
        createdAt: new Date().toISOString(),
        groups: [],
      };

      await this.ctx.storage.put('user', record);
      return jsonResponse({ user: publicUser(record) }, 201);
    }

    if (url.pathname === '/login' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body.ok) {
        return jsonResponse({ error: body.error }, 400);
      }

      const password = body.value.password;
      if (typeof password !== 'string') {
        return jsonResponse({ error: 'Invalid credentials' }, 401);
      }

      // Same response and same amount of work whether the account is missing or
      // the password is wrong, so this endpoint cannot be used to enumerate
      // registered addresses.
      const matches = await verifyPassword(password, user?.passwordHash ?? ABSENT_ACCOUNT_HASH);
      if (!user || !matches) {
        return jsonResponse({ error: 'Email or password is incorrect' }, 401);
      }

      return jsonResponse({ user: publicUser(user) });
    }

    if (!user) {
      return jsonResponse({ error: 'Account not found' }, 404);
    }

    if (url.pathname === '/account' && request.method === 'GET') {
      return jsonResponse({ user: publicUser(user), groups: user.groups });
    }

    if (url.pathname === '/groups' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body.ok) {
        return jsonResponse({ error: body.error }, 400);
      }

      const { groupId, name, revealYear, role } = body.value;
      if (
        typeof groupId !== 'string' ||
        typeof name !== 'string' ||
        typeof revealYear !== 'number' ||
        (role !== 'owner' && role !== 'member')
      ) {
        return jsonResponse({ error: 'Invalid group reference' }, 400);
      }

      const existing = user.groups.find((group) => group.groupId === groupId);
      if (existing) {
        return jsonResponse({ groups: user.groups });
      }

      if (user.groups.length >= LIMITS.groupsPerUser) {
        return jsonResponse({ error: `You can belong to at most ${LIMITS.groupsPerUser} groups` }, 409);
      }

      user.groups.push({ groupId, name, revealYear, role, joinedAt: new Date().toISOString() });
      await this.ctx.storage.put('user', user);
      return jsonResponse({ groups: user.groups }, 201);
    }

    return jsonResponse({ error: 'Not found' }, 404);
  }
}
