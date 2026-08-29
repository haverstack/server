import { describe, it, expect } from 'vitest';
import { isValidSeq } from '@haverstack/wire-types';
import { encodeCursor, decodeCursor } from '../../src/lib/resumeCursor.js';

describe('resume cursor codec', () => {
  it('round-trips a buffer id and position', () => {
    const seq = encodeCursor('a-buffer-id', 7);
    expect(decodeCursor(seq)).toEqual({ bufferId: 'a-buffer-id', n: 7 });
  });

  it('mints only base64url-charset cursors, whatever the buffer id contains', () => {
    const seq = encodeCursor('weird:id/with+chars=', 0);
    expect(isValidSeq(seq)).toBe(true);
  });

  it('distinguishes buffer ids and positions that would collide as plain strings', () => {
    // Without a delimiter distinct from digits, "buf1" + n=23 could be
    // confused with "buf12" + n=3 — real base64url encoding of the whole
    // "bufferId:n" string is what keeps them apart.
    const a = encodeCursor('buf1', 23);
    const b = encodeCursor('buf12', 3);
    expect(a).not.toBe(b);
    expect(decodeCursor(a)).toEqual({ bufferId: 'buf1', n: 23 });
    expect(decodeCursor(b)).toEqual({ bufferId: 'buf12', n: 3 });
  });

  it('returns null for a charset-valid cursor naming garbage', () => {
    // base64url of "not-a-cursor-at-all", which has no bufferId:n shape.
    expect(decodeCursor('bm90LWEtY3Vyc29yLWF0LWFsbA')).toBeNull();
  });

  it('returns null for a cursor whose position is not a plain non-negative integer', () => {
    // Directly construct "buf:-1" and "buf:1.5" — encodeCursor itself
    // never produces these, but decode must still refuse them rather than
    // parsing a negative or fractional position.
    const negative = Buffer.from('buf:-1').toString('base64url');
    const fractional = Buffer.from('buf:1.5').toString('base64url');
    expect(decodeCursor(negative)).toBeNull();
    expect(decodeCursor(fractional)).toBeNull();
  });

  it('returns null for an empty or non-base64url string', () => {
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor('not base64url!!')).toBeNull();
  });
});
