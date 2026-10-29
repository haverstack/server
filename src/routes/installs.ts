import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { StackNotFoundError, isPlanEmpty } from '@haverstack/core';
import type { InstallPlan } from '@haverstack/core';
import { parseInstallBody } from '@haverstack/core/wire';
import { serializeRecord } from '@haverstack/wire-types';
import type { WireInstallResponse } from '@haverstack/wire-types';
import type { AppEnv } from '../types.js';
import { knownParams } from '../middleware/params.js';
import type { StackContext } from '../stack.js';
import { requireActingAlone, requireOwner } from '../middleware/auth.js';
import { readJson } from '../lib/json.js';
import { canonicalJson } from '../lib/canonicalJson.js';
import { ifMatchTag } from '../lib/ifMatch.js';
import { wireError } from '../wireError.js';
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
  app.post('/', knownParams(), requireActingAlone(), async (c) => {
    const auth = c.get('auth')!;
    const manifest = parseInstallBody(await readJson(c));
    const plan = await stack.planInstall(manifest, { did: auth.principalId });
    if (isPlanEmpty(plan)) {
      const pending = installRequests.forKey(auth.principalId);
      if (pending) installRequests.remove(pending.id);
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
  // change depends on the stack as it stands now. The ETag names this plan,
  // so an approval can be fenced to exactly what the owner reviewed.
  app.get('/requests/:id', knownParams(), requireOwner(ownerEntityId), async (c) => {
    const entry = requestOrNotFound(c.req.param('id'));
    const plan = serializePlan(await stack.planInstall(entry.manifest, { did: entry.did }));
    c.header('ETag', `"${planTag(plan)}"`);
    return c.json({ ...serializeRequest(entry), plan });
  });

  // Applies the manifest the id names, planned afresh. An If-Match carrying
  // the review's ETag refuses the approval with 412 when that plan is no
  // longer what applying it would do, as every write here checks If-Match.
  app.post('/requests/:id/approve', knownParams(), requireOwner(ownerEntityId), async (c) => {
    const reviewed = ifMatchTag(c);
    const entry = requestOrNotFound(c.req.param('id'));
    const plan = await stack.planInstall(entry.manifest, { did: entry.did });
    if (reviewed !== undefined && reviewed !== planTag(serializePlan(plan))) {
      return wireError(
        c,
        412,
        'precondition_failed',
        'The install plan changed since it was reviewed',
      );
    }
    const install = await stack.installApp(plan);
    installRequests.remove(entry.id);
    return c.json(serializeRecord(install));
  });

  app.delete('/requests/:id', knownParams(), requireOwner(ownerEntityId), (c) => {
    installRequests.remove(requestOrNotFound(c.req.param('id')).id);
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
  const { manifest, did, existing, ...changes } = plan;
  return { ...changes, existing: existing ? serializeRecord(existing) : null };
}

/** Names a reviewed plan: equal exactly when the two plans serialize alike. */
function planTag(plan: ReturnType<typeof serializePlan>): string {
  return createHash('sha256').update(canonicalJson(plan)).digest('hex');
}
