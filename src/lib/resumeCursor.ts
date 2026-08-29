/**
 * Resume cursor codec (#84). A cursor is opaque and base64url by wire
 * contract (`isValidSeq()` in @haverstack/wire-types), but this server's
 * own cursors are self-describing: `base64url(bufferId + ":" + n)`. That
 * makes a presented cursor's origin checkable — a reconnect naming a
 * buffer this server doesn't hold (a different filter, a restart, a
 * buffer past its retention window) is detectable rather than silently
 * resumed against the wrong stream. See the design writeup on issue #84.
 *
 * Real base64url encoding of the whole string is what satisfies the
 * charset rule automatically — there's no separate escaping step for the
 * ":" delimiter, since it never appears in the encoded output.
 */
import { base64urlEncode, base64urlDecode } from '@haverstack/core/wire';

export type DecodedCursor = {
  bufferId: string;
  n: number;
};

/** Mint a cursor naming one buffer's identity and position. */
export function encodeCursor(bufferId: string, n: number): string {
  return base64urlEncode(new TextEncoder().encode(`${bufferId}:${n}`));
}

/**
 * Decode a presented cursor. Returns null for anything that doesn't parse
 * as `bufferId + ":" + a non-negative integer` — never throws. A
 * charset-valid cursor naming garbage is the same "cannot be honored" case
 * an unrecognized buffer id is: answered with a `reset` frame, not a 400.
 * (A charset-*invalid* cursor is refused before this is ever called — see
 * `src/routes/changes.ts`.)
 */
export function decodeCursor(seq: string): DecodedCursor | null {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(base64urlDecode(seq));
  } catch {
    return null;
  }
  const colonIndex = text.lastIndexOf(':');
  if (colonIndex === -1) return null;
  const bufferId = text.slice(0, colonIndex);
  const nText = text.slice(colonIndex + 1);
  if (!/^\d+$/.test(nText)) return null;
  const n = Number(nText);
  if (!Number.isSafeInteger(n)) return null;
  return { bufferId, n };
}
