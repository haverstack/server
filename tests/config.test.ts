import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';

const REQUIRED_ENV = {
  DB_PATH: './stack.db',
  OWNER_TOKEN: 'test-owner-token',
  BASE_URL: 'https://stack.example.com',
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

  it('leaves timezone undefined when TIMEZONE is unset', () => {
    const config = loadConfig();
    expect(config.timezone).toBeUndefined();
  });

  it('reads TIMEZONE when set', () => {
    process.env['TIMEZONE'] = 'America/New_York';
    const config = loadConfig();
    expect(config.timezone).toBe('America/New_York');
  });

  it('defaults maxContentBytes to 1 MB', () => {
    const config = loadConfig();
    expect(config.maxContentBytes).toBe(1 * 1024 * 1024);
  });

  it('reads MAX_CONTENT_BYTES when set', () => {
    process.env['MAX_CONTENT_BYTES'] = '2048';
    const config = loadConfig();
    expect(config.maxContentBytes).toBe(2048);
  });

  it('rejects an invalid MAX_CONTENT_BYTES', () => {
    process.env['MAX_CONTENT_BYTES'] = 'not-a-number';
    expect(() => loadConfig()).toThrow(/Invalid MAX_CONTENT_BYTES/);
  });

  it('refuses to start when BASE_URL is unset', () => {
    delete process.env['BASE_URL'];
    expect(() => loadConfig()).toThrow(/Missing required environment variable: BASE_URL/);
  });

  it('rejects a BASE_URL with no origin to bind a signature to', () => {
    process.env['BASE_URL'] = 'not-a-url';
    expect(() => loadConfig()).toThrow(/BASE_URL must be an absolute URL/);
  });

  it('derives authOrigin from BASE_URL', () => {
    process.env['BASE_URL'] = 'https://stack.example.com/some/path';
    const config = loadConfig();
    expect(config.baseUrl).toBe('https://stack.example.com/some/path');
    expect(config.authOrigin).toBe('https://stack.example.com');
  });

  it('defaults shutdownTimeoutMs to 10s', () => {
    const config = loadConfig();
    expect(config.shutdownTimeoutMs).toBe(10_000);
  });

  it('reads SHUTDOWN_TIMEOUT_MS when set', () => {
    process.env['SHUTDOWN_TIMEOUT_MS'] = '5000';
    const config = loadConfig();
    expect(config.shutdownTimeoutMs).toBe(5000);
  });

  it('rejects an invalid SHUTDOWN_TIMEOUT_MS', () => {
    process.env['SHUTDOWN_TIMEOUT_MS'] = 'not-a-number';
    expect(() => loadConfig()).toThrow(/Invalid SHUTDOWN_TIMEOUT_MS/);
  });

  it('defaults the change-feed buffer bounds', () => {
    const config = loadConfig();
    expect(config.changeBufferDepth).toBe(1000);
    expect(config.changeBufferRetentionMs).toBe(5 * 60 * 1000);
    expect(config.changeBufferLimit).toBe(512);
  });

  it('reads the change-feed buffer bounds when set', () => {
    process.env['CHANGE_BUFFER_DEPTH'] = '50';
    process.env['CHANGE_BUFFER_RETENTION_MS'] = '30000';
    process.env['CHANGE_BUFFER_LIMIT'] = '64';
    const config = loadConfig();
    expect(config.changeBufferDepth).toBe(50);
    expect(config.changeBufferRetentionMs).toBe(30_000);
    expect(config.changeBufferLimit).toBe(64);
  });

  it('rejects invalid change-feed buffer bounds', () => {
    process.env['CHANGE_BUFFER_DEPTH'] = '0';
    expect(() => loadConfig()).toThrow(/Invalid CHANGE_BUFFER_DEPTH/);
    delete process.env['CHANGE_BUFFER_DEPTH'];

    process.env['CHANGE_BUFFER_RETENTION_MS'] = 'not-a-number';
    expect(() => loadConfig()).toThrow(/Invalid CHANGE_BUFFER_RETENTION_MS/);
    delete process.env['CHANGE_BUFFER_RETENTION_MS'];

    process.env['CHANGE_BUFFER_LIMIT'] = '0';
    expect(() => loadConfig()).toThrow(/Invalid CHANGE_BUFFER_LIMIT/);
  });

  it('refuses a change-feed buffer limit past the sanity ceiling', () => {
    process.env['CHANGE_BUFFER_LIMIT'] = '100001';
    expect(() => loadConfig()).toThrow(/Invalid CHANGE_BUFFER_LIMIT.*expected 1-100000/);
  });
});
