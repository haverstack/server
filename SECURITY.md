# Security Policy

This server holds someone's personal data and the tokens that speak for them. It is also the only place the Haverstack permission model is actually enforced — everything behind it is full trust. This document says what to do when you find a weakness, which repository to report it to, and which parts of the system carry a security promise at all.

## Reporting a vulnerability

**Report privately, through [GitHub Security Advisories](https://github.com/haverstack/server/security/advisories/new).** That opens a channel visible only to you and the maintainers. Please don't open a public issue or PR for a suspected vulnerability — a public report is a disclosure, and it lands before there's anything to upgrade to.

Include what you have: the version or commit (`GET /.well-known/stack` and the image tag both name it), the request that triggers it, what an attacker gets, and the smallest reproduction you can manage. A failing test against `tests/routes/` is the most useful form, but prose is fine — a clear description of the wrong behavior beats a polished exploit.

Expect an acknowledgement within a week. If a report is valid, you'll get the fix plan and the release it lands in; if it isn't, you'll get the reasoning, which is often the more interesting answer. Credit in the advisory unless you'd rather not be named.

Nothing here is a bug bounty — this is a public-domain project with no budget behind it.

## Which repository

This repository is one implementation of a contract that lives elsewhere. The split matters for a report, because a fix in the wrong place leaves every other implementation exposed:

- **Here** — a finding that is this server's alone: a route that enforces a permission incorrectly, a token that outlives its revocation, a header this server sets, a config default that is unsafe, something in the published Docker image.
- **[`haverstack/core`](https://github.com/haverstack/core/security/advisories/new)** — a finding in the contract or the libraries: the access-control model itself, DID verification, the wire format, the error taxonomy, or anything in `@haverstack/core`, `@haverstack/adapter-local`, or `@haverstack/wire-types`. A bug there is a bug in every server and client at once.

**When it isn't clear which side a finding sits on, report it to core** and say so. A weakness that reaches through this server into the permission model, a wire shape, or a signature check is nearly always the more serious of the two readings, and core is where the people who can adjudicate that are looking. The reverse mistake — filing a protocol-level flaw against one implementation — gets it fixed in one place and quietly leaves it standing everywhere else. Cross-repository advisories are routine; nobody will mind the reroute.

## What is in scope

The server in this repository, its default configuration (`.env.example`), and the `ghcr.io/haverstack/server` image built from it.

**Especially interesting**, because they're where a mistake is least visible:

- Any request that reads or writes a record the [permission rules](./docs/api.md#permissions) say it cannot — particularly through delegation, where effective authority is the intersection of the principal's and the subject's, or through a query filter that leaks a record the same caller couldn't fetch by id.
- A response that discloses whether a record exists to a caller who couldn't read it — a `404` and a `403` that differ where they shouldn't, or a total count that changes.
- Anything that lets a bearer token outlive its revocation or expiry, cross between principal and subject, or be minted for a DID the caller doesn't hold the key for: a challenge redeemable more than once, a nonce accepted after its window, a signature that verifies against a different `BASE_URL`.
- An attachment served with a `Content-Type` or `Content-Disposition` that lets a browser execute it, or an attachment path that escapes its blob directory.
- Input that reaches SQL as syntax rather than as a bound parameter, or that escapes the [error taxonomy](./docs/api.md#auth-errors) as a raw engine error with a stack trace or a filesystem path in it.
- Anything that lets an unauthenticated caller consume resources without bound in a way the [query worker pool](./docs/deployment.md#bounding-query-cost) doesn't already cap — the deadline and queue limit are the intended bound, so a way around _them_ is a finding.
- Secrets in the wrong place: `OWNER_TOKEN` or a session token in a log line, an error body, or an image layer.

## What is not a vulnerability

These are documented properties, not oversights. Each is a design decision with its reasoning in the docs; argue with the decision by opening an issue, not an advisory.

- **The DID handshake is open.** `POST /auth/challenge` and `POST /auth/token` are unauthenticated: anyone reachable can generate a keypair and obtain a token for the `did:key` it derives. That is the point — the handshake proves _which_ DID is calling and authorizes nothing on its own. See [Deployment § The DID handshake is open by design](./docs/deployment.md#the-did-handshake-is-open-by-design).
- **A grant with no grantee is a grant to the public**, and with the handshake open that means anyone. It is the documented meaning of `grant(null, ...)`, not a bypass. See [API § Permissions](./docs/api.md#permissions).
- **`GET /.well-known/stack` is public** and exposes the owner entity ID, timezone, and capability list. Clients need it to bootstrap. A private stack restricts it by network policy, not by auth. See [Deployment § Public endpoints](./docs/deployment.md#public-endpoints).
- **Read routes serve anonymous callers.** `GET /records`, `POST /records/query`, `GET /records/:id`, and `GET /types` answer without a token, subject to record-level permissions. A token changes who you are, not whether the route responds.
- **Rate limiting and abuse control belong to the reverse proxy.** The server bounds query _cost_ (`QUERY_TIMEOUT_MS`, `QUERY_WORKER_POOL_SIZE`, `QUERY_QUEUE_LIMIT`) and body _size_ (`MAX_CONTENT_BYTES`, `MAX_ATTACHMENT_BYTES`), and deliberately does not implement request rate limiting. A deployment without a proxy limit is a misconfiguration; the guide gives Caddy, nginx, and Traefik configs. See [Deployment](./docs/deployment.md).
- **TLS terminates upstream.** The server speaks plain HTTP and expects a proxy in front. Running it directly on a public port is a deployment error.
- **`OWNER_TOKEN` is a shared secret with full owner authority** and no expiry. Treat it like a password; it is break-glass access, not a session.
- **One process per `DB_PATH`.** Permissions exist only behind this server process, so a second writer would be a second, unenforced trust boundary — which is why starting one fails loudly. Direct access to `stack.db` by anything else is full trust by construction. See [Deployment § Single-writer topology](./docs/deployment.md#single-writer-topology).
- **A lost `did:key` private key is unrecoverable**, and key rotation is deferred. That is a protocol property; see core's [Identity](https://github.com/haverstack/core/blob/main/docs/spec/identity.md) spec.

## Supported versions

This server is `0.x` and its API is unstable. Fixes land on `main` and ship in the next release, as a tag and a `ghcr.io/haverstack/server` image; there are no maintained release branches and no backports to older minors. `:latest` tracks the newest release. The practical advice is to track it, and to pin a digest only if you also watch for advisories.
