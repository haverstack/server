import { describe, it, expect } from 'vitest';
import { FrameGate } from '../../src/lib/frameGate.js';

/** A write that never settles on its own — stands in for a stalled client. */
function neverSettles(): Promise<void> {
  return new Promise(() => {});
}

/** A deferred write the test controls the resolution of. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('FrameGate', () => {
  it('accepts sends up to the cap without triggering overflow', () => {
    let overflowed = false;
    const gate = new FrameGate(2, () => {
      overflowed = true;
    });

    expect(gate.send(neverSettles)).toBe(true);
    expect(gate.send(neverSettles)).toBe(true);
    expect(overflowed).toBe(false);
  });

  it('reports overflow exactly once a send would exceed the cap', () => {
    let overflowCount = 0;
    const gate = new FrameGate(1, () => {
      overflowCount++;
    });

    expect(gate.send(neverSettles)).toBe(true); // fills the one slot, never settles
    expect(gate.send(neverSettles)).toBe(false); // would be the 2nd in flight — over cap
    expect(overflowCount).toBe(1);
  });

  it('never calls onOverflow more than once, and refuses every send after', () => {
    let overflowCount = 0;
    const gate = new FrameGate(1, () => {
      overflowCount++;
    });

    gate.send(neverSettles);
    gate.send(neverSettles); // triggers overflow
    expect(gate.send(neverSettles)).toBe(false);
    expect(gate.send(neverSettles)).toBe(false);
    expect(overflowCount).toBe(1);
  });

  it('frees a slot once an in-flight send settles, admitting the next one', async () => {
    const gate = new FrameGate(1, () => {
      throw new Error('should not overflow');
    });
    const first = deferred();

    expect(gate.send(() => first.promise)).toBe(true);
    first.resolve();
    // Let the write's .then/.finally microtasks run.
    await Promise.resolve();
    await Promise.resolve();

    let secondSent = false;
    expect(
      gate.send(() => {
        secondSent = true;
        return Promise.resolve();
      }),
    ).toBe(true);
    expect(secondSent).toBe(true);
  });

  it('frees a slot even when the in-flight write rejects', async () => {
    const gate = new FrameGate(1, () => {
      throw new Error('should not overflow');
    });
    const first = deferred();
    const rejecting = first.promise.then(() => {
      throw new Error('write failed');
    });

    expect(gate.send(() => rejecting)).toBe(true);
    first.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(gate.send(() => Promise.resolve())).toBe(true);
  });
});
