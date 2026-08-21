import { isValidDid } from '@haverstack/core/did';
import { authOriginFromUrl } from '@haverstack/core/wire';

const DEFAULT_MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024; // 50 MB
const DEFAULT_MAX_CONTENT_BYTES = 1 * 1024 * 1024; // 1 MB
const DEFAULT_QUERY_TIMEOUT_MS = 10_000;
const DEFAULT_QUERY_WORKER_POOL_SIZE = 2;

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export type Config = {
  port: number;
  dbPath: string;
  entityId: string | null;
  ownerName: string | null;
  ownerHandle: string | null;
  timezone: string | undefined;
  ownerToken: string;
  corsOrigins: string;
  baseUrl: string;
  authOrigin: string;
  maxAttachmentBytes: number;
  maxContentBytes: number;
  queryTimeoutMs: number;
  queryWorkerPoolSize: number;
};

export function loadConfig(): Config {
  const dbPath = required('DB_PATH');

  const entityId = process.env['ENTITY_ID'] ?? null;
  if (entityId && !isValidDid(entityId)) {
    throw new Error(
      `ENTITY_ID must be a DID (e.g. "did:key:z6Mk..."), got: "${entityId}". ` +
        'See docs/spec/identity.md for how to generate one.',
    );
  }
  const ownerName = process.env['OWNER_NAME'] ?? null;
  const ownerHandle = process.env['OWNER_HANDLE'] ?? null;
  // No default: an absent timezone stays undefined end to end rather than
  // asserting knowledge the stack was never actually given. See
  // docs/spec/wire-format.md § Discovery.
  const timezone = process.env['TIMEZONE'] ?? undefined;

  const port = parseInt(optional('PORT', '3000'), 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${process.env['PORT']}`);
  }

  const maxAttachmentBytes = parseInt(
    optional('MAX_ATTACHMENT_BYTES', String(DEFAULT_MAX_ATTACHMENT_BYTES)),
    10,
  );
  if (isNaN(maxAttachmentBytes) || maxAttachmentBytes < 1) {
    throw new Error(`Invalid MAX_ATTACHMENT_BYTES: ${process.env['MAX_ATTACHMENT_BYTES']}`);
  }

  const maxContentBytes = parseInt(
    optional('MAX_CONTENT_BYTES', String(DEFAULT_MAX_CONTENT_BYTES)),
    10,
  );
  if (isNaN(maxContentBytes) || maxContentBytes < 1) {
    throw new Error(`Invalid MAX_CONTENT_BYTES: ${process.env['MAX_CONTENT_BYTES']}`);
  }

  // Per docs/spec/wire-format.md § Bounding query cost: the deadline applied
  // to a query dispatched to the query worker pool (see src/lib/queryWorker),
  // past which the request is abandoned with 503 `timeout` rather than
  // blocking on a query node:sqlite has no way to cancel from inside.
  const queryTimeoutMs = parseInt(
    optional('QUERY_TIMEOUT_MS', String(DEFAULT_QUERY_TIMEOUT_MS)),
    10,
  );
  if (isNaN(queryTimeoutMs) || queryTimeoutMs < 1) {
    throw new Error(`Invalid QUERY_TIMEOUT_MS: ${process.env['QUERY_TIMEOUT_MS']}`);
  }

  const queryWorkerPoolSize = parseInt(
    optional('QUERY_WORKER_POOL_SIZE', String(DEFAULT_QUERY_WORKER_POOL_SIZE)),
    10,
  );
  if (isNaN(queryWorkerPoolSize) || queryWorkerPoolSize < 1) {
    throw new Error(`Invalid QUERY_WORKER_POOL_SIZE: ${process.env['QUERY_WORKER_POOL_SIZE']}`);
  }

  // Required, not auto-detected: the DID challenge-response handshake signs
  // a payload scoped to this server's own public origin, and that origin
  // must come from configuration rather than a client-controlled request
  // header (Host, X-Forwarded-Host) — deriving it from a header would let a
  // client choose which origin it signs for, reopening the relay attack the
  // binding exists to prevent. See docs/spec/wire-format.md § Authentication.
  const baseUrl = required('BASE_URL');
  let authOrigin: string;
  try {
    authOrigin = authOriginFromUrl(baseUrl);
  } catch (err) {
    throw new Error(
      `BASE_URL must be an absolute URL with an origin (e.g. "https://stack.example.com"), got: "${baseUrl}". ` +
        (err instanceof Error ? err.message : String(err)),
      { cause: err },
    );
  }

  return {
    port,
    dbPath,
    entityId,
    ownerName,
    ownerHandle,
    timezone,
    ownerToken: required('OWNER_TOKEN'),
    corsOrigins: optional('CORS_ORIGINS', ''),
    baseUrl,
    authOrigin,
    maxAttachmentBytes,
    maxContentBytes,
    queryTimeoutMs,
    queryWorkerPoolSize,
  };
}
