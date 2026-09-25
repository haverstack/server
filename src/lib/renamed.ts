import { StackBadRequestError } from '@haverstack/core';

/**
 * Wire names core 0.38 renamed, refused rather than ignored. Unknown names
 * are otherwise dropped silently, which turns a stale client's request into
 * a different, wider one: `?hard=true` becomes a soft delete, a token body's
 * `entityId` falls back to minting an owner token, a feed or query filter
 * quietly disappears. A 400 naming the replacement makes the break visible.
 */
export const RENAMED_RECORD_QUERY_PARAMS = {
  entityId: 'createdBySubject',
  principalId: 'createdByPrincipal',
  hasAttachment: 'attachmentLabel',
} as const;
export const RENAMED_CHANGE_PARAMS = { entityId: 'createdBySubject' } as const;
export const RENAMED_JOURNAL_PARAMS = { sinceSeq: 'afterSeq' } as const;
export const RENAMED_DELETE_PARAMS = { hard: 'purge' } as const;
export const RENAMED_TOKEN_FIELDS = { entityId: 'principalId', onBehalfOf: 'subjectId' } as const;

/** Throws if `url` carries any query param named in `renamed`. */
export function rejectRenamedParams(url: URL, renamed: Readonly<Record<string, string>>): void {
  for (const [old, current] of Object.entries(renamed)) {
    if (url.searchParams.has(old)) {
      throw new StackBadRequestError(`Query param "${old}" was renamed to "${current}"`);
    }
  }
}

/** Throws if `body` carries any field named in `renamed`. */
export function rejectRenamedFields(
  body: Record<string, unknown>,
  renamed: Readonly<Record<string, string>>,
): void {
  for (const [old, current] of Object.entries(renamed)) {
    if (Object.hasOwn(body, old)) {
      throw new StackBadRequestError(`Field "${old}" was renamed to "${current}"`);
    }
  }
}
