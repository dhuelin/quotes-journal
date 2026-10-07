import { LIMITS, type ImageContentType, type StoredImage } from './domain';
import { imageResponseHeaders } from './images';
import { hashPassword, readHashIterations, resolvePbkdf2Iterations, verifyPassword } from './auth';
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
  /**
   * Bumped to invalidate every session this account has issued so far. Absent
   * on accounts created before revocation existed, which read as 0 — the same
   * value a never-revoked account has, so nobody is signed out by the deploy.
   */
  tokenVersion?: number;
  /** Metadata only; the bytes are their own key, as every stored picture is. */
  avatar?: StoredImage;
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
 * the same whether or not the address is registered. Built at the configured
 * round count so the timing keeps matching a real hash after a raise.
 */
const absentAccountHash = (iterations: number): string =>
  `pbkdf2$${iterations}$${'A'.repeat(22)}$${'B'.repeat(43)}`;

const publicUser = (user: UserRecord) => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  hasAvatar: user.avatar !== undefined,
});

const AVATAR_KEY = 'avatar';

const versionOf = (user: UserRecord): number => user.tokenVersion ?? 0;

export class UserStore {
  constructor(private readonly ctx: DurableObjectState, private readonly _env: unknown) {}

  async fetch(request: Request): Promise<Response> {
    // An unexpected storage failure would otherwise surface as a plain-text 500
    // that the clients cannot read an error message out of.
    try {
      return await this.route(request);
    } catch {
      return jsonResponse({ error: 'The account could not be updated, please try again later' }, 500);
    }
  }

  private async route(request: Request): Promise<Response> {
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
      return jsonResponse({ user: publicUser(record), tokenVersion: 0 }, 201);
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

      // The Worker owns the PBKDF2 configuration and passes it down; this object
      // is only reachable from there.
      const iterations = resolvePbkdf2Iterations(body.value.iterations);

      // Same response and same amount of work whether the account is missing or
      // the password is wrong, so this endpoint cannot be used to enumerate
      // registered addresses.
      const matches = await verifyPassword(password, user?.passwordHash ?? absentAccountHash(iterations));
      if (!user || !matches) {
        return jsonResponse({ error: 'Email or password is incorrect' }, 401);
      }

      // A stored hash records the rounds it was made with, so an account created
      // under a lower setting is upgraded here, the one moment the plaintext is
      // available.
      if ((readHashIterations(user.passwordHash) ?? 0) < iterations) {
        user.passwordHash = await hashPassword(password, iterations);
        await this.ctx.storage.put('user', user);
      }

      return jsonResponse({ user: publicUser(user), tokenVersion: versionOf(user) });
    }

    /**
     * A userId -> address pointer, so that one member's avatar can be served to
     * another.
     *
     * A group stores account ids and this namespace is keyed by address, so
     * there is otherwise no way from "the person who said this" to their
     * account. The pointer is a second object in the *same* namespace, named
     * `uid:<id>` — no new class and no migration — holding nothing but the
     * address. It is deliberately not reachable from any public route: only the
     * Worker addresses it, and only to resolve an avatar.
     */
    if (url.pathname === '/link') {
      if (request.method === 'POST') {
        const body = await readJsonBody(request);
        if (!body.ok) {
          return jsonResponse({ error: body.error }, 400);
        }
        if (typeof body.value.email !== 'string') {
          return jsonResponse({ error: 'Invalid link' }, 400);
        }
        await this.ctx.storage.put('link', body.value.email);
        return jsonResponse({ linked: true });
      }

      if (request.method === 'GET') {
        const email = await this.ctx.storage.get<string>('link');
        return email ? jsonResponse({ email }) : jsonResponse({ error: 'Not found' }, 404);
      }
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

    if (url.pathname === '/display-name' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body.ok) {
        return jsonResponse({ error: body.error }, 400);
      }

      if (typeof body.value.displayName !== 'string') {
        return jsonResponse({ error: 'Invalid display name' }, 400);
      }

      user.displayName = body.value.displayName;
      await this.ctx.storage.put('user', user);
      return jsonResponse({ user: publicUser(user) });
    }

    /**
     * Drops a group from the account's list. Used both when leaving and when a
     * group turns out to be unreachable; harmless if it was not there.
     */
    if (url.pathname === '/groups/forget' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body.ok) {
        return jsonResponse({ error: body.error }, 400);
      }

