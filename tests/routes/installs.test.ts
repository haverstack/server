import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AppManifest } from '@haverstack/core';
import { buildTestApp, req, TEST_TOKEN, OTHER_ENTITY_ID, type TestApp } from '../setup.js';

const APP_KEY = 'did:key:z6Mkfsz9oK6i2355mvEwtDYdAmqCN6kmQETThJtARfj9iGum';

const MANIFEST: AppManifest = {
  appId: 'com.example.notes',
  name: 'Notes',
  version: '1.0.0',
  types: [{ id: 'com.example.notes/note@1', name: 'Note', schema: { text: { kind: 'text' } } }],
  requests: [{ baseId: 'com.example.notes/note', actions: ['create', 'read-any'] }],
};

type RequestSummary = { id: string; did: string; manifest: AppManifest };

describe('installs', () => {
  let t: TestApp;
  let appToken: string;
  beforeEach(async () => {
    t = await buildTestApp();
    ({ token: appToken } = await t.ctx.adapter.createToken({ subjectId: APP_KEY }));
  });
  afterEach(async () => {
    await t.cleanup();
  });

  function ask(manifest: AppManifest = MANIFEST) {
    return req(t.app, 'POST', '/installs', { token: appToken, body: { manifest } });
  }

  async function pending(): Promise<RequestSummary[]> {
    const { data } = await req(t.app, 'GET', '/installs/requests', { token: TEST_TOKEN });
    return (data as { requests: RequestSummary[] }).requests;
  }

  it('queues one request per key, keeping its id while the manifest is unchanged', async () => {
    await ask();
    await ask();
    const [first, ...rest] = await pending();
    expect(rest).toEqual([]);
    expect(first).toMatchObject({ did: APP_KEY, manifest: MANIFEST });

    // An upgrade replaces the request, under a new id: the one the owner
    // reviewed no longer names what the key is asking for.
    await ask({ ...MANIFEST, version: '1.1.0' });
    const [upgraded, ...none] = await pending();
    expect(none).toEqual([]);
    expect(upgraded!.id).not.toBe(first!.id);
    expect(upgraded!.manifest.version).toBe('1.1.0');
  });

  it('shows the owner what approving would change', async () => {
    await ask();
    const [request] = await pending();
    const { status, data } = await req(t.app, 'GET', `/installs/requests/${request!.id}`, {
      token: TEST_TOKEN,
    });
    expect(status).toBe(200);
    const { plan } = data as { plan: Record<string, unknown> };
    expect(plan.existing).toBeNull();
    expect(plan.newFamilies).toEqual(['com.example.notes/note']);
    expect(plan.newKey).toBe(true);
  });

  it('installs on approval, after which the key is answered as installed', async () => {
    await ask();
    const [request] = await pending();
    const approved = await req(t.app, 'POST', `/installs/requests/${request!.id}/approve`, {
      token: TEST_TOKEN,
    });
    expect(approved.status).toBe(200);
    expect((approved.data as { typeId: string }).typeId).toBe('_install@1');
    expect(await pending()).toEqual([]);

    const { status, data } = await ask();
    expect(status).toBe(200);
    expect((data as { status: string }).status).toBe('installed');
    // The grant the manifest asked for now holds.
    const created = await req(t.app, 'POST', '/records', {
      token: appToken,
      body: { typeId: 'com.example.notes/note@1', content: { text: 'hi' } },
    });
    expect(created.status).toBe(200);
  });

  it('drops a declined request without writing anything', async () => {
    await ask();
    const [request] = await pending();
    const declined = await req(t.app, 'DELETE', `/installs/requests/${request!.id}`, {
      token: TEST_TOKEN,
    });
    expect(declined.status).toBe(204);
    expect(await pending()).toEqual([]);
    expect(await t.ctx.stack.getType('com.example.notes/note@1')).toBeNull();
  });

  it('answers 404 for a request id it does not hold', async () => {
    for (const [method, path] of [
      ['GET', '/installs/requests/nope'],
      ['POST', '/installs/requests/nope/approve'],
      ['DELETE', '/installs/requests/nope'],
    ] as const) {
      const { status } = await req(t.app, method, path, { token: TEST_TOKEN });
      expect(status).toBe(404);
    }
  });

  it('serves the review surface to the owner acting alone', async () => {
    await ask();
    const [request] = await pending();
    const { token } = await t.ctx.adapter.createToken({ subjectId: OTHER_ENTITY_ID });
    for (const [method, path] of [
      ['GET', '/installs/requests'],
      ['GET', `/installs/requests/${request!.id}`],
      ['POST', `/installs/requests/${request!.id}/approve`],
      ['DELETE', `/installs/requests/${request!.id}`],
    ] as const) {
      expect((await req(t.app, method, path, { token })).status).toBe(403);
      expect((await req(t.app, method, path)).status).toBe(401);
    }
  });

  it('refuses an anonymous request and an unknown body key', async () => {
    const anonymous = await req(t.app, 'POST', '/installs', { body: { manifest: MANIFEST } });
    expect(anonymous.status).toBe(401);
    const extra = await req(t.app, 'POST', '/installs', {
      token: appToken,
      body: { manifest: MANIFEST, did: OTHER_ENTITY_ID },
    });
    expect(extra.status).toBe(400);
  });
});
