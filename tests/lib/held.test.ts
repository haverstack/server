import { describe, it, expect } from 'vitest';
import { Held } from '../../src/lib/held.js';

describe('Held', () => {
  it('holds items until opened, then hands them over in order and the rest as they come', () => {
    const held = new Held<number>();
    const seen: number[] = [];
    held.push(1);
    held.push(2);
    expect(seen).toEqual([]);
    held.open((n) => (seen.push(n), true));
    held.push(3);
    expect(seen).toEqual([1, 2, 3]);
  });

  it('drops the rest of what was held once the consumer reports it is closing', () => {
    const held = new Held<number>();
    const seen: number[] = [];
    for (const n of [1, 2, 3]) held.push(n);
    held.open((n) => (seen.push(n), n < 2));
    expect(seen).toEqual([1, 2]);
  });
});
