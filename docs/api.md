# API Reference

All routes are prefixed by the base URL. Requests are authenticated with a `Bearer` token in the `Authorization` header.

## Discovery

| Method | Path                 | Auth | Description                     |
| ------ | -------------------- | ---- | ------------------------------- |
| GET    | `/.well-known/stack` | None | Stack metadata and capabilities |
| GET    | `/health`            | None | Liveness check                  |

`GET /.well-known/stack` returns:

```json
{
  "version": "1.0",
  "entityId": "did:key:z6Mk...",
  "timezone": "America/New_York",
  "capabilities": {
    "fullTextSearch": true,
    "contentFieldQuery": true,
    "nestedContentQuery": true,
    "sortableFields": ["createdAt", "updatedAt", "version"],
    "maxAttachmentBytes": 52428800,
    "maxContentBytes": 1048576
  },
  "auth": { "methods": ["did-challenge"] },
  "changes": { "transports": ["sse"], "resume": true, "records": true }
}
```

`version` is the wire protocol's own `MAJOR.MINOR` version (from `@haverstack/wire-types`' `WIRE_PROTOCOL_VERSION`), not this server's software version — a client refuses to `open()` a server whose major differs from its own; a minor difference is never a refusal in either direction. `timezone` is present only when the stack was configured with one — there is no default. `capabilities.maxAttachmentBytes` and `maxContentBytes` are this server's own enforced ceilings (413 past either), letting a client pre-check and get a typed error instead of burning a round trip. `auth: { methods: ["did-challenge"] }` is always present — this server always implements the DID challenge-response handshake described below.

`changes` is a top-level field, not part of `capabilities` — a client checks it and fails locally at `open()` rather than discovering a missing feed as a 404 partway through a connection. `transports` lists what it speaks (`sse` is the only one this version defines); `resume` is `true` — `GET /changes` mints and honors resume cursors; `records` is `true` because `GET /changes` already honors `?include=record` unconditionally. Both `resume` and `records` false is also a fully conformant response for a server that doesn't implement either — see [Change feed](#change-feed) below.

