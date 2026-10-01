# @scorbit/feed

Client library and local agent for the Scorbit real-time data feed: live scores
from the pinball machines you own or operate, delivered to your overlay, app or
integration.

- **`@scorbit/feed`**, a TypeScript library that runs in browsers and in Node 22+.
- **`scorbit-feed`**, a command-line agent that holds a feed open and serves it
  on `localhost`, for OBS browser sources and other local overlays.
- **`templates/overlay/`**, a plain HTML/CSS/JS starter overlay for the agent.

> Status: 0.1.0, unreleased. The package is not on npm yet.

## Install

```sh
npm install @scorbit/feed
```

For a page without a bundler, a self-contained script (`dist/scorbit-feed.iife.js`)
exposes the browser subset as the global `ScorbitFeed`: `attachFeed` and its
types only. `createFeed` and `openFeed` are left out on purpose, because they
need the API key.

## Credentials

There are two credentials, and the difference between them matters.

| Credential | Prefix     | What it can do                                    | Where it may live                                                       |
| ---------- | ---------- | ------------------------------------------------- | ----------------------------------------------------------------------- |
| API key    | `sb_live_` | Create and manage feeds for your account          | **Server-side only.** Never ship to a browser                           |
| Feed token | `sbf_`     | Refresh and delete **one** feed, and nothing else | May reach a browser, but **never in a URL**: not a page, source or link |

The library enforces this:

- `createFeed` needs an `sb_live_` key, and refuses to run where `window` exists
  (override with `dangerouslyAllowBrowser: true` only for a trusted runtime that
  happens to define `window`).
- `attachFeed` needs an `sbf_` token, and refuses anything else, an API key
  included, before making any request.

A feed token is returned once, when the feed is created. Keep it if you want to
attach to the feed again later.

The feed token is browser-safe only relative to the API key: it can do little,
but anyone who holds it can read the feed and delete it. Keep it out of URLs,
query strings and OBS browser-source addresses, which end up in logs, history,
screenshots and shared scene collections. Two supported ways to give a page
what it needs:

- **Run the agent** (`scorbit-feed`, below). It holds the feed and the token
  itself and serves the page only feed data on `localhost`. The page never sees
  a credential. This is the right choice for OBS.
- **Serve the page from your own server**, which creates the feed and hands the
  page `feed_id`, `feed_token` and the endpoint in its response body (for
  example an authenticated `fetch` from the page, or a value rendered into the
  page), never in the page's address.

### Scoped keys, discovery and following feeds