      user.groups = user.groups.filter((group) => group.groupId !== body.value.groupId);
      await this.ctx.storage.put('user', user);
      return jsonResponse({ groups: user.groups });
    }

    /**
     * Refreshes the cached name of one group (#9).
     *
     * The account caches each group's name so the group list needs no fan-out
     * of reads. A rename makes that cache stale, and the group object cannot
     * push the new name to the other members — it stores their account ids, not
     * their addresses, and the account objects are keyed by address. Storing
     * emails on the group to make a push possible would put every member's
     * address inside the group value, which is a poor trade for a cached label.
     *
     * So it heals instead of pushing: whoever opens the group is holding the
     * real name, and writes it back to their own account. The owner's list is
     * correct immediately, everyone else's the next time they look at the group.
     */
    if (url.pathname === '/groups/touch' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body.ok) {
        return jsonResponse({ error: body.error }, 400);
      }

      const { groupId, name, revealYear } = body.value;
      const cached = user.groups.find((group) => group.groupId === groupId);
      if (!cached || typeof name !== 'string' || typeof revealYear !== 'number') {
        return jsonResponse({ groups: user.groups });
      }

      if (cached.name === name && cached.revealYear === revealYear) {
        return jsonResponse({ groups: user.groups });
      }

      cached.name = name;
      cached.revealYear = revealYear;
      await this.ctx.storage.put('user', user);
      return jsonResponse({ groups: user.groups });
    }

    /**
     * The cheapest possible read, because every authenticated request makes it.
     * Returning the whole account would mean carrying the groups list and the
     * password hash through a hot path that needs one integer.
     */
    if (url.pathname === '/token-version' && request.method === 'GET') {
      return jsonResponse({ tokenVersion: versionOf(user) });
    }

    /** What the reset mail needs: who to greet, and which generation to sign. */
    if (url.pathname === '/reset-subject' && request.method === 'GET') {
      return jsonResponse({ displayName: user.displayName, tokenVersion: versionOf(user) });
    }

    /** Signs out every other device, and this one too unless it takes a new token. */
    if (url.pathname === '/revoke' && request.method === 'POST') {
      user.tokenVersion = versionOf(user) + 1;
      await this.ctx.storage.put('user', user);
      return jsonResponse({ user: publicUser(user), tokenVersion: user.tokenVersion });
    }

    /**
     * Changes the password for someone already signed in, which means proving
     * they know the current one: a session token alone is not enough, or a
     * borrowed laptop would be a permanent account takeover.
     *
     * A successful change bumps the token version. Changing a password you
     * believe to be compromised has to end the sessions opened with it, or the
     * change achieves nothing.
     */
    if (url.pathname === '/password' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body.ok) {
        return jsonResponse({ error: body.error }, 400);
      }

      const { currentPassword, newPassword, iterations: rounds } = body.value;
      if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
        return jsonResponse({ error: 'Invalid payload' }, 400);
      }

      const iterations = resolvePbkdf2Iterations(rounds);
      // 403 rather than 401 on purpose. The client's rule is that a 401 means
      // the session is gone, and acts on it by signing out — so a route that
      // rejects a credential in the *body* must not use that status, or
      // mistyping your current password would log you out of the page you are
      // standing on.
      if (!(await verifyPassword(currentPassword, user.passwordHash))) {
        return jsonResponse({ error: 'Your current password is not right' }, 403);
      }

      user.passwordHash = await hashPassword(newPassword, iterations);
      user.tokenVersion = versionOf(user) + 1;
      await this.ctx.storage.put('user', user);
      return jsonResponse({ user: publicUser(user), tokenVersion: user.tokenVersion });
    }

    /**
     * Sets a new password from a reset link.
     *
     * No current password: the whole point is that it has been forgotten. What
     * stands in for it is the signed link, which the Worker has already checked
     * — and the version in that link, re-checked here against the stored one so
     * a link cannot be redeemed twice or used after a later reset supersedes it.
     */
    if (url.pathname === '/password/reset' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body.ok) {
        return jsonResponse({ error: body.error }, 400);
      }

      const { newPassword, tokenVersion: presented, iterations: rounds } = body.value;
      if (typeof newPassword !== 'string' || typeof presented !== 'number') {
        return jsonResponse({ error: 'Invalid payload' }, 400);
      }

      if (presented !== versionOf(user)) {
        return jsonResponse({ error: 'This reset link has already been used' }, 410);
      }

      user.passwordHash = await hashPassword(newPassword, resolvePbkdf2Iterations(rounds));
      // Retires the link that got here, and every session opened with the old
      // password along with it.
      user.tokenVersion = versionOf(user) + 1;
      await this.ctx.storage.put('user', user);
      return jsonResponse({ user: publicUser(user), tokenVersion: user.tokenVersion });
    }

    if (url.pathname === '/avatar' && request.method === 'GET') {
      const bytes = await this.ctx.storage.get<Uint8Array>(AVATAR_KEY);
      if (!user.avatar || !bytes) {
        return jsonResponse({ error: 'No picture' }, 404);
      }
      return new Response(bytes.slice().buffer as ArrayBuffer, {
        headers: imageResponseHeaders(user.avatar.contentType),
      });
    }

    // Size-checked and sniffed by the Worker; re-checked here because the object
    // is the last place anything is trusted before it is stored.
    if (url.pathname === '/avatar' && request.method === 'POST') {
      const declaredType = request.headers.get('x-image-type') ?? '';
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(declaredType)) {
        return jsonResponse({ error: 'Only JPEG, PNG and WebP pictures can be used' }, 415);
      }

      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > LIMITS.avatarBytes) {
        return jsonResponse({ error: 'That picture is too large' }, 413);
      }

      user.avatar = {
        contentType: declaredType as ImageContentType,
        bytes: bytes.byteLength,
        addedAt: new Date().toISOString(),
      };
      await this.ctx.storage.put(AVATAR_KEY, bytes);
      await this.ctx.storage.put('user', user);
      return jsonResponse({ user: publicUser(user) }, 201);
    }

    if (url.pathname === '/avatar/remove' && request.method === 'POST') {
      delete user.avatar;
      await this.ctx.storage.delete(AVATAR_KEY);
      await this.ctx.storage.put('user', user);
      return jsonResponse({ user: publicUser(user) });
    }

    return jsonResponse({ error: 'Not found' }, 404);
  }
}
