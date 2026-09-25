import { appInline, privacyInline } from './ui';

/**
 * A CSP hash-source for a block of inline text.
 *
 * Hashes rather than a per-response nonce, for two reasons. A hash names the
 * exact bytes, where a nonce authorises whatever inline block happens to carry
 * it — so if markup is ever injected into this page, a stolen nonce would run
 * and a hash mismatch would not. And a hash is stable, which is what lets the
 * app shell be cached: a nonce would change on every response, and a document
 * that cannot be cached cannot be opened offline.
 */
const hashSource = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`;
};

const SHARED = [
  "default-src 'none'",
  "connect-src 'self'",
  // blob: covers both halves of the picture feature: the local preview before a
  // quote is saved, and the revealed picture, which is fetched with the bearer
  // token and turned into an object URL rather than being addressed by a URL
  // that would have to carry a credential.
  "img-src 'self' data: blob:",
  "manifest-src 'self'",
  // The app registers /sw.js; without this it would fall back to script-src and
  // the service worker would be refused by the page's own policy.
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
];

/**
 * Computed once per isolate. The inputs are compile-time constants, so the
 * answer never changes within a deployment — and changes on every deployment
 * that touches the client, which is what the service worker keys its cache on.
 */
let cached: Promise<{ app: string; privacy: string; version: string }> | null = null;

const build = async () => {
  const [styleHash, scriptHash, privacyStyleHash] = await Promise.all([
    hashSource(appInline.styles),
    hashSource(appInline.script),
    hashSource(privacyInline.styles),
  ]);

  return {
    app: [`script-src ${scriptHash}`, `style-src ${styleHash}`, ...SHARED].join('; '),
    // No scripts at all on the policy page, so none are authorised.
    privacy: [`style-src ${privacyStyleHash}`, ...SHARED].join('; '),
    /**
     * A short fingerprint of the client, used to name the service worker's
     * cache. Deploying a changed client changes this, which changes the text of
     * /sw.js — and a byte-different service worker is the only thing that makes
     * a browser install a new one and drop the old cache. Without it an offline
     * shell would be cached once and never updated again.
     */
    version: `${scriptHash}${styleHash}`.replace(/[^A-Za-z0-9]/g, '').slice(0, 16),
  };
};

export const policies = (): Promise<{ app: string; privacy: string; version: string }> => {
  cached ??= build();
  return cached;
};
