import { LIMITS, type ImageContentType } from './domain';

/**
 * What an upload actually is, decided from its first bytes rather than from the
 * `content-type` header it arrived with. A header is a claim by the client; a
 * magic number is a property of the file. Anything not recognised here — an SVG,
 * an HTML document with an image extension, a PDF — has no match and is refused,
 * which is what keeps a scriptable payload from being stored and later served
 * back from our own origin.
 */
const SIGNATURES: { type: ImageContentType; matches: (bytes: Uint8Array) => boolean }[] = [
  {
    type: 'image/jpeg',
    matches: (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  },
  {
    type: 'image/png',
    matches: (bytes) =>
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte),
  },
  {
    type: 'image/webp',
    matches: (bytes) =>
      // "RIFF" ....size.... "WEBP"
      [0x52, 0x49, 0x46, 0x46].every((byte, index) => bytes[index] === byte) &&
      [0x57, 0x45, 0x42, 0x50].every((byte, index) => bytes[index + 8] === byte),
  },
];

export const sniffImageType = (bytes: Uint8Array): ImageContentType | null =>
  bytes.byteLength < 12 ? null : (SIGNATURES.find((signature) => signature.matches(bytes))?.type ?? null);

export type ImageUpload = { ok: true; bytes: Uint8Array; contentType: ImageContentType } | { ok: false; error: string; status: number };

/**
 * Reads an uploaded picture off a request, refusing anything oversized or not
 * recognisably an image. Content-Length is only a hint — a chunked upload has
 * none at all — so the decoded body is measured too.
 */
export const readImageUpload = async (request: Request): Promise<ImageUpload> => {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > LIMITS.quoteImageBytes) {
    return { ok: false, error: 'That picture is too large', status: 413 };
  }

  let buffer: ArrayBuffer;
  try {
    buffer = await request.arrayBuffer();
  } catch {
    return { ok: false, error: 'The picture could not be read', status: 400 };
  }

  if (buffer.byteLength === 0) {
    return { ok: false, error: 'No picture was sent', status: 400 };
  }

  if (buffer.byteLength > LIMITS.quoteImageBytes) {
    return { ok: false, error: 'That picture is too large', status: 413 };
  }

  const bytes = new Uint8Array(buffer);
  const contentType = sniffImageType(bytes);
  if (!contentType) {
    return { ok: false, error: 'Only JPEG, PNG and WebP pictures can be attached', status: 415 };
  }

  return { ok: true, bytes, contentType };
};

/**
 * Headers for serving a stored picture back. The sniffed type is used rather
 * than anything the uploader said, `nosniff` stops the browser second-guessing
 * it, and the policy neutralises the response for anyone who navigates to the
 * URL directly instead of loading it as an image.
 */
export const imageResponseHeaders = (contentType: ImageContentType): Record<string, string> => ({
  'content-type': contentType,
  'content-disposition': 'inline',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox",
  // Private to the group and only readable with a bearer token, so no shared
  // cache should ever hold a copy.
  'cache-control': 'private, no-store',
});
