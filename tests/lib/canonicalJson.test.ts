import { describe, it, expect } from 'vitest';
import { canonicalJson } from '../../src/lib/canonicalJson.js';

describe('canonicalJson', () => {
  it('serializes key order away, at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: [{ y: 1, x: 2 }], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [{ x: 2, y: 1 }] }, b: 1 }),
    );
  });

  it('keeps array order, which is part of the value', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});
