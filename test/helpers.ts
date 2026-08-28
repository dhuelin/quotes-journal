import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { expect } from 'vitest';
import type { GroupState } from '../src/domain';

export type TestUser = {
  token: string;
  user: { id: string; email: string; displayName: string };
  ip: string;
};

let sequence = 0;

/**
 * Each caller gets its own client IP so the shared rate-limit buckets in this
 * test run stay independent. Only the rate-limit test reuses one deliberately.
 */
export const uniqueIp = (): string => {
  sequence += 1;
  return `198.51.100.${sequence % 250}:${sequence}`;
};

export const request = async (
  path: string,
  options: { method?: string; body?: unknown; token?: string; ip?: string } = {},
): Promise<{ status: number; body: any }> => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }
  headers['cf-connecting-ip'] = options.ip ?? uniqueIp();

  const response = await SELF.fetch(`https://example.com${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
};

export const registerUser = async (displayName: string): Promise<TestUser> => {
  const ip = uniqueIp();
  sequence += 1;
  const email = `${displayName.toLowerCase().replace(/[^a-z]/g, '')}${sequence}@example.com`;

  const response = await request('/api/auth/register', {
    method: 'POST',
    ip,
    body: { displayName, email, password: 'correct horse battery staple' },
  });

  expect(response.status).toBe(201);
  return { token: response.body.token, user: response.body.user, ip };
};

export const createGroup = async (owner: TestUser, name: string, revealYear?: number) => {
  const response = await request('/api/groups', {
    method: 'POST',
    token: owner.token,
    body: { name, revealYear: revealYear ?? new Date().getUTCFullYear() },
  });

  expect(response.status).toBe(201);
  return response.body.group as {
    id: string;
    name: string;
    revealYear: number;
    locked: boolean;
    you: { memberId: string; role: string };
    members: Array<{ id: string; name: string; isYou: boolean }>;
    progress: { totalQuotes: number; recordedByYou: number };
  };
};

/**
 * Moves a group's reveal date into the past. Creating one this way through the
 * API is deliberately impossible, so the unlocked paths are exercised by editing
 * the stored state directly.
 */
export const unlockGroup = async (groupId: string): Promise<void> => {
  const stub = env.GROUPS.get(env.GROUPS.idFromName(groupId));
  await runInDurableObject(stub, async (_instance, state) => {
    const group = await state.storage.get<GroupState>('group');
    if (!group) {
      throw new Error(`group ${groupId} is not initialised`);
    }
    group.revealYear = 2000;
    await state.storage.put('group', group);
  });
};
