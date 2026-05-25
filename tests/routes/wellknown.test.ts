import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildTestApp, req, type TestApp } from '../setup.js';

describe('GET /.well-known/stack', () => {
  let t: TestApp;
  beforeEach(async () => { t = await buildTestApp(); });
  afterEach(async () => { await t.cleanup(); });

  it('returns discovery document', async () => {
    const { status, data } = await req(t.app, 'GET', '/.well-known/stack');
    expect(status).toBe(200);
    const d = data as Record<string, unknown>;
    expect(d.version).toBe('1.0');
    expect(d.entityId).toBe('test-entity-id-00000001');
    expect(d.timezone).toBe('UTC');
    expect(d.capabilities).toBeDefined();
  });

  it('does not require authentication', async () => {
    const { status } = await req(t.app, 'GET', '/.well-known/stack');
    expect(status).toBe(200);
  });
});