Every API key carries a scope, chosen when the key is generated: whole venues,
or specific machines. `listMachines` asks what a key covers right now (each
machine's uuid, game name and venue); a machine the account no longer owns is
simply absent. Like `createFeed`, it needs the API key and runs server-side only.

Creating a feed **without** `machines` streams the key's whole scope; passing
`machines` narrows it to a subset, in your order. An empty `machines` list is
refused rather than read as "everything". A scope larger than one feed can carry
is refused with a `FeedScopeTooLargeError` (a `400`, code `scope_too_large`):
pass `machines` with a subset.

A feed created without `machines` on a **venue-scoped** key **follows** its
venues: machines join and leave the running feed as the venues' membership
changes, and the set may become empty (a venue with no machines yet, or after
the last one left) without the feed ending. Every published update carries the
current machine list, which is authoritative: key tiles by `machine_uuid`, never
by position, and never assume the list from create is fixed. The feed emits a
`machines` event (`{ added, removed, machines }`) whenever the set in an update
differs from the last one, and `feed.machines` holds the current set. Every other
feed (a machine-scoped key's, or one created with `machines`) is fixed: it ends
(`403` or `404`) when one of its machines leaves.

## Usage

### Server or agent: see what the key covers

```ts
import { listMachines } from "@scorbit/feed";

const { scope_type, machines } = await listMachines({ apiKey: process.env.SCORBIT_API_KEY! });
for (const m of machines) console.log(m.uuid, m.game_name, m.venue.name);
```

### Server or agent: create and attach in one step

```ts
import { openFeed } from "@scorbit/feed";

const { feed, created } = await openFeed({
  apiKey: process.env.SCORBIT_API_KEY!,
  machines: ["<venue-machine-uuid>", "<venue-machine-uuid>"], // optional: omit for the key's whole scope
  transport: "sdk", // or "sse"
});

feed.on("machines", ({ added, removed }) => console.log("joined", added, "left", removed));
feed.on("update", (update) => {
  // The current set, possibly empty: key what you render by machine_uuid.
  for (const machine of update.payload.machines) {
    console.log(
      machine.game_name,
      machine.scores.map((s) => s.score),
    );
  }
});
feed.on("status", (status) => console.log("status:", status));
feed.on("ended", ({ reason, error }) => console.log("ended:", reason, error?.code));
feed.start();

// Later: disconnect and delete the feed on the server.
await feed.stop();
```

`created` is the create response, including `feed_token`. Keep it out of logs.

### Browser: attach with the feed token

Create the feed on your server, then hand the browser only `feed_id`,
`feed_token` and the endpoint, in a response body rather than a URL (see
[Credentials](#credentials)). Without `initialTokens` the feed's first heartbeat
supplies everything it needs:

```ts
import { attachFeed } from "@scorbit/feed";

const feed = attachFeed({
  feedId,
  feedToken, // sbf_...
});
feed.on("update", render);
feed.start();
```

### API

| Function                           | Returns                      | Notes                                                                             |
| ---------------------------------- | ---------------------------- | --------------------------------------------------------------------------------- |
| `listMachines(options)`            | `Promise<MachineScope>`      | `{ apiKey, baseUrl?, fetch?, dangerouslyAllowBrowser? }`                          |
| `createFeed(options)`              | `Promise<CreatedFeed>`       | `{ apiKey, machines?, transport?, baseUrl?, fetch?, dangerouslyAllowBrowser? }`   |
| `attachFeed(options)`              | `Feed`                       | `{ feedId, feedToken, baseUrl?, transport?, initialTokens?, fetch?, websocket? }` |
| `openFeed(options)`                | `Promise<{ feed, created }>` | `createFeed` then `attachFeed` with the create response as the first tokens       |
| `feed.start()`                     | `void`                       | Connect and keep the tokens fresh                                                 |
| `feed.stop({ deleteFeed = true })` | `Promise<void>`              | Disconnect, stop all timers, and by default delete the feed                       |
| `feed.on(event, listener)`         | unsubscribe function         | Events below                                                                      |

Events:

- `update`: a `data_feed_update` message, every machine the feed covers now, in
  the feed's order (possibly none, on a feed that follows its venues). `game_ended` is true when the last game finished and the
  scores are final; both device generations are normalised onto it by the server.
- `machines`: `{ added, removed, machines }` (uuids), when the feed's machine set
  changes. Emitted before the `update` that carried the change.
- `status`: `idle`, `connecting`, `live`, `reconnecting`, `ended`.
- `ended`: `{ reason, error }`, see below. `error` is the heartbeat answer that
  ended the feed (a `FeedHttpError`, `code` included); absent for `stopped`.
- `error`: a non-fatal problem (a failed refresh that will be retried, a dropped
  connection). Messages never contain a credential.

What the library throws is a `FeedError`; an answer from the API is a
`FeedHttpError` with its `status`, the API's `detail` text and its stable error
`code` (`errors[0].code`). A scope too large for one feed is a
`FeedScopeTooLargeError`, and a create at the account's live-feed ceiling a
`FeedLimitReachedError`. Branch on `code`, never on the text: the API may reword
its messages, but not its codes.

`baseUrl` defaults to `https://api.scorbit.io`.

## Transports

- **`sdk`** uses the official [`centrifuge`](https://www.npmjs.com/package/centrifuge)
  client over a WebSocket, with fossil delta compression on the subscription. The
  SDK pulls refreshed tokens through its `getToken` hooks. It uses the global
  `WebSocket` (Node 22+ and browsers); pass `websocket` for a runtime without one.
- **`sse`** reads Centrifugo's unidirectional Server-Sent Events endpoint with
  `fetch`, so it needs no EventSource and works in browsers and Node alike. The
  connect command is sent in a POST body, so the token never appears in a URL. A
  unidirectional client cannot swap tokens in place, so the stream is reopened
  with the fresh token after every refresh.

Both carry the same messages.

## Lifecycle

- **Liveness is presence.** A feed stays alive for as long as something is
  subscribed to it. Left unwatched for the server's grace period, it ends.
- **The heartbeat is a token refresh, not a keep-alive.** The library calls it on
  the `heartbeat_interval` the server returns for each feed (it varies per feed),
  never on a compiled-in number, and the tokens it returns last `token_ttl`
  seconds.
- **Disconnects.** When Centrifugo closes a connection that had been live for a
  while, the library refreshes the tokens and reconnects within a second (spread
  at random, so feeds dropped together do not refresh together). A connection
  that drops soon after connecting backs off exponentially, with jitter, instead, so a server
  that keeps disconnecting cannot cause a refresh storm; the backoff resets only
  after a sustained live session. Codes Centrifugo marks as "do not reconnect"
  (3500–3999, 4500–4999) back off to the maximum, and the next heartbeat settles
  whether the feed is over.
- **Every heartbeat names its stream**: the transport, the channel and that
  transport's endpoint. Once connected, the library takes the endpoint from each
  heartbeat and from nothing else: a reply without one is malformed and retried,
  and nothing is carried over from the create response.
- **Listener errors.** A listener that throws cannot break the lifecycle: its
  exception is emitted as an `error` event (an `error` listener's own exception
  is re-thrown outside the feed).
- **Terminal answers are never retried.** A heartbeat's `401`, `403` or `404`
  ends the feed; see the tables below.

### Status codes and retries

Retries use a capped exponential backoff with jitter (1 s doubling to 30 s, each
wait somewhere in the upper half of that), well inside the token lifetime, and
never sooner than a `Retry-After` header asks. A heartbeat retry leaves the
connection's status alone. A create or a delete makes at most four attempts, and
surfaces the answer at once rather than wait longer than 30 s. Pass `signal` (an
`AbortSignal`) to `createFeed` or `listMachines`, or to `feed.stop()`, to give up
early: a create stops between attempts but never abandons one in flight, whose
answer says whether the feed exists; a delete stops at once, and the feed then
lives on until the server drops it.

Decisions follow the status and, where the status alone is ambiguous, the
error code; never the message.

| Call      | Answer                                                                        | What the library does                                                                                                                              |
| --------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| create    | `201`                                                                         | Returns the feed                                                                                                                                   |
| create    | `400` `scope_too_large`                                                       | Throws `FeedScopeTooLargeError` when no `machines` were sent                                                                                       |
| create    | `400` `feed_limit_reached`                                                    | Throws `FeedLimitReachedError`: end a feed first                                                                                                   |
| create    | other `400`                                                                   | Throws (a field error keeps its own code)                                                                                                          |
| create    | `403` `machines_unavailable`, `data_feed_suspended`                           | Throws: a machine outside the key's scope or not the account's (never says which), or a suspended account                                          |
| create    | `401` `invalid_api_key`                                                       | Throws                                                                                                                                             |
| create    | `503` `data_feeds_unavailable`, `feeds_uncountable`, `feed_store_unavailable` | Retried: data feeds are switched off, or the feed store could not be read or written; the API says each is safe to repeat                          |
| create    | anything else                                                                 | Throws, not retried: `429`, other 5xx (a `503` without one of those codes included) or a network error, after which the feed may have been created |
| heartbeat | `200`                                                                         | New tokens and endpoint; the next refresh on the reply's `heartbeat_interval`                                                                      |
| heartbeat | `401` `invalid_feed_token`                                                    | Ends the feed: `unauthorized`                                                                                                                      |
| heartbeat | `403` `feed_withdrawn`, `data_feeds_switched_off`                             | Ends the feed: `withdrawn` (authorization withdrawn, a suspended account included, or data feeds switched off)                                     |
| heartbeat | `404` `feed_not_found`                                                        | Ends the feed: `ended`                                                                                                                             |
| heartbeat | `503` `feed_store_unavailable`, other 5xx, `429`                              | Retried, never terminal                                                                                                                            |
| heartbeat | network error, bad reply                                                      | Retried                                                                                                                                            |
| delete    | `204`, `404` `feed_not_found`                                                 | Done: deleted, or already gone                                                                                                                     |
| delete    | `503` `feed_store_unavailable`                                                | Retried: the feed store is unreachable and nothing was deleted                                                                                     |
| delete    | `429`                                                                         | Retried, when its `Retry-After` is at most 30 s                                                                                                    |
| delete    | `409` `feed_kept_changing`                                                    | Retried once: the record was rewritten on every attempt, which the API asks the client to retry                                                    |
| delete    | anything else                                                                 | `stop()` rejects; calling it again tries again                                                                                                     |

A heartbeat ends the feed on its status alone, so a new `401`, `403` or `404`
code ends it too; the `ended` event's `error.code` says which. Servers older
than the stable codes sent the uncountable create `503` without a code: for
them, and only for them, its exact message is still matched and retried, and
their over-scope `400` is recognised by its message.

The end reasons:

| `reason`       | Cause                                       | What it means                                                          |
| -------------- | ------------------------------------------- | ---------------------------------------------------------------------- |
| `withdrawn`    | heartbeat `403`                             | Authorization was withdrawn and the server deleted the feed            |
| `ended`        | heartbeat `404`                             | The feed no longer exists: deleted, or unwatched past its grace period |
| `unauthorized` | heartbeat `401`                             | The feed token is not valid for this feed                              |
| `stopped`      | `stop()`, or a connection that cannot start | Ended locally                                                          |

Nothing is emitted, and no request or timer runs, after a feed has ended.

### URLs

`baseUrl` must be `https://`, and an endpoint `wss://` or `https://`; plain
`http://` and `ws://` are accepted only for `localhost`, `127.0.0.1` and `[::1]`.
`baseUrl` is checked before any request, and an endpoint before it is used.

## The agent: `scorbit-feed`

```sh
# List what the key covers (uuid, game name, venue), as JSON on stdout.
SCORBIT_API_KEY=sb_live_... npx scorbit-feed machines

# Create a feed; the agent deletes it again when it exits.
SCORBIT_API_KEY=sb_live_... npx scorbit-feed --machines <uuid>,<uuid>
# ...or over everything in the key's scope (a venue-scoped key's feed follows its venues)
SCORBIT_API_KEY=sb_live_... npx scorbit-feed

# Attach to a feed created elsewhere; the agent never deletes it.
SCORBIT_FEED_TOKEN=sbf_... npx scorbit-feed --feed-id f_...
```

Credentials come from the environment only, never from arguments, and are never
logged or served.

| Flag                     | Default                  |                                                           |
| ------------------------ | ------------------------ | --------------------------------------------------------- |
| `--machines <uuid,...>`  | key's whole scope        | Narrow the feed to these machines, in order (create mode) |
| `--feed-id <id>`         |                          | Attach instead of create (needs `SCORBIT_FEED_TOKEN`)     |
| `--transport sdk\|sse`   | `sdk`                    |                                                           |
| `--port <n>`             | `8787`                   |                                                           |
| `--host <addr>`          | `127.0.0.1`              | Anything else exposes the feed to your network            |
| `--static <dir>`         |                          | Also serve your overlay files                             |
| `--cors-origin <origin>` |                          | Allow another browser origin; repeatable                  |
| `--allow-file-origin`    | off                      | Let a page opened from disk read `/state` and `/events`   |
| `--base-url <url>`       | `https://api.scorbit.io` |                                                           |

Routes:

- `GET /state`: `{ status, updated_at, machines }`, the latest state per machine.
  Machines that leave a live feed drop out; the agent logs joins and leaves.
- `GET /events`: Server-Sent Events. `status` events carry `{ status }`; `state`
  events carry the same body as `/state`; `machines` events carry
  `{ added, removed, machines }` when the set changes, just before the `state`
  that carries it. The current status and state are sent on connect.
- `GET /healthz`: `200` while the feed is running, `503` once it has ended. The
  body is `{ ok, status, agent: "scorbit-feed" }`.

Browsers are allowed from `http://localhost` and `http://127.0.0.1` on any port,
and from each `--cors-origin`. Any other `Origin` is refused with `403`.

A page opened from disk (`file://`) sends `Origin: null`. So do sandboxed iframes
on any website, which is why `null` is refused unless you pass
`--allow-file-origin`, and even then it may read only `/state` and `/events`.

While bound to a loopback address (the default), the agent also refuses any
request whose `Host` is not `localhost`, `127.0.0.1` or `[::1]`, which defeats
DNS-rebinding attacks from web pages. With `--static`, only known web file types
are served, never a dotfile (`.env`, `.git/...`), and never anything outside the
directory, symlinks included.

On `SIGINT` or `SIGTERM` the agent stops the feed, deletes it if it created it,
and exits.

## Starter overlay

`templates/overlay/` is a dependency-free overlay that renders the agent's
`/events` stream as one card per machine, keyed by `machine_uuid`: cards are
added, updated in place and removed as machines join and leave a following feed,
and a "No machines in this feed yet" line shows while the feed carries none:

```sh
SCORBIT_API_KEY=sb_live_... npx scorbit-feed --machines <uuid> \
  --static node_modules/@scorbit/feed/templates/overlay
```

Then add `http://127.0.0.1:8787/` as an OBS browser source. The overlay uses its
own origin only when that origin is the agent (it checks the agent's `/healthz`);
opened any other way it reads the agent at `http://127.0.0.1:8787`, or at
`?agent=<http(s) url>`:

- **From disk (`file://`):** start the agent with `--allow-file-origin`. A page
  opened from disk sends `Origin: null`, which the agent refuses by default.
- **From your own web server:** allow that server's origin with
  `--cors-origin <origin>`.

Its connection indicator is a small dot that changes shape as well as colour (a
ring while connecting, filled when live, a dash once ended), and its state is
announced to screen readers through a polite live region.

Copy the folder and restyle it freely.

## Branding and attribution

Scorbit's [developer terms](https://scorbit.io/developer-terms-of-use/) require
visible attribution wherever feed data is displayed. The starter overlay's
attribution slot shows the Scorbit® logo (alt text "Powered by Scorbit"); keep
it visible if you build on it. The logo files and how to use them are in
[`assets/brand/`](assets/brand/README.md); the starter overlay ships one of them,
`scorbit_lockup-horizontal_multi.svg`, whose built-in black strap keeps it
legible over video.

## Development

```sh
npm ci
npm run check   # lint, typecheck, tests at 100% coverage, build, package contents
```

See `CONTRIBUTING.md`. Security reports: see `SECURITY.md`.

## License

The code in this repository is MIT licensed (see `LICENSE`). Access to the Scorbit
data feed itself is governed separately by Scorbit's
[developer terms](https://scorbit.io/developer-terms-of-use/), which include the
branding and attribution requirements above.

The MIT license covers the source code only. SCORBIT® and the Scorbit logo are
registered trademarks of Spinner Systems, Inc. The logo files, in `assets/brand/`
and `templates/overlay/`, are © 2026 Spinner Systems, Inc., all rights reserved:
they are **not** MIT licensed, no trademark rights are granted, and they may be
used only as the developer terms permit. See [`NOTICE`](NOTICE).
