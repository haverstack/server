# Agent Guide

Instructions for AI coding agents working in this repository. Humans should read [CONTRIBUTING.md](./CONTRIBUTING.md), which explains the reasoning behind everything here; this file is the short, checkable form.

This is the reference server for [Haverstack](https://github.com/haverstack/core). The contract it implements lives in core, and most of the rules below follow from that.

## Before you push

Run all four. They mirror `.github/workflows/ci.yml`, so a clean local run means a green PR.

```sh
pnpm install
pnpm run format:check   # pnpm run format to fix in place
pnpm run lint
pnpm typecheck
pnpm test
```

No build step is needed first — `typecheck` runs against `src/`, and `@haverstack/*` resolve from `node_modules`.

Report results honestly. If something fails, say so with the output rather than describing the change as complete.

A change that depends on unpublished core changes cannot pass CI here, which installs from the registry. Land the core release first; don't edit a version range to point at a local checkout.

## Which repository

Two repositories, one contract. Filing or fixing in the wrong one leaves the problem standing everywhere else.

- **Here**: routes, status codes, config and environment variables, the Docker image, deployment guidance, the change feed, the query worker pool, token issuance and storage.
- **[core](https://github.com/haverstack/core)**: the data model, permission semantics, identity and DIDs, the wire format and error taxonomy, the conformance fixtures, and the `@haverstack/*` packages.

**When it isn't clear which side a bug or a security finding sits on, raise it in core** and say which server behavior prompted it. The wire contract is what multiple implementations must agree on, so an ambiguous defect is more usefully argued there, and a spec section or fixture is the durable form of the answer. For a suspected vulnerability use a private advisory, not an issue — see [SECURITY.md](./SECURITY.md).

## Writing comments

These rules are enforced in review. Applying them to code you touch is expected; a sweeping unrelated comment refactor is not.

- **Answer _why_, not _how_.** The how should be readable in the code. Don't narrate the next few lines.
- **Four or five lines is the maximum**, not the target. Longer explanations link out: `See docs/deployment.md § Bounding query cost.`
- **File-top module comments are exempt** — they may be as long as needed to say what the module is and why it exists.
- **Never cite GitHub issues** (`#44`, `core#52`) in code comments. They belong in commit messages and PR descriptions only.
- **Never describe previous implementations.** No "the old path", "this used to…", "before this fix". State the current invariant. This applies to test comments too: say what the test pins, not what bug prompted it.

## The spec is the source of truth, and it lives in core

Design lives in core's [`docs/spec/`](https://github.com/haverstack/core/tree/main/docs/spec): data model, identity, access control, versioning, attachments, adapters, wire format. This server implements it and does not redefine it.

- A change to the **wire contract** is a core PR first — spec, then `@haverstack/conformance-fixtures`, then the implementation here. Changing what this server sends so a fixture passes, without the fixture moving, is divergence.
- A change to **this server's** observable behavior (a route, status code, error code, auth rule, env var) updates this repo's docs in the same change: `docs/api.md`, `docs/deployment.md`, the README config table, `.env.example`. A new env var touches at least three of those.
- Section names are load-bearing — comments reference them as `docs/spec/<file>.md § Section`. Verify a section exists before linking to it.
- **Prose states the system as it is, never how it got there.** "now runs on workers", "as of 0.6", "once #88 lands" date the document and describe a system the reader can't see.

## No backward compatibility

There is **no install base**. Nothing depends on this server's current behavior.

- Don't add compatibility shims, deprecation paths, or handler branches for request shapes this server never accepted. Delete rather than deprecate.
- Don't use the word "legacy". A third-party implementation of the wire protocol is _foreign_, not legacy.
- Genuinely foreign input — an optional field a client omits, a stack file from another adapter — is current-behavior handling and stays.
- **Stored data is the exception.** A change to what lives under `DB_PATH` (database, token store, nonce store, attachments) meets running deployments with no migration path. Flag it explicitly in the PR.

## Architecture rules

- **The server is a thin, enforcing layer over `Stack`.** Validation, ID rules, and permission logic belong to `@haverstack/core`. Don't reimplement a model invariant in a route handler.
- **Routes are sub-apps.** One file per URL prefix in `src/routes/`, mounted in `src/app.ts`. Handlers parse, call `Stack`, serialize. Mechanism goes in `src/lib/`, cross-cutting concerns in `src/middleware/`.
- **Errors take one of two paths, never a hand-rolled body.** A thrown core `StackError` is mapped by `errorMiddleware` via `serializeError()`. Failures with no core class use `wireError()`. Never `c.json()` an error directly; never let an engine error or a stack trace reach the client.
- **Compare secrets with `safeCompare()`** from `src/middleware/auth.ts`. Every owner-token comparison goes through it.
- **Anything that can scan the whole store runs on `QueryWorkerPool`**, because `node:sqlite` is synchronous and uncancellable. Point lookups and writes stay on the request thread.
- **Config is parsed once** in `src/config.ts`; downstream code takes the `Config` object. New variables land in `src/config.ts`, `.env.example`, and the README table together, with a default that is safe for a public deployment.
- **Register cleanup in `src/shutdown.ts`** for anything holding a file handle, a thread, or a long-lived response.

## Tests

Vitest, in `tests/`, mirroring `src/`. Use `tests/setup.ts` rather than building a server by hand:

- `buildTestApp()` — real Hono app over a real SQLite database in an isolated temp dir, plus `cleanup()`. Always `await cleanup()`; a leaked worker pool keeps the run alive.
- `req(app, method, path, opts)` — returns `{ status, data }`.
- `TEST_BASE_URL` matches `@haverstack/conformance-fixtures`' `AUTH_FIXTURE_ORIGIN` — the auth fixtures carry real signatures over that exact origin. Don't change it.

`tests/conformance.test.ts` is an acceptance gate: every fixture is dispatched or listed in a `SKIPPED` set with a reason, and each block's coverage test fails when core adds or renames one. Handle the new fixture or skip it with a reason — never loosen the coverage check.

Name tests after the invariant they pin, not the defect that prompted them.

## Commits and pull requests

- Conventional Commits, and they drive the release: `feat:` → minor, `feat!:` or a `BREAKING CHANGE` footer → major, everything else (`fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `perf:`) → patch. Scope optional: `fix(attachments): …`. Getting the type wrong produces the wrong version bump silently — when in doubt, `fix:`.
- Imperative subject; the body explains why. On a squash merge, the squashed subject is what the release workflow reads.
- Issue references are welcome in commit messages and PR bodies.
- One concern per PR. Fill in `.github/pull_request_template.md`, including the Docs section.
- Never hand-edit `version` in `package.json` — `.github/workflows/release.yml` owns it, and merging to `main` is the act of releasing.
- Don't open a PR unless asked to.
