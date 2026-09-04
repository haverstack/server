/**
 * _group-scoped permissions: a permission's groupId resolves only against
 * a real _group Record's roster. Core's rule, pinned at this server's HTTP
 * surface rather than assumed to arrive intact.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SYSTEM_TYPES } from '@haverstack/core';
import { buildTestApp, req, OTHER_ENTITY_ID, type TestApp } from '../setup.js';

const NOTE_TYPE = 'com.example.test/note@1';
const GROUP_TYPE = `${SYSTEM_TYPES.GROUP}@1`;

describe('_group ACL', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
    await t.ctx.stack.defineType(NOTE_TYPE, 'Note', { title: { kind: 'string' } });
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('an entity added to a real _group roster gains group-scoped read access', async () => {
    const group = await t.ctx.stack.create(GROUP_TYPE, { name: 'Test Group' });
    await t.ctx.stack.associate(group.id, {
      kind: 'relationship',
      label: 'member',
      target: { scope: 'entity', entityId: OTHER_ENTITY_ID },
    });
    const record = await t.ctx.stack.create(
      NOTE_TYPE,
      { title: 'group-visible' },
      { permissions: [{ access: 'group', groupId: group.id, read: true, write: false }] },
    );
    const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);
    const { status } = await req(t.app, 'GET', `/records/${record.id}`, { token });
    expect(status).toBe(200);
  });

  it('a non-_group record with matching relationship associations is never treated as a roster', async () => {
    // Same association shape a real group roster uses (kind: relationship,
    // label: member, target: entity) — but on an ordinary Note, not a
    // _group Record. Before the 0.20 fix, any record's relationship
    // associations could serve as an ACL; this pins that it can't.
    const notAGroup = await t.ctx.stack.create(
      NOTE_TYPE,
      { title: 'not a real group' },
      {
        associations: [
          {
            kind: 'relationship',
            label: 'member',
            target: { scope: 'entity', entityId: OTHER_ENTITY_ID },
          },
        ],
      },
    );
    const record = await t.ctx.stack.create(
      NOTE_TYPE,
      { title: 'should stay private' },
      { permissions: [{ access: 'group', groupId: notAGroup.id, read: true, write: false }] },
    );
    const { token } = await t.ctx.adapter.createToken(OTHER_ENTITY_ID);
    const { status } = await req(t.app, 'GET', `/records/${record.id}`, { token });
    // Anti-oracle: unreadable is 404, same as any other record this entity
    // can't reach — never a 403 that would confirm the record exists.
    expect(status).toBe(404);
  });
});
