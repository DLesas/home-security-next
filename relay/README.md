# @hsn/relay

The relay program (docs/m4-design.md section 3): one program with the roles `relay`, `push`, `names` and `releases`, on Bun as the hub. This program runs `relay`, or `relay` and `releases`; `push` is its own process under its own account (`src/push/main.ts`, B3's); `names` is not built until a domain exists.

## Running it

```sh
bun relay/src/shell/main.ts --config <path>        # or, in relay/: bun run start --config <path>
cd relay && bun run compile                        # one executable: relay/dist/hsn-relay --config <path>
```

The configuration is a JSON file on the host, not in the repository (`src/shell/config.ts` has its form): the listen address and port, TLS (or a reverse proxy in front, named in `trustedProxies` so its `X-Forwarded-For` counts), the data folder, the roles, the push service's relay-link URL (the push role's local socket on the operated host, `<DEPLOYMENT.push.url>/v1/relay` by default), the release folder, the local socket the push process forwards relay links' release frames to, and a file of refused hub keys. `test/local.json` is the one this Mac's local runs use (port 8480 on every address, files under `/tmp/hsn-relay-local/`).

A relay running the `releases` role can fill its `releases.folder` from one upstream source:

- `"upstream": { "link": true }` uses the authenticated relay link at the configured `push.url` (for example, `wss://push.example.com/v1/relay`). This is also the default with a configured `wss://` push URL when neither an upstream nor a forwarding `releases.socket` is set.
- `"upstream": { "socket": "/run/hsn-relay/releases.sock" }` connects directly to the operated releases role on the same host.

Set `upstream` inside `releases`. A link source requires an explicit `push.url`, and a configuration with both upstream sources is refused. `releases.socket` is the separate listener that serves forwarded requests. The operated service counts upstream downloads against the self-hosted relay's key. Hubs fetching from its cache use that relay's own release budgets.

The data folder holds `relay.db` (SQLite: hubs and their targets, nothing else) and `relay.key` (the relay's own static key, 0600, made at the first start). The log is one JSON line per event on standard error: counts and errors, never an identity, an address or content. SIGHUP reads the refused hub keys again; SIGTERM or SIGINT stops (every phone hears 1001, every hub link closes 1001). Exit codes: 0 stopped, 78 a configuration, key or storage problem, 70 anything else.

## Layout

| Folder | What |
| --- | --- |
| `src/core/` | Pure: the presence core (`presence-core.ts` over the frozen `presence.ts`), D142's layer 1 accounting (`admission.ts`, `rate.ts`, `release-budget.ts`), identities and their retention, the roster rules, the deadline heap, the rule values (`rules.ts`, frozen) |
| `src/shell/` | Bun: the listener (`server.ts`), hub links (`hub-link.ts`), phone streams (`phone-stream.ts`), the relay role around the core (`relay.ts`), storage (`storage/`: Drizzle schema, drizzle-kit migrations, the store), the pseudonym, the relay's key, configuration, the log, `main.ts`; every `try` in `safe/` |
| `src/releases/` | The releases role: the folder's index (`folder-index.ts`, over the frozen `release-index.ts`), the answers to `release.check` and `release.get` (`service.ts`), the local socket the push process forwards relay links' release frames on (`forwarding.ts`), and a self-hosted relay's cache filled from upstream (`upstream.ts`) |
| `src/push/` | The push role (B3's) |
| `test/` | Unit tests of the core (`test/core/`), the relay on loopback with stand-in hubs and phones (`test/*.test.ts`), the load and memory tests (`test/load/`), and B3's (`test/push/`) |

Migrations: change `src/shell/storage/schema.ts`, run `bun run db:generate` in `relay/`, and add the new file to `MIGRATIONS` in `src/shell/storage/migrate.ts` (a test checks the journal and the list agree).

## Frozen by step 0

| File | Frozen |
| --- | --- |
| `src/push/sender.ts` | `PushSender`: the operated relay's side of its relay link to the push service |
| `src/releases/release-index.ts` | The release index: its entries and its interface |
| `src/core/presence.ts` | The pure presence core's types: per-hub state, inputs, outputs |
| `src/core/rules.ts` | The presence clock's values and D142's layer 1 limits |

The wire formats (frames, push items, offers) are `@hsn/protocol/relay`'s. Owners after step 0: B2 (`src/core/`, `src/shell/`, `src/releases/`, `test/`), B3 (`src/push/`), B4 (`src/names/`, last, with a domain).
