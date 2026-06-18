# Haverstack Server

Reference HTTP server implementation for [Haverstack](https://github.com/haverstack/core).

Exposes a Haverstack stack over a REST API so apps can read and write records remotely. Uses SQLite for storage via `@haverstack/adapter-sqlite`.

> **Status:** Early development. APIs are unstable.

---

## Quick start

```sh
cp .env.example .env
# Edit .env — set OWNER_TOKEN and ENTITY_ID at minimum
pnpm install
pnpm dev
```

The server listens on `PORT` (default `3000`). On first run it initializes a new SQLite database at `DB_PATH`.

---

## Configuration

All configuration is via environment variables. See `.env.example` for the full list.

| Variable               | Required  | Default            | Description                                              |
| ---------------------- | --------- | ------------------ | -------------------------------------------------------- |
| `OWNER_TOKEN`          | Yes       | —                  | Bearer token for the stack owner. Treat like a password. |
| `ENTITY_ID`            | First run | —                  | Owner entity ID. Only needed when initializing a new DB. |
| `DB_PATH`              | No        | `./stack.db`       | Path to the SQLite database file.                        |
| `PORT`                 | No        | `3000`             | Port to listen on.                                       |
| `TIMEZONE`             | No        | `UTC`              | IANA timezone. Only used on first run.                   |
| `CORS_ORIGINS`         | No        | `*`                | Allowed origins, comma-separated or `*`.                 |
| `BASE_URL`             | No        | auto-detected      | Canonical base URL of this server.                       |
| `MAX_ATTACHMENT_BYTES` | No        | `52428800` (50 MB) | Maximum attachment upload size.                          |

---

## API

All routes are prefixed by the base URL. Requests are authenticated with a `Bearer` token in the `Authorization` header.

### Discovery

| Method | Path                 | Auth | Description                     |
| ------ | -------------------- | ---- | ------------------------------- |
| GET    | `/.well-known/stack` | None | Stack metadata and capabilities |
| GET    | `/health`            | None | Liveness check                  |

### Records

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

### Types

| Method | Path         | Auth       | Description               |
| ------ | ------------ | ---------- | ------------------------- |
| GET    | `/types`     | None       | List all registered types |
| GET    | `/types/:id` | None       | Get a type by ID          |
| POST   | `/types`     | Owner only | Register a new type       |

### Attachments

| Method | Path                   | Auth       | Description     |
| ------ | ---------------------- | ---------- | --------------- |
| POST   | `/attachments`         | Required   | Upload a file   |
| GET    | `/attachments/:fileId` | Optional   | Download a file |
| DELETE | `/attachments/:fileId` | Owner only | Delete a file   |

### Entity & Tokens

| Method | Path          | Auth       | Description                    |
| ------ | ------------- | ---------- | ------------------------------ |
| GET    | `/entity`     | Required   | Get the owner entity record    |
| PATCH  | `/entity`     | Owner only | Update the owner entity record |
| GET    | `/tokens`     | Owner only | List API tokens                |
| POST   | `/tokens`     | Owner only | Create an API token            |
| DELETE | `/tokens/:id` | Owner only | Revoke an API token            |

---

## Permissions

Records are private by default (readable only by the stack owner). The `permissions` field controls access:

```json
{ "access": "public" }
{ "access": "entity", "entityId": "...", "read": true, "write": false }
{ "access": "group",  "groupId":  "...", "read": true, "write": true  }
```

Non-owner entities authenticate with tokens issued via `POST /tokens` and are subject to both record-level permissions and create-grant checks on write.

---

## Development

```sh
pnpm install
pnpm dev              # Start with live reload
pnpm test             # Run tests
pnpm typecheck        # Type check
pnpm lint             # Lint
pnpm format:check     # Check formatting
```

---

## Related

- [`haverstack/core`](https://github.com/haverstack/core) — core library, types, adapters, and spec

---

## License

[CC0 1.0 Universal](./LICENSE) — public domain. No rights reserved.
