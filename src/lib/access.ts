import type { StackRecord, StackAdapter } from '@haverstack/core';

export type AccessMode = 'read' | 'write';

/**
 * Check whether an entity has read or write access to a record.
 *
 * - No permissions (absent/empty): owner only.
 * - public: anyone can read; write still requires an explicit grant.
 * - entity: direct entityId match.
 * - group: walk the _group record's relationship associations for membership.
 */
export async function checkAccess(
  record: StackRecord,
  requesterEntityId: string | null,
  ownerEntityId: string | null,
  mode: AccessMode,
  adapter: StackAdapter,
): Promise<boolean> {
  // Owner always has full access.
  if (requesterEntityId && requesterEntityId === ownerEntityId) return true;

  const perms = record.permissions;

  // No permissions = private.
  if (!perms || perms.length === 0) return false;

  for (const p of perms) {
    if (p.access === 'public' && mode === 'read') return true;

    if (p.access === 'entity' && p.entityId === requesterEntityId) {
      if (mode === 'read' && p.read) return true;
      if (mode === 'write' && p.write) return true;
    }

    if (p.access === 'group' && requesterEntityId) {
      const member = await isGroupMember(p.groupId, requesterEntityId, adapter);
      if (member) {
        if (mode === 'read' && p.read) return true;
        if (mode === 'write' && p.write) return true;
      }
    }
  }

  return false;
}

async function isGroupMember(
  groupRecordId: string,
  entityId: string,
  adapter: StackAdapter,
): Promise<boolean> {
  const group = await adapter.getRecord(groupRecordId);
  if (!group) return false;
  return (group.associations ?? []).some(
    (a) =>
      a.kind === 'relationship' &&
      (a.label === 'member' || a.label === 'admin') &&
      a.recordId === entityId,
  );
}
