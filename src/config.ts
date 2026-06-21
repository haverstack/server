import { existsSync } from 'node:fs';

const DEFAULT_MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024; // 50 MB

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
  timezone: string;
  ownerToken: string;
  corsOrigins: string;
  baseUrl: string | null;
  isNewDb: boolean;
  maxAttachmentBytes: number;
};

export function loadConfig(): Config {
  const dbPath = required('DB_PATH');
  const isNewDb = !existsSync(dbPath);

  const entityId = process.env['ENTITY_ID'] ?? null;
  const timezone = optional('TIMEZONE', 'UTC');

  if (isNewDb && !entityId) {
    throw new Error(
      'ENTITY_ID is required when initializing a new database (DB_PATH does not exist yet)',
    );
  }

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

  return {
    port,
    dbPath,
    entityId,
    timezone,
    ownerToken: required('OWNER_TOKEN'),
    corsOrigins: optional('CORS_ORIGINS', ''),
    baseUrl: process.env['BASE_URL'] ?? null,
    isNewDb,
    maxAttachmentBytes,
  };
}
