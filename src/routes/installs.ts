import { Hono } from 'hono';
import { StackNotFoundError, StackValidationError } from '@haverstack/core';
import type { InstallPlan } from '@haverstack/core';
import { parseInstallBody } from '@haverstack/core/wire';
import { serializeRecord } from '@haverstack/wire-types';
import type { WireInstallResponse } from '@haverstack/wire-types';
import type { AppEnv } from '../types.js';
import { knownParams } from '../middleware/params.js';
import type { StackContext } from '../stack.js';
import { requireAuth, requireOwner } from '../middleware/auth.js';
import { scopeFor } from '../lib/scope.js';
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

  // ScopedStack.answerInstall() answers for the session's own key, which is
  // never named in the body, and refuses a delegated session. Planning
  // writes nothing; this route only queues a pending answer for the owner.
  // See docs/spec/wire-format.md § Installs.
  app.post('/', knownParams(), requireAuth(), async (c) => {
    const auth = c.get('auth')!;
    const manifest = parseInstallBody(await readJson(c));
    const answer = await scopeFor(stack, auth).answerInstall(manifest);
    if (answer.status === 'installed') {
      const pending = installRequests.forKey(auth.principalId);
      if (pending) installRequests.remove(pending.id);
      const body: WireInstallResponse = {
        status: 'installed',
        install: serializeRecord(answer.install),
      };
      return c.json(body, 200);
    }
    installRequests.put(auth.principalId, manifest);
    const body: WireInstallResponse = { status: 'pending' };
    return c.json(body, 202);
  });

  app.get('/requests', knownParams(), requireOwner(stack), (c) => {
    return c.json({ requests: installRequests.list().map(serializeRequest) });
  });

  // Planned on every read rather than stored, since what a manifest would
  // change depends on the stack as it stands now.
  app.get('/requests/:id', knownParams(), requireOwner(stack), async (c) => {
    const entry = requestOrNotFound(c.req.param('id'));
    const plan = await stack.planInstall(entry.manifest, { did: entry.did });
    return c.json({ ...serializeRequest(entry), plan: serializePlan(plan) });
  });

  // Applies the manifest the id names, only while it still plans to the
  // fingerprint the owner's review returned; core refuses it otherwise.
  // See docs/spec/apps.md § Plan, then apply.
  app.post('/requests/:id/approve', knownParams(), requireOwner(stack), async (c) => {
    const entry = requestOrNotFound(c.req.param('id'));
    const { fingerprint } = await readJson<{ fingerprint?: unknown }>(c, ['fingerprint']);
    if (typeof fingerprint !== 'string') {
      throw new StackValidationError([{ path: 'fingerprint', message: 'Must be a string' }]);
    }
    const install = await stack.installApp(entry.manifest, { did: entry.did, fingerprint });
    installRequests.remove(entry.id);
    const body: WireInstallResponse = { status: 'installed', install: serializeRecord(install) };
    return c.json(body);
  });

  app.delete('/requests/:id', knownParams(), requireOwner(stack), (c) => {
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

/**
 * What a plan would change; its manifest and key are already on the request.
 * Every field is named, so nothing reaches the wire unchosen, and the return
 * type covers every InstallPlan field, so a field core adds fails to compile
 * here until someone decides whether the owner's review shows it.
 */
function serializePlan(
  plan: InstallPlan,
): Record<Exclude<keyof InstallPlan, 'manifest' | 'did'>, unknown> {
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
    fingerprint: plan.fingerprint,
  };
}
