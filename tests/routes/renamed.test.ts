import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildTestApp, req, TEST_TOKEN, OTHER_ENTITY_ID, type TestApp } from '../setup.js';

// Names core 0.38 renamed are refused with a 400 naming the replacement,
// never ignored — ignoring them turns a stale client's request into a
// different, wider one. See src/lib/renamed.ts.
describe('renamed wire names', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it.each([
    ['entityId', 'principalId'],
    ['onBehalfOf', 'subjectId'],
  ])('POST /tokens refuses %s rather than minting an owner token', async (old, current) => {
    const { status, data } = await req(t.app, 'POST', '/tokens', {
      token: TEST_TOKEN,
      body: { [old]: OTHER_ENTITY_ID },
    });
    expect(status).toBe(400);
    expect(JSON.stringify(data)).toContain(current);
  });

  it.each([
    ['GET', `/records?entityId=${OTHER_ENTITY_ID}`, 'createdBySubject'],
    ['GET', `/records?principalId=${OTHER_ENTITY_ID}`, 'createdByPrincipal'],
    ['GET', '/records?hasAttachment=photo', 'attachmentLabel'],
    ['GET', '/records/1hk153x00001/journal?sinceSeq=0', 'afterSeq'],
    ['DELETE', '/records/1hk153x00001?hard=true', 'purge'],
    ['GET', `/changes?entityId=${OTHER_ENTITY_ID}`, 'createdBySubject'],
  ] as const)('%s %s is refused, naming %s', async (method, path, current) => {
    const { status, data } = await req(t.app, method, path, { token: TEST_TOKEN });
    expect(status).toBe(400);
    expect(JSON.stringify(data)).toContain(current);
  });
});
