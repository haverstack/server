import { existsSync } from 'node:fs';

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

  return {
    port: parseInt(optional('PORT', '3000'), 10),
    dbPath,
    entityId,
    timezone,
    ownerToken: required('OWNER_TOKEN'),
    corsOrigins: optional('CORS_ORIGINS', '*'),
    baseUrl: process.env['BASE_URL'] ?? null,
    isNewDb,
    maxAttachmentBytes: parseInt(optional('MAX_ATTACHMENT_BYTES', String(50 * 1024 * 1024)), 10),
  };
}
