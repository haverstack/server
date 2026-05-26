import { existsSync } from 'node:fs';

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export type TokenConfig = {
  token: string;
  entityId: string;
};

function parseTokens(raw: string): TokenConfig[] {
  return raw.split(',').map((pair) => {
    const i = pair.indexOf(':');
    if (i === -1) {
      throw new Error(
        `Invalid AUTH_TOKENS format. Expected comma-separated "token:entityId" pairs, got: "${pair}"`,
      );
    }
    const token = pair.slice(0, i).trim();
    const entityId = pair.slice(i + 1).trim();
    if (!token || !entityId) {
      throw new Error(`Invalid AUTH_TOKENS entry "${pair}": both token and entityId are required`);
    }
    return { token, entityId };
  });
}

export type Config = {
  port: number;
  dbPath: string;
  entityId: string | null;
  timezone: string;
  tokens: TokenConfig[];
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

  const rawTokens = required('AUTH_TOKENS');
  const tokens = parseTokens(rawTokens);

  return {
    port: parseInt(optional('PORT', '3000'), 10),
    dbPath,
    entityId,
    timezone,
    tokens,
    corsOrigins: optional('CORS_ORIGINS', '*'),
    baseUrl: process.env['BASE_URL'] ?? null,
    isNewDb,
    maxAttachmentBytes: parseInt(
      optional('MAX_ATTACHMENT_BYTES', String(50 * 1024 * 1024)),
      10,
    ),
  };
}
