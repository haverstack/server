# API Reference

All routes are prefixed by the base URL. Requests are authenticated with a `Bearer` token in the `Authorization` header.

## Discovery

| Method | Path                 | Auth | Description                     |
| ------ | -------------------- | ---- | ------------------------------- |
| GET    | `/.well-known/stack` | None | Stack metadata and capabilities |
| GET    | `/health`            | None | Liveness check                  |

## Records

| Method | Path                             | Auth     | Description                             |
| ------ | -------------------------------- | -------- | --------------------------------------- |
| GET    | `/records`                       | Optional | Query records via URL params            |
| POST   | `/records/query`                 | Optional | Query records with content filters      |
| POST   | `/records`                       | Required | Create a record                         |
| GET    | `/records/:id`                   | Optional | Get a record by ID                      |
| PATCH  | `/records/:id`                   | Required | Update record content (merge patch)     |
| DELETE | `/records/:id`                   | Required | Soft-delete (or hard with `?hard=true`) |
| GET    | `/records/:id/permissions`       | Optional | Get permissions                         |
| PUT    | `/records/:id/permissions`       | Required | Replace permissions                     |
| GET    | `/records/:id/associations`      | Optional | List associations                       |
| POST   | `/records/:id/associations`      | Required | Add an association                      |
| DELETE | `/records/:id/associations`      | Required | Remove an association                   |
| GET    | `/records/:id/versions`          | Optional | List version history                    |
| GET    | `/records/:id/versions/:version` | Optional | Get a specific version                  |
| POST   | `/records/:id/restore/:version`  | Required | Restore a previous version              |

Version history requires the same access `PATCH`/`DELETE` require — a write-holder, or the owner — not plain read. A read-only requester gets `403`.

### Query parameters

`GET /records` accepts, among others: `typeId`, `parentId`, `appId`, `entityId`, `principalId`, `tag`, `hasAttachment`, `attachmentFileId`, `relatedTo` (+ `relatedLabel`), `search`, `createdBefore`/`createdAfter`, `updatedBefore`/`updatedAfter`, `includeDeleted`, `sort`/`direction`, `limit`, `cursor`. `entityId` filters by the record's attributed subject; `principalId` filters by the delegating app, if any (see [Permissions](#permissions) below). `POST /records/query` accepts the same filters as a JSON body, plus a `content` field-equality filter.

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

`POST /tokens` accepts `{ entityId, onBehalfOf?, label?, expiresAt? }`. `entityId` is the token's principal (who authenticates); `onBehalfOf` optionally asserts a delegation — the subject the principal acts for. The response always reports both: `{ id, token, principalId, subjectId, label, createdAt, expiresAt }`. Omitting `onBehalfOf` issues an undelegated token, where `subjectId` equals `principalId`.

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
