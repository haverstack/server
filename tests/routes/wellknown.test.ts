import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WIRE_PROTOCOL_VERSION } from '@haverstack/wire-types';
import { buildTestApp, req, TEST_ENTITY_ID, type TestApp } from '../setup.js';

describe('GET /.well-known/stack', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('returns the discovery document', async () => {
    const { status, data } = await req(t.app, 'GET', '/.well-known/stack');
    expect(status).toBe(200);
    const d = data as Record<string, unknown>;
    expect(d.version).toBe(WIRE_PROTOCOL_VERSION);
    expect(d.entityId).toBe(TEST_ENTITY_ID);
    expect(d.timezone).toBe('UTC');
    expect(d.capabilities).toBeDefined();
  });

  it('does not require authentication', async () => {
    const { status } = await req(t.app, 'GET', '/.well-known/stack');
    expect(status).toBe(200);
  });

  it("declares the server's own size ceilings, not the adapter's null", async () => {
    const { data } = await req(t.app, 'GET', '/.well-known/stack');
    const capabilities = (data as { capabilities: { limits: Record<string, unknown> } })
      .capabilities;
    expect(capabilities.limits.attachmentBytes).toBe(50 * 1024 * 1024);
    expect(capabilities.limits.contentBytes).toBe(1 * 1024 * 1024);
  });

  it('advertises path-reach content filtering — spread from the sqlite adapter', async () => {
    const { data } = await req(t.app, 'GET', '/.well-known/stack');
    const capabilities = (data as { capabilities: { filter: Record<string, unknown> } })
      .capabilities;
    expect(capabilities.filter.content).toBe('path');
  });

  it('omits timezone entirely when the stack has none configured', async () => {
    const noTzApp = await buildTestApp({ timezone: undefined });
    try {
      const { data } = await req(noTzApp.app, 'GET', '/.well-known/stack');
      expect('timezone' in (data as Record<string, unknown>)).toBe(false);
    } finally {
      await noTzApp.cleanup();
    }
  });

  it('advertises the DID challenge-response handshake', async () => {
    const { data } = await req(t.app, 'GET', '/.well-known/stack');
    expect((data as { auth?: { methods: string[] } }).auth).toEqual({
      methods: ['did-challenge'],
    });
  });

  it('advertises the change feed', async () => {
    const { data } = await req(t.app, 'GET', '/.well-known/stack');
    expect((data as { changes?: unknown }).changes).toEqual({
      transports: ['sse'],
      // GET /changes mints and honors resume cursors.
      resume: true,
      // GET /changes honors ?include=record unconditionally.
      records: true,
    });
  });
});
