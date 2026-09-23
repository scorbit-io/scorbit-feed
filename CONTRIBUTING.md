# Contributing

Thanks for helping. A few rules keep this package safe to embed in other
people's overlays.

## Quality gates

Node 22 or newer.

```sh
npm ci
npm run lint            # ESLint (typescript-eslint, flat config) + Prettier --check
npm run typecheck       # tsc --noEmit, strict
npm run test:coverage   # Vitest with v8 coverage
npm run build           # tsup: ESM + .d.ts, the browser IIFE (global ScorbitFeed), and the CLI
npm run pack:check      # npm pack --dry-run must list exactly the intended files
npm run check           # all of the above; this is what CI runs
```

Coverage is **100%** of statements, branches, functions and lines, and CI
enforces it. A change that drops coverage does not merge. Use `/* v8 ignore */`
only with a one-line reason next to it.

## Rules

- **Never hard-code a feed timer.** The refresh interval, token lifetime and
  grace period come from the server; tests and docs describe them, not freeze
  them.
- **Never let a credential reach a log line, an error message, a URL, or an
  agent response.** The `sb_live_` key is server-side only; the `sbf_` token is
  the only browser-safe credential, and never goes in a URL. Test fixtures use obviously fake values.
- **Logo files are not MIT licensed.** SCORBIT® and the Scorbit logo are
  registered trademarks of Spinner Systems, Inc. (see `NOTICE`). Never edit the
  artwork or remove the notice comment from any `.svg`; a test checks it is there.
- A test that proves a guard should fail when the guard is removed. Check that
  it does.
- Keep message and response types in step with the Scorbit API's data-feed
  serializers.

## Commits and pull requests

Conventional Commits (`feat(scope): ...`, `fix: ...`, `docs: ...`), subject
line at most 72 characters. Open pull requests against `main`.
