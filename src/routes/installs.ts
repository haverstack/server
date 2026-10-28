import { Hono } from 'hono';
import { StackNotFoundError, StackPermissionError, isPlanEmpty } from '@haverstack/core';
import type { InstallPlan } from '@haverstack/core';
import { parseInstallBody } from '@haverstack/core/wire';
import { serializeRecord } from '@haverstack/wire-types';
import type { WireInstallResponse } from '@haverstack/wire-types';
import type { AppEnv } from '../types.js';
import { knownParams } from '../middleware/params.js';
import type { StackContext } from '../stack.js';
import { requireAuth, requireOwner } from '../middleware/auth.js';
import { readJson } from '../lib/json.js';
import type { InstallRequestEntry } from '../lib/installRequestStore.js';

/**
 * The two halves of an app install. POST /installs is the app's, and the
 * wire contract pins it: a key presents its manifest and learns whether
 * it was approved. /installs/requests is the owner's, which the spec
 * leaves to the server: review what a pending request would change, then
 * approve or decline it. Underneath, both are Stack.planInstall(), and
 * approval is Stack.installApp(). See docs/spec/apps.md § Over the wire.
 */
export function installRoutes(ctx: StackContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { stack, installRequests } = ctx;
  const ownerEntityId = stack.ownerEntityId;

  // The key being installed is the session's principal, never named in
  // the body, so no app can ask on behalf of a key it does not hold.
  // Planning writes nothing; only an empty plan is answered as installed.
  // See docs/spec/wire-format.md § Installs.
  app.post('/', knownParams(), requireAuth(), async (c) => {
    const auth = c.get('auth')!;
    const manifest = parseInstallBody(await readJson(c));
    if (auth.principalId !== auth.subjectId) {
      throw new StackPermissionError('An install request must come from the key itself');
    }
    const plan = await stack.planInstall(manifest, { did: auth.principalId });
    if (isPlanEmpty(plan)) {
      installRequests.remove(auth.principalId);
      const body: WireInstallResponse = {
        status: 'installed',
        install: serializeRecord(plan.existing!),
      };
      return c.json(body, 200);
    }
    installRequests.put(auth.principalId, manifest);
    const body: WireInstallResponse = { status: 'pending' };
    return c.json(body, 202);
  });

  app.get('/requests', knownParams(), requireOwner(ownerEntityId), (c) => {
    return c.json({ requests: installRequests.list().map(serializeRequest) });
  });

  // Planned on every read rather than stored, since what a manifest would
  // change depends on the stack as it stands now.
  app.get('/requests/:id', knownParams(), requireOwner(ownerEntityId), async (c) => {
    const entry = requestOrNotFound(c.req.param('id'));
    const plan = await stack.planInstall(entry.manifest, { did: entry.did });
    return c.json({ ...serializeRequest(entry), plan: serializePlan(plan) });
  });

  // Applies the manifest the id names, planned afresh: installApp()
  // applies a plan only while it is still what planning would produce.
  app.post('/requests/:id/approve', knownParams(), requireOwner(ownerEntityId), async (c) => {
    const entry = requestOrNotFound(c.req.param('id'));
    const plan = await stack.planInstall(entry.manifest, { did: entry.did });
    const install = await stack.installApp(plan);
    installRequests.remove(entry.did);
    return c.json(serializeRecord(install));
  });

  app.delete('/requests/:id', knownParams(), requireOwner(ownerEntityId), (c) => {
    installRequests.remove(requestOrNotFound(c.req.param('id')).did);
    return c.body(null, 204);
  });

  function requestOrNotFound(id: string): InstallRequestEntry {
    const entry = installRequests.get(id);
    if (!entry) throw new StackNotFoundError('Install request not found');
    return entry;
  }

  return app;
}

function serializeRequest(entry: InstallRequestEntry) {
  return {
    id: entry.id,
    did: entry.did,
    manifest: entry.manifest,
    requestedAt: entry.requestedAt.toISOString(),
    expiresAt: entry.expiresAt.toISOString(),
  };
}

/** What a plan would change; its manifest and key are already on the request. */
function serializePlan(plan: InstallPlan) {
  return {
    existing: plan.existing ? serializeRecord(plan.existing) : null,
    newFamilies: plan.newFamilies,
    newVersions: plan.newVersions,
    requestsAdded: plan.requestsAdded,
    requestsRemoved: plan.requestsRemoved,
    foreignRequests: plan.foreignRequests,
    typeChanges: plan.typeChanges,
    newKey: plan.newKey,
    linkedKeys: plan.linkedKeys,
  };
}
