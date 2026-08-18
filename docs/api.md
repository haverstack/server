# API Reference

All routes are prefixed by the base URL. Requests are authenticated with a `Bearer` token in the `Authorization` header.

## Discovery

| Method | Path                 | Auth | Description                     |
| ------ | -------------------- | ---- | ------------------------------- |
| GET    | `/.well-known/stack` | None | Stack metadata and capabilities |
| GET    | `/health`            | None | Liveness check                  |

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

`PUT /records/:id/permissions` returns `204` with no body; the body and (when read back via `GET`) response both use the `{ "permissions": [...] }` envelope. An empty array makes the record private (owner-only).

`POST /records/:id/undelete` reverses a soft delete and returns the record as it now stands (`deletedAt` absent). Idempotent — a second call on an already-active record returns the same result.

`POST /records` returns `200`, not `201` — the response is the created record, same shape as every other write. The body is the full record: `id` is client-minted (12 lowercase Crockford base-32 characters, no reserved `_` prefix — omit it to let the server generate one) and, when supplied, must encode a creation timestamp within the server's clock-skew tolerance; `createdAt`/`updatedAt`/`version` are never accepted from the client — those, like `entityId`/`principalId`, are always server-assigned. A duplicate `id` returns `409` with code `conflict`.

`PATCH /records/:id` accepts an `If-Match: "<version>"` header for optimistic concurrency; a mismatch returns `412` with code `version_conflict` and a `versionConflict: { recordId, expectedVersion, actualVersion }` payload. `POST /records/:id/undelete` accepts the same header.

### Query parameters

`GET /records` accepts, among others: `typeId`, `parentId`, `appId`, `entityId`, `principalId`, `tag`, `hasAttachment`, `attachmentFileId`, `relatedTo` (+ `relatedLabel`), `search`, `createdBefore`/`createdAfter`, `updatedBefore`/`updatedAfter`, `includeDeleted`, `sort`/`direction`, `limit`, `cursor`. `entityId` filters by the record's attributed subject; `principalId` filters by the delegating app, if any (see [Permissions](#permissions) below). `POST /records/query` accepts the same filters as a JSON body, plus a `content` field-equality filter. Omitting `limit` returns one default-sized page (50 records), never the whole result set — `cursor` is the only end-of-results signal.

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

`POST /attachments` takes the raw bytes as the request body, `Content-Type` as the declared `mimeType` (defaults to `application/octet-stream`), an optional `Content-Disposition` header for the filename (RFC 5987 `filename*` form), and an optional `?appId=` query param. It returns the created `_attachment@1` record (`200`) — the same shape as `POST /records` — not a bare `fileId`. Requires a `create` grant on `_attachment@1`; anonymous requests get `401`, an authenticated requester with no grant gets `403`.

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

Non-owner entities authenticate with tokens issued via `POST /tokens` and are subject to both record-level permissions and create-grant checks on write.

### Principal and subject

A token names two identities: the **principal**, who authenticated (governs authority — grant lookups, `setPermissions`), and the **subject**, who the principal acts for (governs attribution — `record.entityId` on writes, `-own` matching). They're equal unless the token was issued with `onBehalfOf`. A delegated write stamps both: `entityId` is the subject, and `principalId` appears on the record when the two differ. `GET /records` and `POST /records/query` can filter on either via `entityId`/`principalId`. Effective authority under delegation is the intersection of both parties' grants — a delegated app can't act beyond what the subject itself also permits.
