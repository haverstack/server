# Haverstack Server

Reference HTTP server implementation for [Haverstack](https://github.com/haverstack/core).

Exposes a Haverstack stack over a REST API so apps can read and write records remotely. Uses SQLite for storage via `@haverstack/adapter-local`.

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

## Docker

```sh
docker run -d \
  -e OWNER_TOKEN=<secret> \
  -e ENTITY_ID=<your-entity-id> \
  -p 3000:3000 \
  -v haverstack-data:/app/data \
  ghcr.io/haverstack/server:latest
```

`/app/data` holds the SQLite database, its WAL sidecar files (`stack.db-wal`, `stack.db-shm`), a storage-ownership lock file (`stack.db.lock`), and attachments — mount a volume there for persistence. Set `ENTITY_ID` only on first run; it is ignored once the database exists.

Only one server process may hold a given `DB_PATH` at a time: a second process against the same path fails at startup with a clear error rather than silently sharing (or corrupting) the database. This is enforced by the storage adapter, independent of any reverse proxy or orchestrator setting — see [Deployment: single-writer topology](./docs/deployment.md#single-writer-topology).

---

## Configuration

All configuration is via environment variables. See `.env.example` for the full list.

| Variable               | Required  | Default                                      | Description                                              |
| ---------------------- | --------- | -------------------------------------------- | -------------------------------------------------------- |
| `OWNER_TOKEN`          | Yes       | —                                            | Bearer token for the stack owner. Treat like a password. |
| `ENTITY_ID`            | First run | —                                            | Owner entity ID. Only needed when initializing a new DB. |
| `DB_PATH`              | No        | `/app/data/stack.db` (Docker) / `./stack.db` | Path to the SQLite database file.                        |
| `PORT`                 | No        | `3000`                                       | Port to listen on.                                       |
| `TIMEZONE`             | No        | `UTC`                                        | IANA timezone. Only used on first run.                   |
| `CORS_ORIGINS`         | No        | `` (none)                                    | Allowed origins, comma-separated or `*`.                 |
| `BASE_URL`             | No        | auto-detected                                | Canonical base URL of this server.                       |
| `MAX_ATTACHMENT_BYTES` | No        | `52428800` (50 MB)                           | Maximum attachment upload size.                          |

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
