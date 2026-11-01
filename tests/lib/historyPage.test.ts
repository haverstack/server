import { describe, it, expect } from 'vitest';
import { MAX_HISTORY_PAGE, readHistoryPage } from '../../src/lib/historyPage.js';

/** A history of `n` rows numbered from 1, read the way a Stack read takes a limit. */
function history(n: number) {
  const rows = Array.from({ length: n }, (_, i) => i + 1);
  const limits: number[] = [];
  const read = async (limit: number) => {
    limits.push(limit);
    return rows.slice(0, limit);
  };
  return { read, limits };
}

const page = (n: number, limit: number | undefined) => {
  const h = history(n);
  return readHistoryPage(limit, h.read, (row) => row).then((r) => ({ ...r, limits: h.limits }));
};

describe('readHistoryPage', () => {
  it('bounds a page no limit was given for, and says so in cursor', async () => {
    const { rows, cursor } = await page(MAX_HISTORY_PAGE + 1, undefined);
    expect(rows).toHaveLength(MAX_HISTORY_PAGE);
    expect(cursor).toBe(MAX_HISTORY_PAGE);
  });

  it('caps a limit above the ceiling', async () => {
    const { rows, limits } = await page(MAX_HISTORY_PAGE * 2, MAX_HISTORY_PAGE * 2);
    expect(rows).toHaveLength(MAX_HISTORY_PAGE);
    expect(limits).toEqual([MAX_HISTORY_PAGE + 1]);
  });

  it('answers a null cursor for a page exactly as long as what is left', async () => {
    expect(await page(2, 2)).toMatchObject({ rows: [1, 2], cursor: null });
  });

  it('answers the last row of a full page as the cursor when more follow', async () => {
    expect(await page(3, 2)).toMatchObject({ rows: [1, 2], cursor: 2 });
  });

  it('passes a limit below 1 through, for Stack to judge', async () => {
    expect((await page(3, 0)).limits).toEqual([0]);
  });
});
