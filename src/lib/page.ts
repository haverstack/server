// A record's version history, its journal and the blob listing are the
// reads with no ceiling when `limit` is omitted: omitting it reads
// everything by contract, so a page size can't be supplied on the caller's
// behalf without silently truncating exactly the caller reading the whole
// thing. This server bounds a page and says so in `cursor` instead, as the
// spec lets it. See docs/spec/wire-format.md § Versions, § Journal
// and § Blobs.
export const MAX_PAGE = 500;

/**
 * Reads one page, one row past it to learn whether anything follows, so
 * `cursor` is null exactly when the read is exhausted. A `limit` below 1 is
 * passed through as given: whether it is in range is `Stack`'s to judge.
 */
export async function readPage<T, C>(
  limit: number | undefined,
  read: (limit: number) => Promise<T[]>,
  cursorOf: (row: T) => C,
): Promise<{ rows: T[]; cursor: C | null }> {
  const page = Math.min(limit ?? MAX_PAGE, MAX_PAGE);
  if (page < 1) return { rows: await read(page), cursor: null };
  const rows = await read(page + 1);
  if (rows.length <= page) return { rows, cursor: null };
  const kept = rows.slice(0, page);
  return { rows: kept, cursor: cursorOf(kept[kept.length - 1]!) };
}
