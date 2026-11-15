/**
 * `fetch(..., { keepalive: true })` lets a request outlive the page, but browsers cap
 * that body at 64 KiB and drop anything larger without surfacing an error. Keep a little
 * headroom and count UTF-8 bytes (notes may hold CJK text or base64 image data).
 */
export const KEEPALIVE_MAX_BYTES = 60 * 1024;

export function keepaliveFits(body: string): boolean {
  return new TextEncoder().encode(body).length <= KEEPALIVE_MAX_BYTES;
}
