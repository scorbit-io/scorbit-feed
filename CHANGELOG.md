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
  backoff for no-reconnect codes); jittered, capped backoff for transient
  failures, honouring `Retry-After`; and terminal `ended` reasons (`withdrawn`,
  `ended`, `unauthorized`, `stopped`).
- Every heartbeat names its transport, channel and endpoint, and the endpoint is
  taken from each heartbeat and nothing else once connected: `attachFeed` needs
  no `endpoint`, and the agent no `--endpoint`.
- A `503` is retried, never terminal: on create (data feeds switched off, or the
  feed store unreadable) and delete a bounded number of times, and on heartbeat
  (a feed-store outage) for as long as the feed runs. A delete's `409` is retried
  once. README documents every status per call.
- A throwing event listener cannot break the feed's lifecycle.
- Scoped API keys: `listMachines` (and `scorbit-feed machines`) lists what a key
  covers, with each machine's venue; `machines` is optional on create and
  omitting it streams the key's whole scope, with `FeedScopeTooLargeError` when
  that is more than one feed carries.
- Feeds that follow their venues: a create without `machines` on a
  venue-scoped key gains and loses machines while it runs, and may carry none.
  Changes are reported through the `machines` event and `feed.machines`, and the
  agent's `/events` stream sends them as `machines` events.
- The `scorbit-feed` agent: serves `/state`, `/events` and `/healthz` on
  localhost (loopback `Host` only), optionally serves overlay files (known file
  types, no dotfiles), and deletes a feed it created on exit.
- A starter overlay in `templates/overlay/` with one tile per machine, keyed by
  `machine_uuid` and added or removed as machines join and leave, an empty
  state, and an attribution slot that shows the Scorbit logo, as the [developer terms](https://scorbit.io/developer-terms-of-use/)
  require.
- Scorbit® logo files in `assets/brand/` (repository only). SCORBIT® and the
  Scorbit logo are registered trademarks of Spinner Systems, Inc.; the logo
  files are not MIT licensed. See `NOTICE`, now also shipped in the package.
- ESM build with type declarations, and an IIFE build of the attach-only browser
  subset (global `ScorbitFeed`).
