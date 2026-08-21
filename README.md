# Haverstack Server

Reference HTTP server implementation for [Haverstack](https://github.com/haverstack/core).

Exposes a Haverstack stack over a REST API so apps can read and write records remotely. Uses SQLite for storage via `@haverstack/adapter-local`.

> **Status:** Early development. APIs are unstable.

---

## Quick start

```sh
cp .env.example .env
# Edit .env — set OWNER_TOKEN, ENTITY_ID, and BASE_URL at minimum
pnpm install
pnpm dev
```

The server listens on `PORT` (default `3000`). On first run it initializes a new SQLite database at `DB_PATH`.

---

## Docker

```sh
docker run -d \
  -e OWNER_TOKEN=<secret> \
  -e ENTITY_ID=<your-entity-id> \
  -e BASE_URL=https://stack.example.com \
  -p 3000:3000 \
  -v haverstack-data:/app/data \
  ghcr.io/haverstack/server:latest
```

`/app/data` holds the SQLite database, its WAL sidecar files (`stack.db-wal`, `stack.db-shm`), a storage-ownership lock file (`stack.db.lock`), and attachments — mount a volume there for persistence. Set `ENTITY_ID` only on first run; it is ignored once the database exists, though a value that no longer matches the stack's stored owner logs a startup warning rather than failing silently.

Only one server process may hold a given `DB_PATH` at a time: a second process against the same path fails at startup with a clear error rather than silently sharing (or corrupting) the database. This is enforced by the storage adapter, independent of any reverse proxy or orchestrator setting — see [Deployment: single-writer topology](./docs/deployment.md#single-writer-topology).

---

## Configuration

All configuration is via environment variables. See `.env.example` for the full list.

| Variable                 | Required  | Default                                      | Description                                                                                                                                                                                                                                 |
| ------------------------ | --------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OWNER_TOKEN`            | Yes       | —                                            | Break-glass bearer token for the stack owner. Treat like a password.                                                                                                                                                                        |
| `ENTITY_ID`              | First run | —                                            | Owner entity ID — must be a DID (e.g. `did:key:z6Mk...`). Only needed when initializing a new DB.                                                                                                                                           |
| `OWNER_NAME`             | No        | —                                            | Owner's display name. When set, ensures the owner's `_entity` profile record exists.                                                                                                                                                        |
| `OWNER_HANDLE`           | No        | —                                            | Owner's handle. Only used alongside `OWNER_NAME`.                                                                                                                                                                                           |
| `DB_PATH`                | No        | `/app/data/stack.db` (Docker) / `./stack.db` | Path to the SQLite database file.                                                                                                                                                                                                           |
| `PORT`                   | No        | `3000`                                       | Port to listen on.                                                                                                                                                                                                                          |
| `TIMEZONE`               | No        | — (none)                                     | IANA timezone. Only used on first run; omitted from discovery when unset.                                                                                                                                                                   |
| `CORS_ORIGINS`           | No        | `` (none)                                    | Allowed origins, comma-separated or `*`.                                                                                                                                                                                                    |
| `BASE_URL`               | Yes       | —                                            | Canonical public base URL of this server. Signed/verified against by the DID challenge-response handshake — see [API reference](./docs/api.md#authentication).                                                                              |
| `MAX_ATTACHMENT_BYTES`   | No        | `52428800` (50 MB)                           | Maximum attachment upload size.                                                                                                                                                                                                             |
| `MAX_CONTENT_BYTES`      | No        | `1048576` (1 MB)                             | Maximum JSON request body size (records, patches, etc). See [Deployment: request body size limits](./docs/deployment.md#request-body-size-limits).                                                                                          |
| `QUERY_TIMEOUT_MS`       | No        | `10000` (10s)                                | Execution deadline for a `GET /records` or `POST /records/query` search, timed from when it reaches a worker. Exceeding it answers `503` (code `timeout`). See [Deployment: bounding query cost](./docs/deployment.md#bounding-query-cost). |
| `QUERY_WORKER_POOL_SIZE` | No        | `2`                                          | Number of worker threads a slow search can run on without blocking other requests (max 32). See [Deployment: bounding query cost](./docs/deployment.md#bounding-query-cost).                                                                |
| `QUERY_QUEUE_LIMIT`      | No        | `64`                                         | Searches allowed to queue for a worker before the server sheds load with `503` (code `timeout`). See [Deployment: bounding query cost](./docs/deployment.md#bounding-query-cost).                                                           |
| `SEED_COMMONS_TYPES`     | No        | `false`                                      | Registers the [Schema Commons](https://github.com/haverstack/core/blob/main/docs/commons/README.md) types from `@haverstack/commons` on startup. See [Deployment: Schema Commons seeding](./docs/deployment.md#schema-commons-seeding).     |

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

## Docs

- [API reference](./docs/api.md) — routes, auth, and permissions
- [Deployment guide](./docs/deployment.md) — TLS, CORS, and rate limiting

---

## Related

- [`haverstack/core`](https://github.com/haverstack/core) — core library, types, adapters, and spec

---

## License

[CC0 1.0 Universal](./LICENSE) — public domain. No rights reserved.
