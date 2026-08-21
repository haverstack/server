/**
 * Message shapes exchanged between the main thread and a query worker.
 * Both sides structured-clone these over `postMessage` — no custom
 * serialization needed for the plain-data fields (StackQuery's Date
 * filters and QueryResult's records clone natively), but a thrown
 * StackError needs the same wire encoding used at the HTTP boundary
 * (serializeError/deserializeError from @haverstack/wire-types) since a
 * custom Error subclass doesn't survive structured clone as itself.
 */
import type { StackQuery, QueryResult, TokenSession } from '@haverstack/core';
import type { WireError } from '@haverstack/wire-types';

/** Passed as `workerData` when a query worker is spawned. */
export type QueryWorkerInit = {
  dbPath: string;
  timezone?: string;
};

export type QueryRequest = {
  id: number;
  /** null = anonymous (Stack.asEntity(null)), matching records.ts's scopeFor(). */
  session: TokenSession | null;
  query: StackQuery;
};

export type QueryResponse =
  | { id: number; ok: true; result: QueryResult }
  | {
      id: number;
      ok: false;
      /** Set when the failure is a StackError with a wire mapping; reconstructed via deserializeError(). */
      wire: { status: number; body: WireError } | null;
      /** Always set, for logging — the only signal left when `wire` is null (an unanticipated bug). */
      message: string;
    };
