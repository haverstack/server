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

## Types

| Method | Path         | Auth       | Description               |
| ------ | ------------ | ---------- | ------------------------- |
| GET    | `/types`     | None       | List all registered types |
| GET    | `/types/:id` | None       | Get a type by ID          |
| POST   | `/types`     | Owner only | Register a new type       |

## Attachments

| Method | Path                   | Auth       | Description     |
| ------ | ---------------------- | ---------- | --------------- |
| POST   | `/attachments`         | Required   | Store raw file bytes (bytes only — no metadata record created) |
| GET    | `/attachments/:fileId` | Optional   | Download a file |
| DELETE | `/attachments/:fileId` | Owner only | Delete a file   |

## Entity & Tokens

| Method | Path          | Auth       | Description                    |
| ------ | ------------- | ---------- | ------------------------------ |
| GET    | `/entity`     | Required   | Get the owner entity record    |
| PATCH  | `/entity`     | Owner only | Update the owner entity record |
| GET    | `/tokens`     | Owner only | List API tokens                |
| POST   | `/tokens`     | Owner only | Create an API token            |
| DELETE | `/tokens/:id` | Owner only | Revoke an API token            |

## Permissions

Records are private by default (readable only by the stack owner). The `permissions` field controls access:

```json
{ "access": "public" }
{ "access": "entity", "entityId": "...", "read": true, "write": false }
{ "access": "group",  "groupId":  "...", "read": true, "write": true  }
```

Non-owner entities authenticate with tokens issued via `POST /tokens` and are subject to both record-level permissions and create-grant checks on write.
