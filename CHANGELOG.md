# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

### Added

- `createFeed`, `attachFeed` and `openFeed`: create a data feed with an `sb_live_`
  API key (server-side only) and attach to it with its `sbf_` feed token
  (browser-safe, but never in a URL).
- Two transports: `sdk` (the Centrifugo SDK over WebSocket, with fossil delta)
  and `sse` (Centrifugo uni_sse read with `fetch`, the connect command sent in a
  POST body so the token stays out of URLs).
- Token refresh on the server-provided interval; after a Centrifugo disconnect,
  an immediate refresh following a stable session and backoff otherwise (hard
  backoff for no-reconnect codes); backoff for transient failures, honouring
  `Retry-After`; and terminal `ended` reasons (`withdrawn`, `ended`,
  `unauthorized`, `stopped`).
- A throwing event listener cannot break the feed's lifecycle.
- Key-scoped feeds (planned server support): `machines` is optional and omitting
  it streams the key's whole scope; a venue-scoped feed's machine set is live,
  reported through the `machines` event and `feed.machines`.
- The `scorbit-feed` agent: serves `/state`, `/events` and `/healthz` on
  localhost (loopback `Host` only), optionally serves overlay files (known file
  types, no dotfiles), and deletes a feed it created on exit.
- A starter overlay in `templates/overlay/` whose attribution slot shows the
  Scorbit logo, as the [developer terms](https://scorbit.io/developer-terms-of-use/)
  require.
- Scorbit logo files in `assets/brand/` (repository only; trademarks, not MIT
  licensed).
- ESM build with type declarations, and an IIFE build of the attach-only browser
  subset (global `ScorbitFeed`).
