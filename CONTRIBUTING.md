# Contributing

Thanks for working on this. This document covers how to get set up, what to run before you push, where to file what, and the conventions the codebase already follows — the ones that aren't obvious from reading a single file.

This is the reference server. The contract it implements — the data model, the permission rules, the wire format — lives in [`haverstack/core`](https://github.com/haverstack/core), and that split shapes most of what follows.

---

## Setup

Node 22.9+ and pnpm 11; CI runs Node 22 and the `packageManager` pin.

```sh
cp .env.example .env
# Edit .env — set OWNER_TOKEN, ENTITY_ID, and BASE_URL at minimum
pnpm install
pnpm dev
```

`pnpm dev` starts with live reload on `PORT` (default `3000`) and initializes a SQLite database at `DB_PATH` on first run.

---

## Before you push

Run all four:

```sh
pnpm run format:check   # or: pnpm run format, to fix in place
pnpm run lint
pnpm typecheck
pnpm test
```

These mirror `.github/workflows/ci.yml` exactly, so a clean local run means a green PR. Failures block merge.

Unlike core, nothing here needs a build first — `pnpm typecheck` runs against `src/` directly, and the `@haverstack/*` packages resolve from `node_modules` as published builds.

**Testing against unreleased core changes.** When a change here depends on something not yet published from core, don't hand-edit the version range: link the workspace (`pnpm link --global` in the core package, or a `pnpm.overrides` entry you drop before pushing) and land the core release first. A PR here that only passes against a local core checkout will fail CI, which installs from the registry.

---

## Where to file an issue

Two repositories, one contract. Filing in the wrong one usually means a fix that lands in one place and quietly leaves the problem standing everywhere else.

- **Here** — a route's behavior, a status code this server returns, config and environment variables, the Docker image, deployment guidance, the change feed, the query worker pool, token issuance and storage.
- **[`haverstack/core`](https://github.com/haverstack/core/issues)** — the data model, permission semantics, identity and DID handling, the wire format and its error taxonomy, the conformance fixtures, and anything in `@haverstack/core`, `@haverstack/adapter-local`, or `@haverstack/wire-types`.

**When it isn't clear which side something sits on, file it in core** and say which server behavior prompted it. The wire contract is the thing multiple implementations have to agree on, so an ambiguous bug is more usefully argued there — and a fixture or spec section is the durable form of the answer. Moving an issue afterwards is cheap; discovering six months later that a protocol flaw was filed as a server bug is not.

For a suspected **security** issue, don't open an issue at all — see [SECURITY.md](./SECURITY.md), which draws the same line for advisories.

---

## Commit style

This project uses [Conventional Commits](https://www.conventionalcommits.org/). Every commit message must start with a type prefix. The release workflow reads commit messages since the last tag to determine the version bump automatically:

| Commit type                                                              | Example                             | Version bump |
| ------------------------------------------------------------------------ | ----------------------------------- | ------------ |
| `feat:`                                                                  | `feat: add token expiry`            | minor        |
| `feat!:` or `BREAKING CHANGE` footer                                     | `feat!: rename /entity to /owner`   | major        |
| Anything else (`fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `perf:`) | `fix: return 404 on missing record` | patch        |

A scope is optional: `fix(attachments): reject empty filename`.

Getting the type wrong produces the wrong version bump with no warning, so when in doubt use `fix:` for patches and `feat:` only for genuinely new capabilities.

Write the subject in the imperative, and use the body to explain _why_ the change was made, not what the diff already shows.

Issue references (`#123`, `core#52`) belong in commit messages, PR titles, and PR bodies. They do **not** belong in code comments — see [Comments](#comments).

---

## Pull requests

- One concern per PR. Split unrelated changes.
- The PR description should explain _why_, not just _what_ — the diff already shows what changed.
- Link to any relevant issue with `Closes #N`.
- Keep PRs small enough to review in one sitting; large refactors are fine but flag them early.
- Fill in [`.github/pull_request_template.md`](./.github/pull_request_template.md), including the Docs section — answer it even when the answer is "no behavior change."
- Work on a branch; CI must be green before merge.

If you're an AI coding agent, [AGENTS.md](./AGENTS.md) is the condensed, checkable form of this document.

---

## Releasing

Releases are automatic. `.github/workflows/release.yml` runs on every push to `main` (skipping its own `chore: release` commit), reads the conventional-commit prefixes since the last tag to pick a bump, then:

1. bumps `version` in `package.json`,
2. builds and pushes `ghcr.io/haverstack/server` at that version and `:latest`,
3. commits the bump, tags it, pushes to `main`, and cuts a GitHub release with generated notes.

Nobody edits `version` by hand and nobody builds the image by hand. Two things are load-bearing: the workflow needs `contents: write` and `packages: write`, and the `github-actions[bot]` push to `main` requires a branch-protection bypass (Settings → Branches → _Allow specified actors to bypass required pull requests_). Merging to `main` is the act of releasing, which is why `main` is protected.

The version bump is derived from commit subjects, so a squash merge means the squashed subject is what counts — check it before confirming the merge.

---

## Comments

The convention this codebase follows, in order of how often it comes up:

**Comments answer _why_. The _how_ should be visible in the code itself.** If a comment is narrating what the next few lines do, delete it and let the code speak. If the code is hard enough to follow that it needs narration, that's usually a signal to simplify the code.

**Keep them short — four or five lines is the extreme case, not the target.** Anything needing more explanation than that links out to the docs or to core's spec instead of carrying the argument inline:

```ts
// A search past QUERY_TIMEOUT_MS is abandoned and its worker replaced: a
// stuck query costs one pool slot rather than every request. See
// docs/deployment.md § Bounding query cost.
```

**File-top module comments are exempt.** A comment at the top of a file may be as long as it needs to be to explain what the module does and why it exists.

**No GitHub issue references.** An issue captured something that needed to change, and the change is now reflected in the code and the docs. A `(#44)` in a comment adds nothing a reader can act on, and it makes the source unreadable anywhere the issue tracker isn't at hand. If the rationale matters, state it or link to the section that holds it.

**No references to previous implementations.** Comments describe the code as it is now. Phrases like "the old single-threaded path", "this used to run on the request thread", or "before this fix" date the comment and describe code that no longer exists. State the invariant instead:

```ts
// Don't:
// Auth used to fall through to anonymous on a malformed header.

// Do:
// A present-but-unparseable Authorization header is a 401, never a silent
// downgrade to anonymous — a client that sent *something* meant to.
```

The same applies to tests. A regression test's name and comment should say what invariant it pins, not what bug prompted it.

---

## The spec is the source of truth, and it lives in core

Design decisions — the data model, identity, access control, versioning, attachments, the wire format — live in core's [`docs/spec/`](https://github.com/haverstack/core/tree/main/docs/spec). This server implements them; it does not get to redefine them.

That means a change to the wire contract is a core PR first: spec section, then `@haverstack/conformance-fixtures`, then the implementation here. A server-side "fix" that makes a fixture pass by changing what this server sends, without the fixture moving, is this server diverging from the contract — which `tests/conformance.test.ts` exists to catch.

This repository's own docs cover what is genuinely the server's:

- [`docs/api.md`](./docs/api.md) — routes, auth handshake, query parameters, permissions as this server exposes them
- [`docs/deployment.md`](./docs/deployment.md) — TLS, proxies, CORS, body limits, query cost, single-writer topology
- [`README.md`](./README.md) — the configuration table
- [`.env.example`](./.env.example) — every variable, with its default

A change to observable behavior updates the relevant one **in the same PR**. A new environment variable touches three of them (`.env.example`, the README table, and usually a deployment section); they drift the moment they're updated separately.

When you link to a core spec section from a comment, use the `docs/spec/<file>.md § Section` form and make sure the section actually exists.

**Prose describes the system as it is, not how it got there.** The no-references-to-previous-implementations rule above applies to documentation, and bites harder there: an operator reading the deployment guide is deciding what to configure, and "this now runs on workers", "as of 0.6 the timeout also covers queueing", or "once #88 lands" describe a system they cannot see. They also rot silently — the sentence stays true-sounding long after it stopped being news.

---

## No backward compatibility yet

**There is no install base.** Nothing depends on this server's current behavior, so there is nothing to preserve. Prefer changing things in place over carrying compatibility shims:

- No accepting an older request shape "just in case" — no such client exists.
- No deprecation cycles; delete the old route.
- No `legacy` branches in handlers, and no `legacy` in prose. A third-party implementation of the wire protocol is _foreign_, not legacy — that distinction is real and worth keeping.

Note that this is about _our_ history, not about inputs we genuinely receive. Handling a client that omits an optional field, or a stack database written by another adapter, is current-behavior compatibility and stays.

One thing does not get this freedom: **stored data**. A change to what lives in `DB_PATH` — the database, the token store, the nonce store, the attachments directory — meets a running deployment with data in it and no migration path this repository provides. Say so explicitly in the PR and in the release notes.

---

## Architecture conventions

**The server is a thin, enforcing layer over `Stack`.** Validation, ID rules, permission logic, and the record model belong to `@haverstack/core` and are inherited, not reimplemented. What this repository owns is everything the library can't see: HTTP shape, authentication, config, transport limits, and process lifecycle. A permission check written inside a route handler is a bug waiting to diverge from the model — the exceptions are the ones the wire format assigns to the server, like deciding what an anonymous caller may reach.

**One module per concern**, following the layout in [Where things live](#where-things-live):

- `src/routes/*` — one file per URL prefix, each exporting a `Hono` sub-app mounted in `src/app.ts`. Handlers parse, call `Stack`, and serialize; anything longer than that usually belongs in `src/lib/`.
- `src/middleware/*` — cross-cutting: `auth.ts` resolves a credential to a principal/subject pair (or anonymous), `errors.ts` maps thrown `StackError`s to wire responses.
- `src/lib/*` — mechanism with no HTTP in it: the query worker pool, change streams, resume cursors, the nonce store, token sweeping.

**Errors go out through one of two paths, never by hand.** A thrown core `StackError` is mapped by `errorMiddleware` via `serializeError()`, which is what keeps the [error taxonomy](https://github.com/haverstack/core/blob/main/docs/spec/wire-format.md) intact. Failures with no core class — a missing bearer token, a `404` for an unrouted path — use `wireError()` so the `{ error: { code, message } }` shape stays uniform. Never `c.json()` an error body directly, and never let an engine error reach the client as itself.

**Compare credentials in constant time.** `safeCompare()` in `src/middleware/auth.ts` is the only way to check a presented secret against a configured one; every owner-token comparison goes through it, including the ones that re-derive "is this the owner" outside the middleware.

**Anything that can scan the whole store runs on the worker pool.** `GET /records` and `POST /records/query` go through `QueryWorkerPool` because `node:sqlite` is synchronous and uncancellable in-process. Point lookups and writes stay on the request thread — they're index-bound. A new route that can trigger a full scan belongs on the pool; see [Deployment § Bounding query cost](./docs/deployment.md#bounding-query-cost).

**Config is parsed once, at the edge.** `src/config.ts` reads and validates the environment into a `Config` object, and everything downstream takes that object rather than reaching for `process.env`. The one exception is `src/index.ts`, which reads `LOG_LEVEL` and `NODE_ENV` to build the logger before config parsing runs — so that a config error is logged rather than thrown into the void. A new variable is added to `src/config.ts`, `.env.example`, and the README table together, and gets a default that is safe for a public deployment, or is required outright.

**Shutdown is part of the contract.** `src/shutdown.ts` drains open connections within `SHUTDOWN_TIMEOUT_MS` and then closes the stack, token store, nonce store, and worker pool. Anything new holding a file handle, a thread, or a long-lived response (the change feed does all three) registers its cleanup there.

---

## Testing conventions

Tests use [Vitest](https://vitest.dev/) and live in `tests/`, mirroring `src/`.

`tests/setup.ts` is the shared harness. Use it rather than building a server by hand:

- **`buildTestApp()`** — a real `Hono` app over a real SQLite database in an isolated temp directory, plus a `cleanup()` that closes everything and removes it. Tests exercise the actual HTTP surface, not a mocked one.
- **`req(app, method, path, opts)`** — fires a request and returns `{ status, data }`.
- **`TEST_ENTITY_ID` / `OTHER_ENTITY_ID` / `TEST_TOKEN` / `TEST_BASE_URL`** — the fixed identities. `TEST_BASE_URL` matches `@haverstack/conformance-fixtures`' `AUTH_FIXTURE_ORIGIN`, because the auth fixtures carry real signatures over that exact origin; changing it breaks the handshake fixtures.

Each test gets its own temp directory so parallel runs don't collide over the database's sibling `attachments/` folder. Always `await cleanup()` — a leaked worker pool keeps the run alive.

**`tests/conformance.test.ts` is an acceptance gate, not a snapshot.** It runs `@haverstack/conformance-fixtures` against the real HTTP surface, and every fixture in each imported array is either dispatched or named in that block's `SKIPPED` set with a reason. Each block's final coverage test fails when core adds, removes, or renames a fixture this file hasn't been told about. When that happens, the fix is to handle the new fixture or skip it with a reason — never to loosen the coverage check.

Name tests after the behavior they pin, not the defect that prompted them. `'a revoked token is rejected on a route that allows anonymous reads'` survives refactoring; `'regression for #44'` doesn't.

---

## Where things live

```
docs/
  api.md                  # Routes, auth, query parameters, permissions
  deployment.md           # TLS, proxies, CORS, limits, query cost, topology
src/
  index.ts                # Entry point: config, stack, server, signals
  app.ts                  # Hono app: middleware order and route mounting
  config.ts               # Environment parsing and validation
  stack.ts                # StackContext: adapter, stack, tokens, nonces, workers
  shutdown.ts             # Connection draining and orderly resource close
  wireError.ts            # `{ error: { code, message } }` for non-StackError failures
  types.ts                # Hono environment bindings
  middleware/
    auth.ts               # Bearer resolution, principal/subject, constant-time compare
    errors.ts             # StackError → wire response mapping
  routes/                 # One sub-app per URL prefix
  lib/                    # Mechanism: query workers, change streams, cursors, nonces
tests/
  setup.ts                # buildTestApp(), req(), shared identities
  conformance.test.ts     # @haverstack/conformance-fixtures acceptance gate
  routes/ lib/            # Mirrors src/
```
