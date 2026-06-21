# Contributing

## Development setup

```sh
cp .env.example .env
# Edit .env — set OWNER_TOKEN and ENTITY_ID at minimum
pnpm install
pnpm dev
```

Run the full check suite before opening a PR:

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
```

All four run in CI and failures block merge.

## Commit style

This project uses [Conventional Commits](https://www.conventionalcommits.org/). Every commit message must start with a type prefix. The release workflow reads commit messages since the last tag to determine the version bump automatically:

| Commit type | Example | Version bump |
| --- | --- | --- |
| `feat:` | `feat: add token expiry` | minor |
| `feat!:` or `BREAKING CHANGE` footer | `feat!: rename /entity to /owner` | major |
| Anything else (`fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `perf:`) | `fix: return 404 on missing record` | patch |

A scope is optional: `fix(attachments): reject empty filename`.

Getting the type wrong produces the wrong version bump with no warning, so when in doubt use `fix:` for patches and `feat:` only for genuinely new capabilities.

## Pull requests

- One concern per PR. Split unrelated changes.
- The PR description should explain *why*, not just *what* — the diff already shows what changed.
- Link to any relevant issue with `Closes #N`.
- Keep PRs small enough to review in one sitting; large refactors are fine but flag them early.
