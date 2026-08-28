import { LIMITS } from './domain';

export type Valid<T> = { ok: true; value: T };
export type Invalid = { ok: false; error: string };
export type Validated<T> = Valid<T> | Invalid;

const invalid = (error: string): Invalid => ({ ok: false, error });

/**
 * Trims, then rejects empty strings, over-long strings and control characters
 * (which would otherwise let someone smuggle newlines into a display name).
 */
export const validateText = (
  raw: unknown,
  field: string,
  maxLength: number,
  { minLength = 1 } = {},
): Validated<string> => {
  if (typeof raw !== 'string') {
    return invalid(`${field} must be a string`);
  }

  const value = raw.trim();
  if (value.length < minLength) {
    return invalid(minLength === 1 ? `${field} is required` : `${field} must be at least ${minLength} characters`);
  }

  if (value.length > maxLength) {
    return invalid(`${field} must be at most ${maxLength} characters`);
  }

  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return invalid(`${field} contains unsupported control characters`);
  }

  return { ok: true, value };
};

export const validateEmail = (raw: unknown): Validated<string> => {
  const text = validateText(raw, 'Email', LIMITS.email);
  if (!text.ok) {
    return text;
  }

  const value = text.value.toLowerCase();
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value)) {
    return invalid('Email must be a valid address');
  }

  return { ok: true, value };
};

export const validatePassword = (raw: unknown): Validated<string> => {
  if (typeof raw !== 'string') {
    return invalid('Password must be a string');
  }

  if (raw.length < LIMITS.passwordMin) {
    return invalid(`Password must be at least ${LIMITS.passwordMin} characters`);
  }

  if (raw.length > LIMITS.passwordMax) {
    return invalid(`Password must be at most ${LIMITS.passwordMax} characters`);
  }

  return { ok: true, value: raw };
};

export const validateRevealYear = (raw: unknown, now: Date = new Date()): Validated<number> => {
  const currentYear = now.getUTCFullYear();
  const value = raw === undefined || raw === null ? currentYear : raw;

  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return invalid('Reveal year must be a whole number');
  }

  if (value < currentYear || value > currentYear + 10) {
    return invalid(`Reveal year must be between ${currentYear} and ${currentYear + 10}`);
  }

  return { ok: true, value };
};

export const validateMemberIdList = (raw: unknown, field: string): Validated<string[]> => {
  if (raw === undefined || raw === null) {
    return { ok: true, value: [] };
  }

  if (!Array.isArray(raw)) {
    return invalid(`${field} must be an array`);
  }

  if (raw.length > LIMITS.involvedMembers) {
    return invalid(`${field} must contain at most ${LIMITS.involvedMembers} members`);
  }

  const value: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 64) {
      return invalid(`${field} must contain member ids`);
    }
    if (!value.includes(entry)) {
      value.push(entry);
    }
  }

  return { ok: true, value };
};

/**
 * Reads a JSON body without letting an oversized or non-JSON payload through.
 * Content-Length is only a hint, so the decoded text is measured as well.
 */
export const readJsonBody = async (request: Request): Promise<Validated<Record<string, unknown>>> => {
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > LIMITS.requestBytes) {
    return invalid('Request body is too large');
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return invalid('Request body could not be read');
  }

  if (raw.length > LIMITS.requestBytes) {
    return invalid('Request body is too large');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalid('Request body must be valid JSON');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return invalid('Request body must be a JSON object');
  }

  return { ok: true, value: parsed as Record<string, unknown> };
};
