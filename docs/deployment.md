# Deployment Guide

The server speaks plain HTTP. In production, always place it behind a reverse proxy that handles TLS termination and rate limiting. Never expose the plain-HTTP port directly to the internet.

- [Caddy](#caddy) — simplest; automatic HTTPS, minimal config
- [nginx](#nginx) — most common; full control over headers and limits
- [Traefik](#traefik) — best for Docker; auto-discovers containers

---

## Caddy

Caddy obtains and renews TLS certificates automatically via Let's Encrypt.

```
stack.example.com {
    reverse_proxy localhost:3000
}
```

**Rate limiting** is not built into the standard Caddy binary. Options:

- Build Caddy with the [`caddy-ratelimit`](https://github.com/mholt/caddy-ratelimit) community module via [caddyserver.com/download](https://caddyserver.com/download).
- Use a CDN or WAF (e.g. Cloudflare) in front of Caddy for IP-based limiting.

---

## nginx

Obtain a certificate first with [Certbot](https://certbot.eff.org/), then use this configuration. The `limit_req_zone` directives must live in the `http` block (typically `/etc/nginx/nginx.conf` or a file included from it); the `server` block below goes in `/etc/nginx/sites-available/haverstack`.

```nginx
# In the http block:
limit_req_zone $binary_remote_addr zone=hs_global:10m rate=60r/m;
limit_req_zone $binary_remote_addr zone=hs_tokens:10m rate=5r/m;
```

```nginx
# /etc/nginx/sites-available/haverstack
server {
    listen 80;
    server_name stack.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name stack.example.com;

    ssl_certificate     /etc/letsencrypt/live/stack.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/stack.example.com/privkey.pem;

    location / {
        limit_req zone=hs_global burst=20 nodelay;

        proxy_pass http://localhost:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Tighter limit on token issuance to slow brute-force attempts.
    location = /tokens {
        limit_req zone=hs_tokens burst=2 nodelay;

        proxy_pass http://localhost:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## Traefik

Traefik is a good fit when you're already running Docker. It discovers the server container automatically via labels and handles Let's Encrypt itself.

Create a `docker-compose.yml`:

```yaml
services:
  traefik:
    image: traefik:v3
    command:
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      - --entrypoints.web.address=:80
      - --entrypoints.web.http.redirections.entrypoint.to=websecure
      - --entrypoints.web.http.redirections.entrypoint.scheme=https
      - --entrypoints.websecure.address=:443
      - --certificatesresolvers.letsencrypt.acme.email=you@example.com
      - --certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json
      - --certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web
    ports:
      - '80:80'
      - '443:443'
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - letsencrypt:/letsencrypt

  server:
    image: ghcr.io/haverstack/server:latest
    environment:
      OWNER_TOKEN: ${OWNER_TOKEN}
      ENTITY_ID: ${ENTITY_ID} # only needed on first run
    volumes:
      - data:/app/data
    labels:
      - traefik.enable=true
      - traefik.http.routers.haverstack.rule=Host(`stack.example.com`)
      - traefik.http.routers.haverstack.entrypoints=websecure
      - traefik.http.routers.haverstack.tls.certresolver=letsencrypt
      # Rate limit: 60 req/min per IP, burst of 20
      - traefik.http.middlewares.haverstack-rl.ratelimit.average=60
      - traefik.http.middlewares.haverstack-rl.ratelimit.period=1m
      - traefik.http.middlewares.haverstack-rl.ratelimit.burst=20
      - traefik.http.routers.haverstack.middlewares=haverstack-rl

volumes:
  data:
  letsencrypt:
```

Start with:

```sh
docker compose up -d
```

---

## Request body size limits

The server enforces two ceilings of its own — `MAX_CONTENT_BYTES` (default 1 MB, JSON bodies: records, patches, and every other JSON-accepting route) and `MAX_ATTACHMENT_BYTES` (default 50 MB, `POST /attachments` only) — and declares both in `GET /.well-known/stack` (`capabilities.maxContentBytes`/`maxAttachmentBytes`) so clients can pre-check.

A reverse proxy sitting in front, however, often has its own request-body limit, independent of the app's. If that limit is smaller than `MAX_ATTACHMENT_BYTES`, the proxy rejects large uploads before they ever reach the server — usually with a proxy-branded error page, not the server's `413 payload_too_large` wire response. Raise the proxy's own limit to at least `MAX_ATTACHMENT_BYTES` (or match it exactly, so the two ceilings agree and the server's typed error is what clients actually see):

- **nginx** defaults `client_max_body_size` to `1m`. Set it explicitly in the `server` or `location` block:
  ```nginx
  client_max_body_size 50m;
  ```
- **Caddy** has no body-size limit by default — nothing to configure unless you want one tighter than the app's own.
- **Traefik** has no body-size limit by default either, unless you've added a `buffering` middleware with `maxRequestBodyBytes` set — if so, raise it to match.

---

## Bounding query cost

`GET /records` and `POST /records/query` can run a full-text or content-field search over the whole store. The sanitizers bound a `search` string's _complexity_ (wildcards stripped, `NEAR` neutralized, parenthesis nesting capped), but not its _cost_ — a syntactically modest query over a large index can still be slow, and `node:sqlite` runs synchronously with no way to cancel a query from inside the call once it's started (there is no `sqlite3_interrupt` exposed).

The server addresses this the way `docs/spec/wire-format.md § Bounding query cost` prescribes: both query routes run on a small pool of worker threads (`QUERY_WORKER_POOL_SIZE`, default 2) rather than the request thread, each holding its own connection to the same `stack.db` — legal because worker threads share the process's PID with the storage-ownership lock, and because SQLite's WAL mode is built for multiple connections against one file. A query still _executing_ past `QUERY_TIMEOUT_MS` (default 10s) is abandoned: the request gets `503` (code `timeout`, meaning "retryable — narrow the query or try again," never `bad_request`), and the worker it was running on is terminated and replaced so a stuck query costs one pool slot rather than blocking every other request. Terminating mid-query is safe — SQLite's WAL journaling means an uncommitted transaction is simply gone once the file is reopened.

`QUERY_TIMEOUT_MS` bounds execution, and its clock starts when a search reaches a worker — not when the request arrived. That distinction is the difference between a busy server and a broken one: a search waiting for a free worker is _slow_, exactly as it was before any of this existed, and only a search that genuinely sits inside an uncancellable SQLite call gets cut off. Were the deadline to cover queue time too, ordinary contention would turn into `503`s — with two workers and 3-second searches, the seventh concurrent one would fail rather than simply take its turn.

What bounds the waiting instead is `QUERY_QUEUE_LIMIT` (default 64): the number of searches allowed to queue for a worker. Past it the server sheds load explicitly, answering `503` (`timeout`, retryable) rather than accepting work it has no prospect of starting — which keeps "slow under load" from becoming an unbounded queue of held requests. So the worst case a queued search can wait is roughly `QUERY_QUEUE_LIMIT / QUERY_WORKER_POOL_SIZE × QUERY_TIMEOUT_MS`, and that only if every search ahead of it is pathological; in the ordinary case the queue drains in milliseconds.

A worker that dies _unexpectedly_ — as opposed to one deliberately recycled at a deadline — is respawned with exponential backoff (100ms doubling to 30s), and after five consecutive failures the pool reports itself unhealthy and fails searches fast with the underlying error. This is what keeps a fatal misconfiguration (a `DB_PATH` that has become unreadable, say) from spinning the process respawning threads forever, and makes it surface as itself rather than as a stream of timeouts. The pool recovers on its own once the cause clears.

Every other route (`GET /records/:id`, `POST /records`, `PATCH /records/:id`, etc.) still runs on the main request thread — those are index-bound lookups and writes, not full-index scans, so they aren't the unbounded-cost case this section covers.

Raise `QUERY_TIMEOUT_MS` if your store is large enough that legitimate searches routinely take longer than the default, and raise `QUERY_WORKER_POOL_SIZE` if concurrent searches should run in parallel rather than queue behind each other — each pool worker is a full second (or third, ...) connection to the database, so size it against expected concurrent search load, not total request volume. Raise `QUERY_QUEUE_LIMIT` only if you would rather hold bursts than shed them; lower it to fail fast under overload.

Note that `GET /records` and `POST /records/query` are both reachable without authentication, so anonymous callers can occupy pool workers. The deadline caps what any one of them can hold (a slot for at most `QUERY_TIMEOUT_MS`), but a public deployment expecting hostile traffic should rate-limit the query routes at the reverse proxy as well, alongside the other exposure considerations in [Public endpoints](#public-endpoints).

---

## Single-writer topology

The `data` volume (`DB_PATH`'s directory) holds more than the database file itself: `stack.db-wal` and `stack.db-shm` are SQLite's write-ahead-log sidecar files, present whenever the process has the database open, and `stack.db.lock` is a storage-ownership lock recording the PID of the process that opened it. Back up or copy the whole directory, not just `stack.db` — a `stack.db` file copied without its `-wal` sidecar can be missing recently-committed data.

The directory also holds `stack.db.tokens` — bearer-token issuance and lookup, kept in its own file rather than inside `stack.db` on purpose: auth material shouldn't travel with the portable stack data. Include it in operational backups (revoking a token should stay revoked across a restore), but exclude it from any "export your data" or stack-sharing flow — a copy of `stack.db` alone is the correct unit for that, and restoring one should never resurrect tokens the owner revoked.

A given `DB_PATH` may be held open by only one process at a time. If a second server instance (a botched redeploy, a stuck old container, a manual `pnpm start` alongside a running one) tries to open the same path, it fails at startup with an error naming the PID already holding it, rather than corrupting the database or silently serving alongside it — WAL and real file locking make concurrent _storage_ access safer than the old single-file adapter, but the single-writer topology stands regardless: permissions only exist behind this one server process, so a second writer would be a second, unenforced trust boundary. If you see this error on a routine restart, the previous process likely hasn't exited yet — give it time to shut down cleanly, or confirm it has actually stopped, before starting the replacement.

---

## CORS

Set `CORS_ORIGINS` to a comma-separated list of the origins that need cross-origin access to your stack:

```
CORS_ORIGINS=https://app.example.com,https://admin.example.com
```

The default is empty (no cross-origin access allowed). Set it to `*` only for fully-public, read-only stacks where unauthenticated access is intentional.

Because the stack is designed to be accessed by many different kinds of apps, you may legitimately need a broad allowlist. The key risk to avoid is combining a wildcard origin with endpoints that accept bearer tokens — browsers will not send `Authorization` headers with credentialed cross-origin requests unless the origin is explicitly listed, so a wildcard does not grant unintended authenticated access from arbitrary origins.

## The DID handshake is open by design

`POST /auth/challenge` and `POST /auth/token` are unauthenticated: anyone who can reach the server can generate an Ed25519 keypair and obtain a bearer token for the `did:key` it derives. That is the point — the handshake proves _which_ DID is calling, so the owner can grant a DID by name ahead of time instead of handing out a shared secret out of band. It authorizes nothing on its own.

Two consequences worth being deliberate about:

- **A grant with no grantee is a grant to the public.** `grant(null, ...)` resolves for any authenticated entity, and with the handshake open that is anyone at all. See [Access Control](./api.md#access-control). Named grants (`grant(<did>, ...)`) are unaffected — those are the vouching mechanism.
- **Rate limiting matters more than it used to.** A stranger's handshake writes a token row with a 7-day expiry. Expired rows are reclaimed, but live ones are bounded only by issuance rate × TTL, so the proxy-level rate limit configured above is what actually caps the table. The reverse-proxy examples in this guide already cover `/auth/*`; if you write your own, do not exempt it.

Read access is unaffected either way: `GET /records`, `POST /records/query`, `GET /records/:id` and `GET /types` already serve anonymous requests, subject to record-level permissions, and a token changes nothing about what they return.

## Public endpoints

`GET /.well-known/stack` is intentionally public and unauthenticated. It exposes the owner entity ID, configured timezone, and capability list. This information is required by `@haverstack/adapter-api` to bootstrap a client connection. If your stack is private, ensure the endpoint is only reachable by intended clients (e.g. by network policy) rather than by auth-gating it.