`capabilities.nestedContentQuery` is `true`, spread through from the underlying sqlite adapter: a `content` filter key may be a dot-separated path (`"profile.email"`), not just a top-level field — see [Content filter keys](#content-filter-keys) below.

## Authentication

| Method | Path              | Auth | Description                               |
| ------ | ----------------- | ---- | ----------------------------------------- |
| POST   | `/auth/challenge` | None | Request a nonce to prove control of a DID |
| POST   | `/auth/token`     | None | Redeem a signed nonce for a bearer token  |

Both endpoints are unauthenticated — they're how a token is earned in the first place. This is the DID challenge-response handshake: a client proves it holds the private key behind a `did:key` DID, and the server issues a bearer token for that DID without any out-of-band secret handoff. `POST /tokens` (owner-only, see [Entity & Tokens](#entity--tokens)) remains as the owner's separate escape hatch for admin-issued and delegated tokens.

```
POST /auth/challenge   { "did": "did:key:z6Mk..." }
                     → { "nonce": "k7Qm2ZxRt9vLbNc4Hy8Wf3", "expiresAt": "2024-06-15T12:05:00.000Z" }

POST /auth/token       { "did": "...", "nonce": "...", "signature": "..." }
                     → { "token": "...", "expiresAt": "...", "principalId": "...", "subjectId": "..." }
```

`signature` is base64url. What gets signed is not the nonce alone but a domain-separated payload built by `buildAuthChallengePayload()` in `@haverstack/core/wire` — `haverstack-auth-v1\n<origin>\n<did>\n<nonce>` — where `<origin>` is this server's own configured public origin (`BASE_URL`), never a request header. Binding the origin into the signed payload is what stops a signature obtained for one server from being redeemed at another. `verifyAuthChallenge()` verifies it server-side; a client uses `signAuthChallenge()` / `didCredentialFromKeypair()` from the same module so both sides build the identical payload.

`POST /auth/token` never delegates: `principalId` and `subjectId` in the response are always equal, since proving key possession proves the principal and says nothing about whom that key may act for. A delegated token is only ever asserted by the owner out of band, via `POST /tokens`' `onBehalfOf`.

A nonce is single-use, bound to the DID it was issued for, and expires per the `expiresAt` `POST /auth/challenge` returns (5 minutes). Redeeming it — successfully or not — spends it; a second redemption of the same nonce always fails. A redemption naming a _different_ DID than the nonce was issued to spends nothing, so a third party who learns a nonce cannot burn it out from under its holder.

Both endpoints require a `did:key`. Other DID methods are well-formed DIDs but are refused with `invalid_did`: verification decodes the Ed25519 public key straight out of the DID, so no other method could produce a signature this server can check.

Handshake-issued tokens carry the label `did-challenge` and a 7-day expiry. The label is what makes them distinguishable in `GET /tokens` from tokens the owner minted deliberately — the two are otherwise identical rows. Expired tokens are reclaimed periodically rather than accumulating.

### Auth errors

Auth failures use their own vocabulary, deliberately outside the `WireErrorCode` taxonomy used elsewhere in this document — no Stack operation has begun yet, so none of these is a `StackError`:

| Code                | Status | Meaning                                               | Retryable |
| ------------------- | ------ | ----------------------------------------------------- | --------- |
| `invalid_did`       | 400    | Not a well-formed `did:key`                           | No        |
| `unknown_nonce`     | 401    | Never issued, already spent, or issued to another DID | Yes       |
| `expired_nonce`     | 401    | Past `expiresAt`                                      | Yes       |
| `invalid_signature` | 401    | Does not verify against the payload                   | No        |

The retryable column is why these carry a `code` at all rather than being bodyless 401s like other auth failures on this server: a stale or unknown nonce means re-run the handshake once from `POST /auth/challenge`; a rejected signature will be rejected identically forever, so a client that retried it would loop. `unknown_nonce` deliberately does not distinguish "never issued" from "already spent" from "issued to a different DID" — the three differ only in what an attacker would learn.

## Records

| Method | Path                               | Auth       | Description                             |
| ------ | ---------------------------------- | ---------- | --------------------------------------- |
| GET    | `/records`                         | Optional   | Query records via URL params            |
| POST   | `/records/query`                   | Optional   | Query records with content filters      |
| POST   | `/records`                         | Required   | Create a record                         |
| GET    | `/records/:id`                     | Optional   | Get a record by ID                      |
| PATCH  | `/records/:id`                     | Required   | Update record content (merge patch)     |
| DELETE | `/records/:id`                     | Required   | Soft-delete (or hard with `?hard=true`) |
| POST   | `/records/:id/undelete`            | Required   | Reverse a soft delete                   |
| GET    | `/records/:id/permissions`         | Optional   | Get permissions                         |
| PUT    | `/records/:id/permissions`         | Required   | Replace permissions                     |
| PUT    | `/records/:id/unlisted`            | Required   | Withhold from enumeration, or relist    |
| GET    | `/records/:id/associations`        | Optional   | List associations                       |
| POST   | `/records/:id/associations`        | Required   | Add an association                      |
| POST   | `/records/:id/associations/delete` | Required   | Remove an association                   |
| GET    | `/records/:id/versions`            | Optional   | List version history                    |
| GET    | `/records/:id/versions/:version`   | Optional   | Get a specific version                  |
| POST   | `/records/:id/restore/:version`    | Required   | Restore a previous version              |
| POST   | `/records/:id/migrate`             | Owner only | Change a record's typeId                |

Version history requires the same access `PATCH`/`DELETE` require — a write-holder, or the owner — not plain read. A read-only requester gets `403`.

`POST /records/:id/migrate` is the only way a record's `typeId` changes after creation, and is owner-acting-alone only — a non-owner gets `403` regardless of any write grant or record-level permission they hold. Body is `{ toTypeId, content }`: `content` is the full post-migration content, computed client-side by the type's owning app; the server validates it against `toTypeId`'s schema before writing and leaves a pre-migration snapshot in version history. Accepts the same `If-Match` header as `PATCH`.

Removing an association is `POST /records/:id/associations/delete`, not a body-bearing `DELETE` — a `DELETE` request body has no defined semantics (RFC 9110 §9.3.5) and is a portability landmine for proxies/gateways that drop or reject it.

A `relationship` association's `target` is a discriminated union naming which identifier space the value belongs to — a Record (in this Stack or another), an identity, or something outside the Stack entirely:

```json
{ "kind": "relationship", "label": "reply-to",      "target": { "scope": "record",   "recordId": "xyz789" } }
{ "kind": "relationship", "label": "author",        "target": { "scope": "entity",   "entityId": "did:key:z6Mk..." } }
{ "kind": "relationship", "label": "syndicated-to", "target": { "scope": "external", "ns": "atproto", "id": "at://..." } }
```

`PUT /records/:id/permissions` returns `204` with no body; the body and (when read back via `GET`) response both use the `{ "permissions": [...] }` envelope. An empty array makes the record private (owner-only).

`POST /records/:id/undelete` reverses a soft delete and returns the record as it now stands (`deletedAt` absent). Idempotent — a second call on an already-active record returns the same result.

`POST /records` returns `200`, not `201` — the response is the created record, same shape as every other write. The body is the full record: `id` is client-minted (12 lowercase Crockford base-32 characters, no reserved `_` prefix — omit it to let the server generate one) and, when supplied, must encode a creation timestamp within the server's clock-skew tolerance; `createdAt`/`updatedAt`/`version` are never accepted from the client — those, like `entityId`/`principalId`, are always server-assigned. A duplicate `id` returns `409` with code `conflict`.

`If-Match: "<version>"` is accepted for optimistic concurrency on every endpoint that bumps a record's version — `PATCH /records/:id`, `DELETE /records/:id`, `POST /records/:id/undelete`, `POST /records/:id/restore/:version`, `POST /records/:id/migrate`, `POST /records/:id/associations`, `POST /records/:id/associations/delete`, `PUT /records/:id/permissions`, and `PUT /records/:id/unlisted`. A mismatch returns `412` with code `version_conflict` and a `versionConflict: { recordId, expectedVersion, actualVersion }` payload; omitting the header keeps last-writer-wins.

### Query parameters

`GET /records` accepts, among others: `typeId`, `parentId`, `appId`, `entityId`, `principalId`, `tag`, `hasAttachment`, `attachmentFileId`, `relatedTo` (+ `relatedToStack`, `relatedToLabel`), `relatedToEntity` (+ `relatedToLabel`), `relatedToNs` (+ `relatedToId`, `relatedToLabel`), `search`, `createdBefore`/`createdAfter`, `updatedBefore`/`updatedAfter`, `includeDeleted`, `includeUnlisted`, `sort`/`direction`, `limit`, `cursor`. `entityId` filters by the record's attributed subject; `principalId` filters by the delegating app, if any (see [Permissions](#permissions) below). `includeUnlisted` is owner-only — see [Unlisted](#unlisted) below. `POST /records/query` accepts the same filters as a JSON body, plus a `content` field-equality filter. Omitting `limit` returns one default-sized page (50 records), never the whole result set — `cursor` is the only end-of-results signal.

Both query endpoints' response envelope is `{ records, cursor, total }`. `total` is always `null` — every response has passed a permission boundary, so an unscoped count would leak how many records exist beyond what the requester may read; clients must not rely on it. An empty `records` array with a non-null `cursor` is a valid response and does not mean the result set is exhausted — a low-visibility requester can see several empty pages before results appear, so `cursor: null` is the only end-of-results signal.

#### Relationship target filter (`relatedTo` family)

A relationship association's target names one of three scopes — a Record, an identity, or something outside the Stack — and the filter parameters mirror that:

| Parameter         | Scope        | Pairs with                                                  |
| ----------------- | ------------ | ----------------------------------------------------------- |
| `relatedTo`       | `record`     | `relatedToStack` (that Record's Stack URL, if not this one) |
| `relatedToEntity` | `entity`     | —                                                           |
| `relatedToNs`     | `external`   | `relatedToId` (omit to match the whole namespace)           |
| `relatedToLabel`  | any, or none | narrows any of the above; valid alone                       |

`relatedTo`, `relatedToEntity`, and `relatedToNs` name different, mutually exclusive scopes — mixing parameters from two of them is `400`. `relatedToStack` is only meaningful alongside `relatedTo`, and `relatedToId` only alongside `relatedToNs`; either appearing without its pair is `400`. Absence and emptiness are not the same thing: omitting `relatedToStack` means the target has no `stackUrl` (i.e. this Stack) and does _not_ match a target that carries one, while an _empty_ `relatedToStack` is `400` rather than being read as "local" or "any". The same holds for `relatedToId`: omit it to match the whole namespace; an empty value is `400`. A bare `relatedToLabel`, with none of the scope parameters, is valid and matches every target under that label. `filter.relatedTo` in the `POST /records/query` body carries the same rule as a `{ label?, target? }` object, `target` being `{ scope: 'record' | 'entity' | 'external', ... }`.

#### Content filter keys

`POST /records/query`'s `filter.content` matches content fields by exact value, keyed by field name. A key may be a dot-separated path (`"profile.email"`) to match a field nested inside an `object`-typed field — this server declares `nestedContentQuery: true` in [Discovery](#discovery), so a multi-segment key is accepted rather than refused with `400`. An array anywhere along the path is matched element-wise.

### Soft delete and tombstones

`DELETE /records/:id` without `?hard=true` leaves a **tombstone**: the record continues to exist and remains reachable by `id`, but its `content` is projected as `{}` and `deletedAt` is set. This applies uniformly everywhere the record is served with content attached — `GET /records/:id`, `GET`/`POST /records/query` with `filter.includeDeleted: true`, and a `deleted`-kind change feed frame with `?include=record` — so a client sees the same emptied shape regardless of which route it came through. `GET /records/:id/versions` and `GET /records/:id/versions/:version` are the deliberate exception: version history is never tombstoned and continues to serve full content.

A soft-deleted record refuses further mutation: `PATCH`, `POST .../associations`, `POST .../associations/delete`, `PUT .../permissions`, `PUT .../unlisted`, `POST .../migrate`, and `POST .../restore/:version` all return `409` with code `conflict` until `POST /records/:id/undelete` reverses the delete. `GET` and version-history reads are unaffected — the refusal applies only to mutation.

## Unlisted

`unlistedAt` is orthogonal to `permissions`: it says nothing about who may read a record, only whether it is enumerable. A record with `unlistedAt` set is still reachable by `GET /records/:id` for anyone who may already read it — unlisted withholds a record from enumeration, never from access.

```
PUT /records/:id/unlisted     body: { "unlisted": boolean }
```

Answers `200` with the updated record — it bumps `version` like any other mutation, and is snapshotted to version history the same way — carrying `unlistedAt` when `true`, absent when `false`. Accepts the same optional `If-Match` precondition as every other mutating endpoint, and returns `409` on a soft-deleted record like the other mutating endpoints above. Gated exactly like `PUT .../permissions`: owner or creator, asked of both identities under delegation.

**`includeUnlisted` is owner-only.** `GET /records`, `POST /records/query`, and `GET /changes` all accept it (excluded by default, like `includeDeleted`), and all three refuse it with `403` for any requester but the owner acting alone — enumeration standing rests on nothing but ownership, so no grant or delegation carries it. On `GET /changes` the refusal happens before the SSE stream opens.

### The feed transitions

`unlist` and `list` are new change-feed ops (`unlist` maps to `kind: "deleted"`, `list` to `kind: "changed"` — see [Change feed](#change-feed)). Only the `unlist` transition needs special-casing; every other row falls out of checking the record's current `unlistedAt` against the subscriber's `includeUnlisted`:

| Transition                   | Emits to a default subscriber? |
| ---------------------------- | :----------------------------: |
| Created unlisted             |               No               |
| Listed → unlisted (`unlist`) |            **Yes**             |
| Any change while unlisted    |               No               |
| Unlisted → listed (`list`)   |            **Yes**             |
| Hard delete while unlisted   |               No               |

## Change feed

| Method | Path       | Auth     | Description                                         |
| ------ | ---------- | -------- | --------------------------------------------------- |
| GET    | `/changes` | Optional | Live stream of record changes (`text/event-stream`) |

`GET /changes` opens a Server-Sent Events connection scoped exactly like `GET /records` — an authenticated requester sees what their session may read, an anonymous one sees only public records — via the same `canRead` predicate `get()`/`query()` answer with. Every connection gets a `ready` frame first, always, before anything else: it's what makes subscribe-then-query gap-free, since a client that awaits it before querying knows every later change reaches it as a frame.

This server mints resume cursors: `ready` carries the current head as `seq`, and every `record` frame carries that same value as its SSE `id:`. A reconnect presenting `Last-Event-ID` (or the equivalent `?since=`) resumes from there — receiving exactly the changes it missed, never one it already has — or gets a `reset` frame naming why it can't: `cursor_expired` for a cursor this server no longer recognizes (its buffer aged out, or was minted for different query params — a cursor is self-describing, so a mismatch is detectable rather than silently resumed against the wrong stream), or `overflow` for a recognized buffer that has already dropped what a full resume would need. A cursor outside the base64url alphabet is refused locally as a `400`, before the connection ever opens, rather than answered with a `reset` — it isn't a value this server could ever have minted, so there's nothing to reconcile by resuming from it.

Resume is per-connection state, not global: each distinct (session, filter) pairing gets its own buffer, retained for a bounded time and depth past the last connection using it — long enough for an ordinary reconnect, not indefinitely. A gap resumption can't close is exactly what `reset` exists for; a client's repair is the same either way — reconcile by querying `GET /records` / `POST /records/query`. A `purged` frame in a replayed backlog is never re-checked against current permissions (there is no record left to check, and the mutation-time decision is the only one that will ever exist); every other replayed frame is.

Query parameters, all optional and composable: `typeId` (repeatable, matched by baseId so a type-version bump never orphans a subscription), `parentId` (`"null"` selects root records, same as `GET /records`), `entityId` (the record's author, not who made the change), `kind` (repeatable: `created`, `changed`, `deleted`, `purged`), `include=record` (attach the record as of the change; ignored for `kind=purged`), `includeUnlisted` (owner-only — see [Unlisted](#unlisted)). Filtering is exact, not advisory — a filtered connection never receives a frame outside its filter, and an unrecognized `kind` or `include` value is a `400`.

Every change (`event: record`) carries `kind`, `op`, `recordId`, `typeId`, `version`, `updatedAt`, and — when known — `actor` (who made the change; never the record's own author, which is what `entityId` filters on). `kind` is the coarse branch a handler can be complete on; `op` names the exact verb (`create`, `update`, `associate`, `dissociate`, `permissions`, `migrate`, `restore`, `delete`, `undelete`, `hard-delete`, `unlist`, `list`) for a consumer that distinguishes, say, a reshare from an edit. A `purged` frame — from a hard delete — carries none of `record`, `parentId`, or the record's own author, whatever the connection asked for: hard delete is the erasure primitive, and a frame naming what was destroyed is deliberately all that survives it.

A record this connection may not read produces no frame at all — not an empty or redacted one — the same reasoning that keeps a scoped query's `total` null: the existence of a change is itself a disclosure.

`: keepalive` comment lines go out on an otherwise-idle connection periodically, same as any SSE comment — a conforming client ignores them. A connection whose bearer token is revoked or expires is closed by the server rather than left delivering on stale authority; a reconnect gets the same `401` every other endpoint already answers with. A connection that falls too far behind (more in-flight frames than it's draining) is also closed rather than queued without bound — a client that can't tell it missed something can't repair it either, so the server disconnects instead of silently dropping a frame.

This server is single-process: `GET /changes` reports only writes made through this same process's `Stack`. A second process pointed at the same underlying storage would see nothing from this endpoint — worth knowing before running more than one instance against one stack.

## Types

| Method | Path         | Auth       | Description               |
| ------ | ------------ | ---------- | ------------------------- |
| GET    | `/types`     | None       | List all registered types |
| GET    | `/types/:id` | None       | Get a type by ID          |
| POST   | `/types`     | Owner only | Register a new type       |

## Attachments

| Method | Path                   | Auth       | Description                                                      |
| ------ | ---------------------- | ---------- | ---------------------------------------------------------------- |
| POST   | `/attachments`         | Required   | Store bytes and create the `_attachment@1` record in one request |
| GET    | `/attachments/:fileId` | Optional   | Download a file                                                  |
| DELETE | `/attachments/:fileId` | Owner only | Delete a file                                                    |
| POST   | `/attachments/gc`      | Owner only | Sweep and delete orphaned attachment bytes                       |

`POST /attachments` takes the raw bytes as the request body, `Content-Type` as the declared `mimeType` (defaults to `application/octet-stream`), an optional `Content-Disposition` header for the filename (RFC 5987 `filename*` form), and an optional `?appId=` query param. It returns the created `_attachment@1` record (`200`) — the same shape as `POST /records` — not a bare `fileId`. Requires a `create` grant on `_attachment@1`; anonymous requests get `401`, an authenticated requester with no grant gets `403`.

`GET /attachments/:fileId` resolves `Content-Type` from three sources, in order: the `?contentType` query param, extension inference from `?filename`, then the fileId's stored metadata (the first-recorded `_attachment@1` record's `mimeType`, by earliest `createdAt`). Whichever candidate wins is checked against a safe-list (`image/*` except `svg+xml`, `video/*`, `audio/*`, `application/pdf`, `text/plain`, `application/octet-stream`); anything else is served as `application/octet-stream` instead, regardless of which source produced it. `Content-Disposition`'s filename resolves similarly: `?filename` if given, else the requester's own `_attachment@1` record (by `entityId`), else the first-recorded record's. `X-Content-Type-Options: nosniff` is set on every response. For a non-owner requester, a missing fileId and one they simply can't access are indistinguishable — both return `403` (`401` if the requester is anonymous) — so a guessed fileId can't be used to probe whether specific bytes exist on the stack.

`POST /attachments/gc` sweeps for attachment bytes unreachable from any record — live or soft-deleted — and deletes both the bytes and their `_attachment@1` metadata. Body is `{ graceMs?, dryRun? }`, both optional: `graceMs` is how recently-uploaded an unreferenced file must be to survive collection (default 24 hours, covering the upload-then-associate window; `0` collects immediately), `dryRun` computes the result without deleting anything. Returns `{ deleted: [fileId...], reclaimedBytes }`. No built-in scheduling — invoke it directly, or drive it from an external cron; `dryRun` makes a probe-first workflow safe.

## Entity & Tokens

| Method | Path          | Auth       | Description                    |
| ------ | ------------- | ---------- | ------------------------------ |
| GET    | `/entity`     | Required   | Get the owner entity record    |
| PATCH  | `/entity`     | Owner only | Update the owner entity record |
| GET    | `/tokens`     | Owner only | List API tokens                |
| POST   | `/tokens`     | Owner only | Create an API token            |
| DELETE | `/tokens/:id` | Owner only | Revoke an API token            |

`POST /tokens` accepts `{ entityId, onBehalfOf?, label?, expiresAt? }`. `entityId` is the token's principal (who authenticates); `onBehalfOf` optionally asserts a delegation — the subject the principal acts for. Both, when given, must be DIDs (`422` otherwise). The response always reports both: `{ id, token, principalId, subjectId, label, createdAt, expiresAt }`. Omitting `onBehalfOf` issues an undelegated token, where `subjectId` equals `principalId`.

## Permissions

Records are private by default (readable only by the stack owner). The `permissions` field controls access:

```json
{ "access": "public" }
{ "access": "entity", "entityId": "...", "read": true, "write": false }
{ "access": "group",  "groupId":  "...", "read": true, "write": true  }
```

Non-owner entities authenticate either via the DID challenge-response handshake above or with tokens issued by the owner via `POST /tokens`, and are subject to both record-level permissions and create-grant checks on write.

A type-level grant names a specific entity (`grant(<did>, ...)`) or no entity at all. **A grant with no grantee is a grant to the public.** It resolves for any authenticated entity, and since `POST /auth/challenge` lets anyone authenticate by generating a keypair, "any authenticated entity" means anyone who can reach the server — there is no vouching step in between. Grant a DID by name unless you genuinely mean everyone. (Note the asymmetry with record-level permissions above, which have a `group` tier between `entity` and `public`; type-level grants have no group tier, so a set of entities is expressed as one named grant each.)

### Principal and subject

A token names two identities: the **principal**, who authenticated (governs authority — grant lookups, `setPermissions`), and the **subject**, who the principal acts for (governs attribution — `record.entityId` on writes, `-own` matching). They're equal unless the token was issued with `onBehalfOf`. A delegated write stamps both: `entityId` is the subject, and `principalId` appears on the record when the two differ. `GET /records` and `POST /records/query` can filter on either via `entityId`/`principalId`. Effective authority under delegation is the intersection of both parties' grants — a delegated app can't act beyond what the subject itself also permits.
