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
  a refresh within a second following a stable session and backoff otherwise
  (hard backoff for no-reconnect codes); after a server unsubscribe of the
  feed's channel, on either transport, a heartbeat at once (the first since a
  stable session, backoff after that), so a feed the API ended ends with its
  reason; jittered, capped backoff for transient
  failures and reconnects, honouring `Retry-After`; and terminal `ended` reasons
  (`withdrawn`, `ended`, `unauthorized`, `stopped`).
- The Centrifugo endpoint comes from each heartbeat, which names its transport,
  channel and endpoint.
- A `503` is retried, never terminal: the API's own create `503` (data feeds
  switched off, or live feeds uncountable) and a delete's `503` a bounded number
  of times, and a heartbeat's (a feed-store outage) for as long as the feed runs.
  A delete's `409` is retried once, and its `429` when `Retry-After` allows. An
  `AbortSignal` stops a create's or a delete's retries. Errors read the API's
  standardized error bodies, `code` included. README documents every status per
  call.
- Errors are matched by the API's stable error code, never its message: a
  create `503` is retried for `data_feeds_unavailable` and
  `feeds_uncountable`, and once for `feed_store_unavailable`, whose write may
  have landed (a limit reached after it is reported as that store failure); `scope_too_large` throws
  `FeedScopeTooLargeError` and `feed_limit_reached` the new
  `FeedLimitReachedError`. Every `FeedHttpError` carries its `code`, the
  heartbeat's `error` events included, and the `ended` event carries the
  answer that ended the feed as `error`. The agent logs the code with the
  message when a feed ends. Older servers' uncountable `503` and over-scope
  `400`, which had no specific code, are still recognised by their text.
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
