// A record's version history and its journal are the two reads with no
// ceiling when `limit` is omitted: omitting it reads everything by
// contract, so a page size can't be supplied on the caller's behalf
// without silently truncating exactly the caller reading the whole thing.
// This server bounds a page and says so in `cursor` instead, as the spec
// lets it. See docs/spec/wire-format.md § Versions and § Journal.
export const MAX_HISTORY_PAGE = 500;

/**
 * Reads one page of a history, one row past it to learn whether anything
 * follows, so `cursor` is null exactly when the history is exhausted. A
 * `limit` below 1 is passed through as given: whether it is in range is
 * `Stack`'s to judge.
 */
export async function readHistoryPage<T>(
  limit: number | undefined,
  read: (limit: number) => Promise<T[]>,
  cursorOf: (row: T) => number,
): Promise<{ rows: T[]; cursor: number | null }> {
  const page = Math.min(limit ?? MAX_HISTORY_PAGE, MAX_HISTORY_PAGE);
  if (page < 1) return { rows: await read(page), cursor: null };
  const rows = await read(page + 1);
  if (rows.length <= page) return { rows, cursor: null };
  const kept = rows.slice(0, page);
  return { rows: kept, cursor: cursorOf(kept[kept.length - 1]!) };
}
