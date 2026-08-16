import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';

const REQUIRED_ENV = {
  DB_PATH: './stack.db',
  OWNER_TOKEN: 'test-owner-token',
};

describe('loadConfig', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, REQUIRED_ENV);
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  it('accepts a well-formed DID as ENTITY_ID', () => {
    process.env['ENTITY_ID'] = 'did:key:z6MkfooBar';
    const config = loadConfig();
    expect(config.entityId).toBe('did:key:z6MkfooBar');
  });

  it('rejects an ENTITY_ID that is not a DID', () => {
    process.env['ENTITY_ID'] = 'not-a-did';
    expect(() => loadConfig()).toThrow(/must be a DID/);
  });

  it('allows ENTITY_ID to be unset', () => {
    const config = loadConfig();
    expect(config.entityId).toBeNull();
  });

  it('reads OWNER_NAME and OWNER_HANDLE when set', () => {
    process.env['OWNER_NAME'] = 'Jane';
    process.env['OWNER_HANDLE'] = '@jane';
    const config = loadConfig();
    expect(config.ownerName).toBe('Jane');
    expect(config.ownerHandle).toBe('@jane');
  });

  it('defaults OWNER_NAME and OWNER_HANDLE to null', () => {
    const config = loadConfig();
    expect(config.ownerName).toBeNull();
    expect(config.ownerHandle).toBeNull();
  });
});
