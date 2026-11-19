# M4 design: the relay and push

Proposed 2026-11-18, for review before any code is written; revised the same day with the reviewer's rulings and reconciled with [m3-design.md](m3-design.md) (the phone build, Bluetooth pairing, phone-only features) and [m3-updates-design.md](m3-updates-design.md) (firmware updates). It designs milestone M4 of [build-plan.md](build-plan.md), "Relay and push", on top of the hub and web app that M2 built ([m2-design.md](m2-design.md)). This one defines the relay-to-phone wire protocol and the push payload; the other two consume them. Section 13 says what each of the three takes from the others and what does not fit yet. The three share one channel version 2, one sequence of database migrations and one step 0, whose order of work the reviewer writes; section 12 lists what this design contributes to it.

"M2" means a section of [m2-design.md](m2-design.md), "HD" a section of [hub-design.md](hub-design.md), "S4" the report [S4-per-hub-names.md](spikes/S4-per-hub-names.md). D and O numbers refer to [architecture.md](architecture.md); RA, AP, UP and HB numbers to [software.md](requirements/software.md). Values marked ‡ are this design's own provisional choices, each to be set by a measurement or in review. The same mark is on every statement about an outside service (Apple, Google, Let's Encrypt, Bun, Expo, routers) made from memory; section 16 lists those to check before anything depends on them. New decisions are proposed as D125 to D131, and D142 records the product owner's decision on protecting what the operator runs (section 15).

The design in ten lines:

- The relay is one small program with four roles: **relay** (hub and phone links, presence, hub-unreachable alerts), **push** (to Apple and Google), **names** (per-hub names) and **releases** (signed files). The operated service runs all four; a self-hosted relay runs the first and last and sends pushes through the operated push service (D12, D77).
- A hub opens one WebSocket over TLS to the relay and proves its app key in a Noise_XN handshake, so the relay knows it only by that key (D55). Phones open a WebSocket to `/v1/phone/<identity>/<session|link|restore>`; the relay carries their Noise messages one for one, and the hub's existing session layer treats each as a connection on a third listener, `relay`.
- Each phone gives each hub a push key and its push token inside the app channel. The hub seals every push with that key; the relay, Apple and Google see the same envelope for every push, the relay's own alerts included, which the hub seals in advance (D32, D59). That uniform envelope stands only if spike S5 shows the iOS extension can raise a push to critical by itself; section 5 names the fallback, envelope B.
- The relay alerts phones 3 minutes after its last contact with a hub, says so again when the hub is back, keeps silent through an announced restart, and starts its clock afresh when it restarts itself (D64, D96).
- The hub keeps an outbox of pushes raised while the relay cannot be reached, durable as the notification it carries, and sends them marked late when the link returns (D102).
- Releases signed with the publisher's key are fetched over the relay link into the same staging M2 built for files (D84, UP4, D123).
- Per-hub names: the hub claims a random name from the operated name service, runs its own ACME client and checks its router's resolver; D105's direct address stays the fallback (D79, RA11, RA12). Designed here, built last: nothing of names can be proven without a domain, and D105's address already works.
- Everything that depends on the product's name, domain or host is in one file, `packages/deployment/src/deployment.ts`. Until it is filled in, a hub has no default relay, and nothing it does reaches the internet.
- All of it but names can be built now on this Mac against a relay run locally, the real hub, the iOS simulator and the Android emulator, with stand-ins for Apple and Google. Real push needs owner-only steps in the Apple account and a Firebase project; names need the domain and a host; the critical alert and the locked-phone Disarm need real phones (section 14).
- Everything the operator runs is protected against outsiders on the internet (D142, the product owner's decision): the relay limits what it keeps for any peer before that peer proves anything, the host filters floods the program cannot absorb, and the push service sends only for relays that prove their key, within limits per relay and hub. The home side stays as D124 has it. One question stays with the product owner: an outside review of the Noise code (section 15), which also records the reviewer's rulings.

## 1. What M4 builds, and what stays

### The build plan's rows, and where each is designed

| M4 piece | Requirements | Here |
| --- | --- | --- |
| Spike S10 | O15 | Section 5, "Spikes S5 and S10" |
| Relay service, end-to-end encrypted, self-hostable | RA1–RA4, RA7, D12, D55, D59 | Section 3 |
| Push service to Apple and Google, with on-phone decryption | RA9, D32, D77 | Section 5 |
| Hub-unreachable alerts | RA10, D64, D96, D102 | Sections 3 ("Presence") and 5 |
| Per-hub HTTPS names, detection of routers that block them, the direct-address fallback | RA11, RA12, O8, O12, D79, D105 | Section 7 |
| Signed official releases fetched through the relay | UP4, D84, D123 | Section 6 |
| Direct phone-to-hub connection with relay fallback | D56, RA5 | Section 8 |
| The hub's relay client (implied by RA1) | RA1, RA7, D102, D112 | Section 4 |
| Protecting what the operator runs (the product owner's decision) | D142 | Section 3, "Protecting what the operator runs" |

### What does not change

- **The app channel's cryptography.** Sessions stay `Noise_IK`, linking and restore `Noise_XXpsk3`, with the prologues, the `first` request, `seq` and the stored replies of M2 section 5. Through the relay the bytes are identical; the relay is a pipe for them (RA2).
- **The core's shape and rules** (HD 2, M2 section 2): one pure step, modules in a fixed order, the durability classes, the send gate, the loop's 20 ms limit (M2 section 3). M4 adds one module and changes none.
- **Channel version 1.** The hub keeps speaking it. M4's additions are version 2 (section 9); the web app the hub serves speaks 2.
- **What the home needs from the internet: nothing** (RA7). With the relay unreachable the hub, the sirens and the web app at home work as in M2.

### Done when (proposed, for the product owner)

The build plan gives M4 no "done when". Proposed: **a phone away from home, on the operated relay, receives the countdown alert from the real hub with content the relay cannot read and disarms from it while locked; when the hub's link is cut, its phones are told within 3 minutes and told again when it returns, and are not told during an update; and a signed release reaches the hub through the relay and installs.** The same chain is first proven on this Mac with a local relay and stand-ins (section 11, `bun run m4`), which does not wait for any account.

## 2. The configuration point

Everything that depends on the product's name, its domain or its host lives in one new workspace, `packages/deployment/` (`@hsn/deployment`), one file, no dependencies (the reviewer's ruling, in place of the phone design's first `app/product.ts`). The hub, the relay and the app's `app.config.ts` (m3-design section 2) import it; nothing else names a domain, a bundle identifier, an app group or a display name.

```ts
// packages/deployment/src/deployment.ts
/** The product's domain: the one line to change when it is chosen. */
const DOMAIN = "example.invalid";
/** The registrable domain for per-hub names, kept apart from the product's (S4, recommendation 1). */
const HUBS_DOMAIN = "hubs.example.invalid";

export const DEPLOYMENT = {
  productName: "HSN",                                   // the app's display name
  ios: { bundleId: "invalid.hsn.app", appGroup: "group.invalid.hsn.app", teamId: null },
  android: { applicationId: "invalid.hsn.app" },
  relay: { url: `wss://relay.${DOMAIN}` },              // the default relay (RA3)
  push: { url: `wss://push.${DOMAIN}` },                // the operated push service (D77), reached by relay links
  names: {
    domain: HUBS_DOMAIN,
    canary: `rebindtest.${HUBS_DOMAIN}`,                // always a private address (S4 2.4)
    control: `control.${HUBS_DOMAIN}`,                  // always a public address
    acmeDirectory: "https://acme-v02.api.letsencrypt.org/directory", // overridable by the name service
  },
} as const;
```

- **Placeholders that can never reach anyone.** `.invalid` never resolves (RFC 6761). While `DOMAIN` is the placeholder, the hub treats the default relay as **none**: its client stays off and `relay.status` says "no relay chosen". A hub then reaches a relay only when a person sets one (`relay.set`, section 9), which is how this Mac tests against a local relay.
- **Rules, checked by the package's test and by the release build** (`hub/packaging/shared/build-program.ts`, beside `releaseKeysProblem`): a release build refuses a placeholder domain, a placeholder bundle identifier, or a null team; every URL is `wss://` or `https://`; `ws://` and `http://` are accepted only by a hub's own `relay.set` and only for a loopback or private address (local testing: the Android emulator reaches the Mac by its home-network address, m3-design section 2). The bundle identifier and application id are separate lines because they are never shown to users and can be chosen before the name (section 15, QP1).
- **What it does not hold:** secrets. The APNs key, the FCM service account and the relay's TLS key live on the relay's host, in its own configuration (section 3, "Self-hosting").
- **What a name does not change:** protocol labels. `hsn-session/1`, `hsn-link/1`, `hsn-backup/1`, `hsn-release/1` and this design's `hsn-relay/1` and `hsn-push/1` are bytes inside cryptography and never change with the product's name. Nor does the URL scheme `hsn`: it is the protocol's (`hsn://link/1`, `hsn://restore/1`, and the phone design's `hsn://pair/1` on every board's display, which boards in houses cannot change), so it stays in `LINKING` and is not in the configuration (m3-design section 2).
- **What is not one line.** The installers' names and folders ("HSN Hub", `com.hsn.hub.plist`, `_hsnhub`, `%ProgramData%\HSN Hub\`) are M2's and are kept as internal names. Renaming them later means moving installed data folders; section 16 lists it.

## 3. The relay service

### What it is and is not

| It is | It is not |
| --- | --- |
| A pipe for encrypted traffic between phones and hubs that have no public address (D12, RA1) | An account system: no sign-up, no passwords, no e-mail (D12, D55) |
| The one place that can notice a hub has gone quiet, and tell its phones (D64, D96) | A host for the web app: no web traffic passes through it (D31, D105) |
| The hand-off from hubs to the push service (D32, D77) | A store of messages: it queues nothing for a phone; an absent phone gets its pushes from Apple or Google |
| A server of signed release files (D84) | A trust anchor: identities, releases and names are checked by the hub and the phone, never taken on the relay's word |
| (Operated only) the publisher of per-hub names (D79) | A video relay or a NAT traversal service (M7, section 8) |

### Roles

One program, `relay/` (`@hsn/relay`), on Bun as the hub. Its server-side configuration names the roles it runs:

| Role | Does | Operated service | Self-hosted relay |
| --- | --- | --- | --- |
| `relay` | Hub links, phone links, presence and hub-unreachable alerts, push hand-off, D142's layer 1 | yes | yes |
| `push` | Sends to Apple's and Google's services with the publisher's credentials, only for relays that prove their own key, within limits per relay and hub (D142); serves the operated relay and self-hosted relays alike, over a relay link (D77). Runs as its own process under its own account | yes | no: it points at `DEPLOYMENT.push.url` |
| `names` | Per-hub names, their addresses and challenge records (section 7); built in the last wave, once a domain exists | yes | no (D130, section 7) |
| `releases` | Signed files from a folder, or fetched from the operated releases role over a relay link and cached (section 6); served only on authenticated links | yes, from a folder | yes, from the operated service |

Inside, the relay follows the hub's layering: `relay/src/core/` is pure (presence and its clock, limits accounting, the roster rules), with time as an input, tested over simulated days; `relay/src/shell/` holds the WebSockets, SQLite and timers; `relay/src/push/`, `relay/src/names/` and `relay/src/releases/` are the other roles. Message routing and stored state sit behind the two small interfaces stack.md names (in memory and SQLite on one server), so hubs can later be split across servers by identity.

### How a hub is known: by its key (D55)

The hub's identity is the one M2 made: the first 16 bytes of SHA-256 of its app static key, 26 characters of base32 (`appIdentityBytes`, `formatIdentity`). The relay learns it by a Noise handshake in which the hub proves it holds that key, and never from a claim. Nothing else identifies a hub: no account, no address, no token.

**The hub link, `<relay url>/v1/hub`.** One WebSocket over TLS, opened by the hub. Its first three binary messages are `Noise_XN_25519_ChaChaPoly_SHA256` with the prologue `hsn-relay/1`, a zero byte (D125):

| Message | Direction | Noise | Payload, UTF-8 JSON |
| --- | --- | --- | --- |
| 1 | hub → relay | `e` | `RelayHello {proto: [min, max], hub: "<version>"}` |
| 2 | relay → hub | `e, ee` | `RelayWelcome {proto, relay: "<version>", roles: [...], limits: {...}}`, or the socket closes with 4426 when no version is shared |
| 3 | hub → relay | `s, se` | `RelayJoin {}`. The relay now holds the hub's static key, computes its identity, and answers with the first text frame, `joined {identity}` |

- **Why XN.** It proves the hub's static key with the Noise code the hub already has (`startHandshake`, `x25519StaticKey`), so no cryptography is added (M2: "No cryptography beyond Noise is ours"); message 3 depends on the relay's fresh ephemeral key, so it cannot be replayed. The relay has no static key of its own: TLS, with the relay's certificate for its domain, is what tells the hub it reached the right relay.
- **After message 3** the link carries frames in the clear inside TLS: JSON text frames for control, binary frames for data. A second layer of encryption would protect only against someone who breaks TLS, and would force phone messages of up to 65,535 bytes to be cut in pieces to fit inside Noise's own limit. Phone traffic is end to end anyway. Rejected: our own challenge-and-MAC proof (new cryptography), and all frames inside Noise transport (fragmentation for no gain).
- **One link per identity, the newest wins.** Only the key's holder can complete message 3, so a new link of the same identity replaces the old, which is closed with 4001 (`replaced`). A hub whose link is replaced without its own reconnection waits 10 minutes ‡ before trying again and raises the warning `relay_identity_in_use` ("another computer is using this hub's identity; two hubs would both command the sirens"), the relay-side counterpart of M2's mDNS check after a restore.
- **The same static key** serves the hub's IK sessions with phones and its XN link to the relay, under different protocol names and prologues (the reviewer's ruling, QR2). The reviewer's reading of the Noise specification's section on static key reuse is that one key pair may be used with different Noise protocols that use the same hash, and must not be used outside Noise ‡; both of ours use SHA-256, and the key is used nowhere else. The joint step 0 checks the text and records the result with the section's exact number (section 12). If the text says otherwise, the hub gets a second static key for the relay, the hub tells its phones that key's identity in `hub.info`, the relay routes by it, and D55's wording is amended to say a hub has one identity for its phones and one for the relay.

**Text frames on the hub link** (each a JSON object with `t`; schemas in `packages/protocol/src/relay/`, strict):

| `t` | Direction | Body | Answer |
| --- | --- | --- | --- |
| `joined` | relay → hub | `identity` | — |
| `ping` | hub → relay | `n` | `pong {n}` |
| `open` | relay → hub | `stream` (u32, never reused on this link), `path` (`session`, `link`, `restore`), `peer` (section "Phones") | the hub's channel takes it, or `close` |
| `close` | either | `stream`, `code` (the WebSocket close code for the phone) | — |
| `roster` | hub → relay | `rev`, `targets: [{key, platform, env, token, unreachable, back}]` (section 5), the whole set each time, at most 128 KiB ‡ | `rosterAck {rev}` |
| `push` | hub → relay | `items: [{id, key, h}]`, at most 32 a frame ‡ | `pushResult {results: [{id, outcome}]}`, `outcome` one of `accepted`, `badToken`, `limited`, `failed` |
| `restarting` | hub → relay | `reason: "update" \| "restore"`, `withinMs` (at most 600,000 ‡) | `restartingAck` |
| `release.check` | hub → relay | `platform`, `running`, `firmware?` (section 6); one transport for both kinds of file | `release.offer {releases}`, each with its `kind` (`hub` or `firmware`) |
| `release.get` | hub → relay | `id`, `file`, `offset`, `length` (at most 256 KiB ‡) | binary kind 2 with exactly `length` bytes, or `release.error {id, reason}` |
| `name.claim`, `name.addresses`, `name.challenge`, `name.challengeClear` (added when names are built, not in the first freeze, section 12) | hub → relay | section 7 | `name.claimed`, `name.taken`, `name.ok`, `name.error` |
| `limit` | relay → hub | `what`, `retryAfterMs` | — |

**Binary frames on the hub link:** byte 0 is the kind. Kind 1, stream data: a u32 stream number, little-endian, then exactly one Noise message of a phone's connection, either way. Kind 2, a release piece: a u32 request `id`, then the bytes. Anything else closes the link with 4400.

**Close codes on the hub link** (and on relay links, D142): 1001 the relay is stopping; 4001 replaced; 4400 a frame the relay cannot read; 4408 the handshake was not finished in time; 4426 no shared version; 4429 over a limit (the hub waits `retryAfterMs` or 10 minutes ‡).

### Phones, and how a phone finds its hub's session

A phone knows its hub's identity from linking (the QR code's `h=`, M2 section 5) and the hub's relay from one of three places, in this order: the hub's `hub.info` once connected (version 2, section 9); the link QR code's new `r=` parameter, present only when the hub's relay is not the default; otherwise `DEPLOYMENT.relay.url`. It opens, with React Native's own WebSocket, since the relay has a certificate a phone trusts normally (m3-design section 10 assumes exactly this; the phone's own `hub-net` module is only for the hub's self-signed certificate at home):

```text
<relay url>/v1/phone/<identity>/<session | link | restore>
```

The relay asks nothing of the phone (no key, no token) before it carries traffic.

The last part names the handshake as `APP_PATHS` does on the hub's own listeners. The relay checks the identity's form, that the hub's link is up, and the limits; then it sends `open` to the hub and carries every binary message both ways unchanged. It neither reads nor waits for the handshake. A text message from the phone closes it with 1003.

- **No authentication of the phone at the relay.** The phone proves itself to the hub inside Noise, as at home. The relay cannot tell a linked phone from anyone who knows the identity; the hub's session layer refuses anything else, and its limits (`SESSION_LIMITS`: 16 open handshakes, rates per address) apply to relayed connections as to the home network's.
- **The peer.** The hub's limits count by address. The relay gives each phone connection a pseudonym: `relay-` and the first 8 bytes, in hex, of HMAC-SHA256 of the phone's IP address under a secret the relay makes at start and replaces daily ‡, never stored. The hub uses it as the connection's address, so one flooding source is limited without the hub learning phones' addresses.
- **Typed codes do not work through the relay.** A typed code carries no identity (M2 section 5), so the phone cannot name the hub. Linking away from home uses an invite's QR code or link (D99), which carries it.

**Close codes to the phone:** 1001 the relay is stopping; 1003 a text message; 1009 a message over 65,535 bytes; 1013 the hub's channel refused the connection (its `admit` answered 503: try later); 4400 a malformed path or identity; 4404 the hub is not connected; 4410 the hub's link closed during the stream; 4429 over a limit. Closes the hub makes (1000, 1008 and M2's `CLOSE` codes 4000 to 4004) are passed through unchanged in `close {stream, code}`. A stream with no message either way for 90 s ‡ is closed with 4410; the hub's encrypted `ping` every 20 s keeps a live one open.

### Presence: the hub-unreachable alerts (D64, D96)

The relay keeps, per hub, its last contact (any frame on an authenticated link), its state (`online`, `quiet`, `alerted`) and a grace end. The rules, in the relay's pure core:

| When | The relay |
| --- | --- |
| A frame arrives | last contact = now; state `online`. If it was `alerted`, it first sends the `back` push to every target |
| No frame for 75 s ‡ | closes the link; state `quiet` |
| 180 s after last contact, past the grace end, not `alerted`, with targets | sends the `unreachable` push to every target; state `alerted`. Once per outage |
| `restarting {withinMs}` | grace end = now + min(`withinMs`, 10 minutes ‡); answers `restartingAck` |
| The relay starts | every hub not `alerted` gets last contact = the start time (D96: "a restarted relay starts its 3-minute clock afresh"); `alerted` ones stay so, and get `back` when they return |

The hub pings every 30 s ‡, so a link that dies is noticed by the relay within 75 s and the alert goes 180 s after the last frame, as D96 asks. If an announced restart has not come back by the grace end, the alert goes at once, since more than 3 minutes have passed. The wording and the phone's side are in section 5.

### Protecting what the operator runs (D142)

The product owner's decision of 2026-11-18: everything the operator runs and is answerable for is protected against outsiders on the internet. That is the relay role, the push service, the releases role, the names service when it is built, and the operator's keys (the APNs key, the Firebase credentials, the push service's own key, the relay's TLS key, and the use of the publisher key). The owner's home network and hub computer stay as D124 has them; nothing here adds work on the home side. Protection has two layers: what the relay program does itself, and what only the host or a network in front of it can do.

#### Layer 1: what the program does itself

Every value is ‡, set first from a measurement of memory and processor time per connection on the chosen host, then from running costs (D55). Passing one is answered, never silent: `limit` to a hub or relay, 4429 to a phone, `limited` for a push. An address means an IPv4 address or an IPv6 /64 ‡.

| Measure | Value ‡ | At the limit |
| --- | --- | --- |
| **Before any state is kept:** a per-address check at the HTTP upgrade (`server.requestIP` before `upgrade`), so a refused peer gets no WebSocket, no Noise state and no X25519 | Hub and relay link upgrades 10 a minute per address; phone stream opens 30 a minute per address; all link handshakes 500 a second in all | HTTP 429 or 503, nothing kept |
| Unauthenticated links (an XN handshake not finished) | At most 4 per address and 2,000 in all; message 3 within 10 s; one message queued | Closed with 4429, or on timeout with 4408 |
| Authenticated hub links | At most 8 per address; 20,000 in all | New ones refused with 4429; an established link is never closed to make room |
| Phone streams | 16 per hub, 8 open per address, 40,000 in all | 4429 |
| New hub identities (keys cost nothing to make, so each new identity is a row someone could make for free) | 3 a day per address; 500 an hour in all; 200,000 stored | `limit {what: "newIdentity"}`; at the stored cap, new identities are refused and the operator is alerted, existing hubs are untouched |
| Identities that never settle | An identity is established once it has connected on 3 different days; one that is not is deleted after 7 days without contact (an established one after 90, as above) | — |
| Memory per connection | A phone message at most 65,535 bytes, one in hand at a time; data waiting to be sent at most 256 KiB to a phone and 4 MiB to a hub link; a roster at most 128 KiB; the rate tables at most 200,000 addresses, the oldest dropped, and when full every unknown address shares one strict bucket | A reader too slow to take its data is closed (4429), so a slow client cannot hold memory |
| Slow clients | An idle phone stream 90 s; a silent hub link 75 s; an unfinished handshake 10 s; release pieces only as the hub asks for them (it pulls, so nothing piles up) | Closed |
| Traffic through the relay | 500 MB of stream bytes per hub per day | New streams refused until midnight UTC |
| Pushes | 60 per hub per 10 minutes and 1,000 a day, counted per relay key and hub identity together; 10,000 a day per relay key, more for the operator's own relay; a ceiling for the whole service set below Apple's and Google's quotas ‡, with the operator alerted at 80% | `limited` |
| Releases (bandwidth costs money) | Only on authenticated links, never on a public address; 3 downloads per file per identity per day; 3 whole files per address per day, whatever the identity; 10 files per relay key per day; a daily egress budget for the whole service set below the host's allowance (100 GB ‡) | `release.error {reason: "limit"}` with when to retry |
| Names (when built) | One name per established identity; 20 updates a day; only private addresses; a cap on records in the zone | `name.error` |

#### Layer 2: what must come from the host or the network in front of it

A flood measured in gigabits a second fills the server's link before the program sees a packet, and a flood of TLS handshakes costs processor time before any limit above can run. No program absorbs those. The host must provide:

- **Always-on filtering of volumetric attacks** at the network and transport layers, without the operator having to act, of at least 10 Gbit/s ‡ (the level hosts commonly include).
- **Long-lived WebSockets** through it: hub links stay open for days.
- **The client's own address** passed to the relay (direct, or by the PROXY protocol ‡), or layer 1's per-address limits count the filter, not the attacker.
- IPv4 and IPv6, in the EU (stack.md), with a monthly traffic allowance of at least 3 TB ‡, and either a hard cap or an alert on going over it, so a flood cannot become a bill.

Kinds of option, without choosing a vendor:

| Kind | Rough monthly cost ‡ | Notes |
| --- | --- | --- |
| A server from a host that includes always-on network filtering in the price | €5 to €60 | Enough for this size; the usual first choice |
| A proxy or anycast protection service in front that carries WebSockets | free tiers to €20–€250 | Larger floods; if it ends TLS, that company sees link metadata (never content, which is end to end) |
| A cloud provider's managed protection tier | thousands | Not needed at this size |

#### The push service accepts only hubs and relays that prove themselves

- **Relay links.** The push service accepts items only over an authenticated relay link. Every relay, the operated one included, reaches it over `/v1/relay`: the same XN handshake as a hub link, in which the relay proves its own static key, made at its first start and kept in its data folder (prologue `hsn-relay-peer/1`). As on a hub link, the responder has no static key in XN: the relay knows it reached the push service by TLS, with the certificate for `DEPLOYMENT.push.url`'s name, and the operated relay reaches it through a local socket only its account can open. So the push service holds no key of its own beyond that TLS key.
- **Items.** Each item names the hub identity the relay authenticated on that hub's link, with the target in the clear as the hub's roster gave it (`{id, hub, platform, env, token, h}`): the relay sees push tokens, as D59 accepts. The push service limits by hub identity, by relay key, by address and in total, and the operator can refuse a relay key. **The per-hub limits are counted per relay key and hub identity together:** the push service cannot check that a self-hosted relay really authenticated the hub it names, so a hostile relay naming a real hub's identity spends only its own share of that hub's quota, never the share the hub's own relay uses. The same link carries `release.check` and `release.get` for a self-hosted relay's cache.
- **So** someone who holds a phone's token can send to it through a relay of their own, within the limits, what the phone cannot open, since the content is sealed for the phone by its hub (D126): on Android nothing is shown, since the app's own code posts nothing it cannot open; on an iPhone the placeholder shows, unless the filtering entitlement (AS5) lets the extension drop it.

#### The operator's keys

| Key | Kept | If taken |
| --- | --- | --- |
| APNs key, Firebase service account | Only on the push service's host, in files readable only by the push role's own account, outside the program's folder, never in an image, a backup of the repository, or a log | Revoked in the Apple account or Google's console and replaced ‡; until then the taker could push only with targets they hold |
| The relay's and the push service's TLS keys | Each its own account | The taker could stand in the middle of links and read push tokens and rosters; phone traffic stays end to end, push content sealed for the phone, hub and relay keys proved by XN |
| The publisher key (D123) | **Never on an operator's host**: releases are signed off the host (`make-release.ts`) and only signed files are copied there | A taken host can withhold releases or offer old ones; a hub refuses an older hub release (`notNewer`), and an older firmware is fetched only when a person picks it (section 6) |
| The DNS provider's token (names, when built) | As the APNs key, limited by the provider to the hub-name zone | Records in that zone only |

The host itself is reached by SSH keys only, runs the relay and the push service as two accounts with a local socket between them, and takes security updates automatically ‡. That is operations, listed so QP6 can cost it.

#### What an outsider could do to each thing the operator runs

| Target | What an outsider could try | What stops it | What is left |
| --- | --- | --- | --- |
| The relay's link and processor | A volumetric flood; a flood of TLS or Noise handshakes | Layer 2; layer 1's checks before state and the global handshake rate | A flood larger than the host filters takes the relay down; while it is down no phone is told anything (QP6's uptime check tells the operator) |
| The relay's memory | Many connections, slow readers, huge messages, many addresses in the rate tables | Caps per address and in all, bounded buffers, slow readers closed, bounded tables | New connections refused at the caps; established hub links keep working |
| The relay's storage | Endless new hub identities; huge rosters; names | New identities limited per address and in all, a stored cap, unsettled identities deleted after 7 days; rosters ≤ 128 KiB; one name per established identity | A large, many-address effort can reach the stored cap, refusing new hubs until the deletes catch up; the operator is alerted |
| Pushes to someone else's phone | Getting the relay to push to a token the outsider does not own | The operated relay pushes only targets in the roster of a hub authenticated on its own link; a push's content is sealed for the phone (D126) | Someone who learns a token elsewhere can send, through a relay of their own, what the phone cannot open: nothing on Android, the placeholder on an iPhone without AS5 |
| The push service as an open sender | Sending through it directly | Only authenticated relay links (XN); limits per relay key and hub identity together, per relay key, per address and in all; the operator can refuse a relay key | A stranger with fresh keys can push only to tokens they hold, within the limits; a hostile relay naming a real hub spends only its own share of that hub's quota |
| Hub identities | Claiming or squatting one, or knocking a hub off | An identity is a key's hash and only its holder completes XN; "newest wins" needs the key; names are tied to an established identity | Nothing for an outsider; identities are free to make, which the storage row bounds |
| Releases and bandwidth | Fetching at a rate that costs money | Authenticated links only; per identity, per address and per relay key limits; a daily egress budget; layer 2's allowance cap | A many-address effort can spend the daily budget, after which hubs wait a day for downloads; the cost is capped |
| Phone streams to a hub | Using up a household's remote slots | The relay's per-address limits and the hub's own (M2) | Someone who knows a hub's identity can make a household's phones wait; identities are not published |
| The operator's keys | Taking them from the host | The table above | A compromise of the host itself; keys are then revoked and replaced |

This is the whole of D142's work: it protects the service and its users' ability to use it, and adds nothing on the home side.

### What the relay stores, for how long, and what it can see (D59)

| Data | Where | Kept |
| --- | --- | --- |
| Each hub's identity, first seen, days seen, last contact, presence state, grace end | SQLite `hubs` | until 90 days ‡ without contact (7 days for an identity not yet established, D142), then deleted with its targets |
| Push targets: the phone's key id, platform, environment, token, and the hub's two sealed alerts | SQLite `targets` | until the hub's roster drops it, the push service reports the token refused, or the hub's row goes |
| A self-hosted relay's own static key (relay links) | its data folder | for the relay's life |
| Names: name, identity, home-network addresses (names role) | SQLite `names` and the DNS zone | until 90 days ‡ without an update; challenge records for minutes |
| Release files and their index (releases role) | a folder | until the operator removes them |
| Rate counters, the pseudonym secret, open streams | memory | the day, or the connection |
| The relay's log | standard error, to the host's journal | counts and errors only: no identity is logged together with an IP address, and no content |

Nothing else is stored. The push service stores nothing: it holds the publisher's credentials and its TLS key, read from files at start, and its rate counters in memory.

| The relay can see | The relay cannot |
| --- | --- |
| Each hub's identity and internet address; each phone's internet address (in memory only) | Read or alter anything a phone and its hub say (RA2): every request, reply, event and notification is inside Noise or sealed for the phone |
| When phones connect, how long, how many bytes | Tell an arming from a disarm, an alarm from a schedule, or one push from another: every push is the same size and envelope (section 5) |
| How many phones a hub has, their push tokens, when a push is sent (D59 accepts this) | Pretend to be the hub to a phone: IK pins the hub's key from linking |
| Which release a hub fetches, so which version it runs | Give a hub a forged release: the hub checks the publisher's signature (section 6) |
| A hub's home-network addresses, with the names role (D79) | Learn whether the home is armed: the phone decides how loud the unreachable alert is (D96) |

What it can do against a hub: drop or delay traffic, withhold a release, send a hub's sealed `unreachable` or `back` at the wrong time. Each makes the relay useless, which a hub owner sees, but none lets it act in the home. D59's text names "encrypted traffic, its timing and the phones' push tokens"; section 16 proposes it name the rest of this table.

### Self-hosting (D12, D77, RA3, RA4)

- **The program.** One executable (`bun build --compile` ‡) and a Docker image, as stack.md has it; no Redis, no outside database. Its own configuration (a JSON file on the host, not in the repository): listen address, TLS certificate and key (or a reverse proxy in front), data folder, roles, the push service's URL or the push credentials, the release folder or upstream URL, the name zone's provider.
- **A self-hosted relay** runs `relay` and `releases`. It opens a relay link to the operated service (`<push url>/v1/relay`, D142) and sends there `push {items: [{id, hub, platform, env, token, h}]}`, answered `pushResult` as on a hub link (D77), and fills its release cache with `release.check` and `release.get`. It runs no name service (section 7), so its hubs use D105's direct address.
- **Pointing a hub at it** is the web app's relay setting (`relay.set`, *manage system*). The hub tells its phones (`hub.info`, and `r=` in new link codes), so they follow.
- **A fully self-hosted system**, with its own push service, needs its own build of the phone app with its own Apple and Google credentials (D77). Such a builder changes `packages/deployment/` and nothing else.

## 4. The hub's relay client

### Where it sits

| Layer | What | Owner (section 12) |
| --- | --- | --- |
| Core: a new module `relay`, in `step.ts`'s order as the joint step 0 places it (it must come after `people`; below) | Relay settings, push targets (tokens, never keys), the push outbox, the link's state as the shell reports it, what each push says; the `relay_*` and `push_*` decisions | B5 |
| Shell: `hub/src/shell/relay/` | The WebSocket, the XN handshake, frames, keepalive and back-off; relayed streams into the app channel; sealing pushes; the roster; fetching releases; announcing a restart | B6 |
| Shell: `hub/src/shell/app/` | `AppListener` gains `"relay"`; a relayed stream is a connection like any other | B6 (the folder passes from A2 for M4) |
| Ports: `hub/src/ports/push-keys.ts` (new) | The phones' push keys, as `LinkSecrets` holds link keys: loaded at start, changed by the core's `pushKey` effect, never in the core's slice | step 0 |

The module's place: it acts on `notificationRaised` (from `notify`) and on the people module's `clientRemoved`, and its own decisions reach `notify` in a later turn of the step's queue (HD 2), so it may sit anywhere after `people`; either way a notification and its push are in one step. `upkeep`'s update decisions and the updates design's `firmware` module need nothing from it: the restart announcement is the shell's (below), and offered firmware reaches `firmware` as `releaseOffered` (section 6).

```ts
type HubEvent =
  | …                                                              // M2's, unchanged
  | { kind: "relayLink"; state: "up" | "down"; url: string; reason?: RelayDownReason }
  | { kind: "pushResults"; results: readonly { id: number; outcome: PushOutcome }[] }
  | { kind: "releaseOffered"; releases: readonly ReleaseOffer[] };  // section 6

type Effect =
  | …
  | { kind: "relayConnect"; url: string | null }                   // at boot and when the setting changes; null: off
  | { kind: "relayRoster"; rev: number; targets: readonly RosterTarget[] }
  | { kind: "pushSend"; id: number; client: ClientId; content: PushContent } // the shell seals and sends
  | { kind: "pushKey"; client: ClientId; keyId: Uint8Array; key: Uint8Array | null };

type FileWork = | … | { kind: "fetchRelease"; release: "hub" | "firmware"; file: string; bytes: number; sha256: Uint8Array }; // section 6
type AppListener = "lan" | "console" | "relay";
```

### Connecting, back-off, keepalive

- **Connecting.** On `relayConnect {url}` the shell opens `<url>/v1/hub` with Bun's built-in WebSocket client, runs XN as the initiator with the hub's app static key, and on `joined` gives the core `relayLink {up}`. The core answers with the roster and any pushes waiting (below); the shell sends `release.check`.
- **Back-off.** After any failure (DNS, TCP, TLS, a closed link, no `pong`): 1, 2, 4, 8, 16, 32 s, then every 60 s ‡, each ±20% ‡, reset once a link has lasted 60 s. The cap stays well under 3 minutes, so a relay that restarts finds its hubs back inside its fresh clock. After `limit`, 4426 or `replaced`: `retryAfterMs` or 10 minutes ‡. A change of the computer's addresses (the shell checks every minute for `hubFacts`, M2) reconnects at once and resets the back-off.
- **Keepalive at low cost (D112).** One `ping` text frame every 30 s ‡ and its `pong`, about 100 bytes each way; no `pong` within 15 s ‡ closes the link and reconnects. Nothing about keepalive reaches the core or the database: the core hears only `up` and `down`.
- **Records.** The core counts the link's ups and downs and writes one `relay_link` hub event (info, routine) per hour in which any happened (`{ups, downs, longestDownMs}`), so a flapping link costs no commits. After 180 s ‡ down it records `relay_unreachable` (a warning, written now, once per outage), notified to people with *manage system* and the console in the `hub` category, to open sessions only, since pushes cannot leave: "This hub cannot reach the relay: phones away from home get no alerts". `relay_reachable` (info) when it is back.

### Relayed streams in the app channel

The shell turns each `open {stream, path, peer}` into a connection of the existing `AppChannel` (`hub/src/shell/app/channel.ts`): `admit(peer, path)`, then `open(ticket, socket, "relay")` with a `ChannelSocket` whose `send` writes a kind 1 frame and whose `close(code)` sends `close {stream, code}`; each kind 1 frame is `receive(conn, bytes)`; the phone's `close` is `closed(conn)`. A refused `admit` answers `close {stream, 1013}`. When the relay link drops, every relayed connection is closed (`clientClosed {reason: "remote"}`). What changes in the channel is one value, `"relay"`: a console client is refused on it as on `"lan"` (the refusal reason `consoleOnLan` becomes `consoleNotLocal`), and `Host` and `Origin` checks, which belong to HTTP, do not apply, since no HTTP reaches the hub from the relay.

### The outbox (D102)

- **Raising.** On `notificationRaised {notification, clients}`, for each of those clients that is a phone with a valid push target, the module adds an outbox row and, when the link is up, emits `pushSend`. A notification's own class decides its row's: written now for critical notifications and warnings, which are "now" commits already (M2 section 3), routine for the rest. So the outbox adds no commit of its own.
- **Sending.** `pushSend {id, client, content}`: the shell seals `content` with the client's push key from `PushKeys` and sends it in the next `push` frame of the turn. `content.delayed` is true when it is sent more than `HubRules.notify.delayedAfterMs` (60 s) after the notification was raised, and the phone then says when it happened and that it was late (D102).
- **Results.** `accepted` deletes the row (routine). `badToken` deletes the client's rows, marks its target invalid (written now) and sends a new roster; the phone registers again at its next session (section 9). `limited` and `failed` retry after 1, 5 and 15 minutes, then every 15 minutes ‡. A row older than 7 days ‡ is dropped with a `push_dropped` hub event (info, routine).
- **When the link returns,** every row waiting is sent in order, but per phone only every critical one and the newest 10 others ‡; the rest stay unread in the app (M2: unread notifications of the last 7 days). Delivery is at least once; the phone drops a repeat by its hub and `seq`.
- **Durability, in one line:** what M2 commits now (countdown, alarm, warnings) is never lost by a restart and is pushed after it; routine notices may be lost with the last five minutes, as their notification rows already are.

### Announcing a restart (D96)

A switch the hub itself makes, an update's (`switchUpdate`) or a restore's (`switchRestore`), first calls the relay client's `announceRestart(reason)`: it sends `restarting {reason, withinMs: 600000}` ‡ and waits up to 2 s ‡ for `restartingAck`, then the switch goes on as M2 built it. With the link down it sends nothing: the relay is already counting. Not announced, on purpose: a package upgrade by the installer, which usually returns within the 3 minutes anyway, and a stop of the service, after which the home is not protected and the alert is right.

### New tables (in the next migration of the shared sequence)

| Table | Columns | Key | Class |
| --- | --- | --- | --- |
| `relay_settings` (`relay`) | `url` (null: the deployment's default, which is "none" while it is a placeholder), `revision` | single row | now |
| `push_targets` (`relay`) | `client_id`, `key_id` blob(8), `platform` (0 APNs, 1 FCM), `environment` (0 production, 1 development), `token`, `registered_ms`, `invalid_ms` | `client_id`: one per phone | now |
| `push_keys` | `client_id`, `key` blob(32). Kept apart as `link_secrets` is | `client_id` | now |
| `push_outbox` (`relay`) | `id`, `notification_seq`, `client_id`, `created_ms`, `attempts` | `id` | its notification's class; deletes routine |

Removing a client deletes its target, key and outbox rows in the same commit and sends a new roster. Backups (M2 section 9) gain `relay_settings` only. They do not hold `push_targets` or `push_keys`: a push target is a phone's address at Apple or Google and a push key is a secret shared with one phone, and neither belongs in a file that leaves the hub. After a restore each phone registers again at its next session, and until then that phone gets no pushes (ruling of 2026-11-19, `m3-m4-plan.md`).

Names add, in a later migration when they are built (section 12): `hub_keys` (the shell's) gains `hub_name`, `acme_account_private`, `name_tls_private` and `name_tls_certificate` (section 7), and backups then carry `hub_name`, so a restored hub keeps its name.

**Write budget.** With 4 phones and M2's 70 notifications a day: about 280 outbox inserts and 280 deletes a day, all routine, about 0.05 MB of WAL ‡; registrations a few a month. The budget test (HD 11, M2 section 10) adds them and must show no new commit.

## 5. Push

### The path

```text
hub: notification → outbox → seal with the phone's push key ──▶ hub link: push {id, key, h}
relay: key → token (from the roster) ──▶ relay link ──▶ push service: checks the relay's limits for that hub
push service ──▶ Apple (APNs) or Google (FCM) ──▶ phone
phone: extension or service decrypts h → shows the text, sound and Disarm button
```

### Push keys and registration (D126)

1. The phone gets its push token from the system (an APNs device token, or an FCM registration token) ‡.
2. For each hub it makes a push key (32 random bytes) and a key id (8 random bytes), and keeps both where its notification code can read them (section 13).
3. In the app channel it sends `push.register {platform, environment, token, keyId, key}`, a change with `seq` (section 9). The hub writes `push_targets` and `push_keys` now, removes `key` from the `commands` row as it removes every secret field (M2 section 4), emits `pushKey`, and sends the relay a new roster.
4. The phone registers again whenever its token changes, at a new link, and when the snapshot's `push` says the hub holds no valid target for it; it makes a new key at least every 30 days ‡.

Rejected: sealing to the phone's Noise static key. It would put the phone's identity key, the one that lets it act on the hub, into the notification extension's storage, and would need X25519 and HKDF in Swift and Kotlin; a symmetric key needs one primitive there, and leaking it lets someone read pushes, not act. Rejected: the hub making the key, which would put it in `client_replies`, kept in the database with every stored reply.

### The sealed payload, `h` (the format this design owns)

```text
h = "1." keyId (16 hex) "." base64url( nonce (12 bytes) ‖ ChaCha20-Poly1305(key, nonce, aad, padded) )
aad    = the ASCII bytes "hsn-push/1", a zero byte, the key id (8 bytes)
padded = the UTF-8 JSON of PushContent, a byte 0x80, then zero bytes up to 1,280 bytes ‡
```

- The nonce is random, from the shell's generator: one key seals far fewer than the 2³² messages at which random 96-bit nonces become a concern, and the key is replaced every 30 days ‡.
- Every push is 1,280 bytes of plaintext, so `h` is always 1,763 characters: the relay, the push service, Apple and Google cannot tell one kind from another by size. The core refuses to build content longer than 1,279 bytes; names are at most 64 characters (M2's `displayName`), so a real notification fits with room.
- The phone opens it, removes the padding (the last 0x80 and the zeros after it), checks the JSON against the schema, and drops it if its hub and `n.seq` were already shown.

```ts
interface PushContent {                    // packages/protocol/src/relay/push.ts, Zod strict
  v: 1;
  hub: string;                             // the hub's identity, 26 characters
  n: {                                     // the NotificationObject fields, without `read` and `delayed`
    seq: number; atMs: number; clockOk: boolean; kind: string; category: NotificationCategory;
    critical: boolean; device: number | null; cause: number | null;
  };
  delayed: boolean;                        // D102: sent more than 60 s after it was raised
  names: { device?: string; person?: string; client?: string; mode?: string; schedule?: string };
  detail?: Record<string, string | number | boolean>; // the values the kind's text needs
  actions: readonly ("disarm" | "armAway")[]; // the buttons: "disarm" when this person may disarm the trigger (D76),
                                           // or a presence offer's one action (m3-design section 6); at most one
  armed: boolean;                          // any sensor armed when it was raised (D96, O15)
}
```

The phone writes its text from `n.kind` with its translation files (D58), so no text crosses the relay and a new kind an older phone does not know shows as "Something happened at home. Open the app to see it." ‡. `armed` keeps the phone's copy of "the home is armed" current from every push it gets (O15); section 16 notes what that leaves out.

### The relay's own alerts, sealed by the hub (D127)

The roster gives the relay, for each target, two `h` values the hub sealed in advance: `unreachable` (content kind `hub_unreachable`) and `back` (`hub_back`), each with `n.seq` 0 and no time, made again whenever the roster is sent. The relay sends one of them as it would any push. So every push on the wire has the same envelope, the relay needs no key, and the phone can tell its own hub's alert from noise. The phone takes the alert's time from its arrival: unreachable since about 3 minutes before.

**Wording** (English, in the app's translation files; the phone decides how loud):

| Push | Title | Text | Loud |
| --- | --- | --- | --- |
| `hub_unreachable` | "Home hub cannot be reached" ‡ | "No contact since about {time}. Alerts from home will not reach this phone until it is back. It may be the home's internet or the hub itself." ‡ | A critical alert only if this phone last saw the home armed (D96); otherwise an ordinary notification |
| `hub_back` | "Home hub is back" ‡ | "In contact again. Alerts reach this phone as usual. Anything that happened meanwhile follows, marked late." ‡ | Ordinary |

**Timing**, from the hub's last frame at time t: the relay closes a silent link at t + 75 s, sends `unreachable` at t + 180 s, and the phone shows it as soon as Apple or Google deliver it, usually within seconds ‡. Delayed notifications follow `back`, each marked late.

### To Apple and Google (the push service)

| | APNs ‡ | FCM ‡ |
| --- | --- | --- |
| Endpoint | HTTP/2, `api.push.apple.com`, or `api.sandbox.push.apple.com` for `environment: development` | `POST https://fcm.googleapis.com/v1/projects/<project>/messages:send` |
| Authentication | A JWT (ES256) from the publisher's APNs key, its key id and the team id, refreshed every 40 minutes | An OAuth access token from the service account's JWT (RS256) at Google's token endpoint, scope `firebase.messaging` |
| Request | Headers `apns-topic: <bundle id>`, `apns-push-type: alert`, `apns-priority: 10`, `apns-expiration: now + 24 h ‡`; body `{"aps": {"alert": {"loc-key": "push.placeholder"}, "mutable-content": 1, "sound": "default"}, "h": "…"}` (no title and no app name, as the phone design's rule 9 for notifications has it) | `{"message": {"token": "…", "data": {"h": "…"}, "android": {"priority": "HIGH", "ttl": "86400s"}}}`: data only, so the app's own code runs before anything is shown |
| Outcomes | 200 `accepted`; 410, or 400 `BadDeviceToken`, `badToken`; 429 `limited`; 5xx and timeouts `failed` | 200 `accepted`; 404 `UNREGISTERED` or 400 `INVALID_ARGUMENT` on the token, `badToken`; 429 `limited`; 5xx `failed` |

- The placeholder's text is the app's own (`loc-key`), shown only if the extension fails: "Open the app to see this alert." ‡.
- No collapse identifier: it would be on the wire, readable by Apple. An alarm replaces its device's countdown notification on the phone, which removes the shown countdown when the alarm for the same hub and device arrives ‡ (the phone design asked for a collapse identifier; section 13).
- The push service is the `push` role, its own process under its own account; every relay reaches it over a relay link, the operated relay through a local socket, self-hosted ones over the internet (section 3, D142). `PushSender` is the operated relay's side of that link. It signs JWTs with `node:crypto` and needs no library. APNs needs HTTP/2: whether Bun 1.4.2's `node:http2` client is sound for it is checked in one day beside step 0 ‡, and the reviewer decides on its result (QR5); if not, the `push` role alone runs on Node, which D94's seams allow.

### If S5 fails: envelope B

D126 and D127's uniform envelope stand **only if S5 step 2 shows that the iOS extension can raise an ordinary push to a critical alert by itself** (with the entitlement, once granted). If it cannot, envelope B applies. It is named here so that nobody has to design it under pressure:

- **What changes on the wire.** Each `push` item gains `class: "critical" | "ordinary"`, set by the hub from `n.critical`. The push service sends a critical item to APNs with `"interruption-level": "critical"` and `"sound": {"critical": 1, "name": "default", "volume": 1.0}` in `aps` ‡, an ordinary one as above. FCM does not change: Android's own code posts the notification, so its data messages stay uniform. The content stays sealed (D126).
- **The relay's alerts.** The roster's `unreachable` is sent as critical, `back` as ordinary. The relay cannot choose by the home's state, which it must not learn (D59), so on an iPhone the hub-unreachable alert is always loud, O15's stated fallback, unless S5 shows the extension can lower a critical push it was given, which would restore D96's rule.
- **What the relay, the push service and Apple then learn:** which pushes to iPhones are critical, and so when a home has a countdown, an alarm, a cover opened while armed, a device or siren silent while armed, or jamming while armed, with their times; not which of these, nor which device, since the size stays the same. Google learns nothing new.
- **What it costs:** one field on `push` items, one branch in the push service, nothing on the phone but not raising. **What changes in the documents:** D59's text gains "which pushes to iPhones are critical"; D96's "only when the phone last saw the home armed" holds on Android and not on iOS; D127 keeps its sealed content but loses its uniform envelope on iOS.

### On the phone, and what it needs from Apple and Google

The phone side is the phone design's to build: its own module `app/modules/push/` holds the Swift extension, the Kotlin messaging service and their config plugin (m3-design section 6, owner P1). What this design requires of it:

- **iOS.** A notification service extension in Swift: it finds the hub and key by the key id in storage shared with the app (an app group and keychain access group ‡), opens `h` with CryptoKit's `ChaChaPoly` ‡, writes the text, sets the interruption level and sound (critical for `n.critical`, and for `hub_unreachable` when `armed` was last true), attaches the category with the action `actions` names, and stores `armed` and the last `seq`s; the app also stores `armed` on every `arming` event while it is open (m3-design section 6). It has about 30 s and little memory ‡. The Disarm action runs without unlocking (D51, D63: an action without `authenticationRequired` ‡); the phone design starts the app's JavaScript in the background for it ‡, which sends `disarm {target: "mine"}` as `first` of an IK session through whichever path answers, one and a half round trips (M2 section 5). If S5 shows the JavaScript does not start in time, the phone design puts the choice to the product owner: a Disarm that opens the app, or a native one.
- **Android.** A data message at high priority wakes the app's messaging service even when the app is in the background ‡ (not after a force stop ‡); it opens `h` with `javax.crypto`'s ChaCha20-Poly1305 (API 28 and later ‡) and posts the notification itself: critical ones on a channel that bypasses Do Not Disturb, which the person must allow ‡, with an alarm sound. `POST_NOTIFICATIONS` is asked at run time (API 33 and later ‡).

**Steps in the Apple developer account, which only the owner can do:**

| # | Step | Needs the name? | Unblocks |
| --- | --- | --- | --- |
| AS1 | Register the app's identifier (bundle id) with Push Notifications; the extension's identifier; an app group | the bundle id only (QP1) | real APNs to the simulator; every later step |
| AS2 | Make an APNs authentication key (.p8); note its key id and the team id. Kept by the product owner, put only on the push service's host ‡ | no | the push service against real APNs |
| AS3 | Ask Apple for the Critical Alerts entitlement for that bundle id. Apple decides, and it takes time ‡ | the bundle id | critical alerts (D92, AP9); S10 |
| AS4 | Turn on Time Sensitive Notifications for the identifier ‡ | no | the fallback loudness while AS3 waits |
| AS5 | Optional: ask for the notification filtering entitlement ‡, which lets the extension drop a push it cannot open | the bundle id | iPhones drop pushes they cannot open (section 3, D142) |
| AS6 | Developer ID Application and Installer certificates, and notarization credentials, for the macOS `.pkg` (D119 waits for this account). The certificate shows the account holder's name to people who install ‡ | no | a signed installer |
| AS7 | Later: a real iPhone registered; the App Store Connect record; TestFlight | the name, for the store record | S10, release |

**From Google:** a Firebase project, with the Android app's application id, its `google-services.json` for the build, and a service account key for FCM, kept like the APNs key (QP3).

### Spikes S5 and S10

**S5 has not been run: there is no report in `docs/spikes/`.** The build plan lists it ("while boards ship") and nothing depends on its result yet; this design does, on the points below. It is run first, beside step 0 (section 12), on this Mac, by B3 with the phone design's P1, and its report goes in `docs/spikes/S5-push-part-1.md`. In order, with what passes:

1. **The extension runs and decrypts on the iOS simulator.** A throwaway development build with a Swift extension; `xcrun simctl push` with a payload whose `h` comes from the hub's sealing vector ‡. Passes when the shown text is the vector's, translated, and a changed byte shows the placeholder.
2. **The extension sets the loudness.** Time-sensitive from the extension, with the capability only; and what the system answers when the extension asks for critical without the entitlement. Records whether the envelope must already say it, which decides between the uniform envelope and envelope B (above). If the answer can only come with the entitlement (AS3), the uniform envelope is built and envelope B stays ready until S10.
3. **Disarm with the app closed.** The action runs app code in the background, opens a WebSocket to the local relay and completes IK with `first` against the real hub; the time it takes is measured against what the system allows ‡.
4. **The Android emulator** (an API 37 image with Google Play is installed): a data message handled with the app swiped away, first through a local stand-in that calls the messaging service ‡, then through real FCM once the Firebase project exists. Passes when the notification shows with its Disarm action and the action reaches the hub.
5. **Expo.** How the phone design's `push` module (the extension target and our Android messaging service, with their config plugin) joins Expo's prebuilt projects, and whether `expo-notifications` and our service can live together ‡.
6. **Real APNs to the simulator**, once AS1 and AS2 are done: the simulator receives a sandbox token on Apple silicon ‡; the push service's real request is accepted and shown.

**S10 waits** for real phones and for AS3: a critical alert through silent mode, and Disarm from a locked phone with the app closed, on an iPhone and an Android phone (O15).

## 6. Signed releases through the relay (D84, UP4, D123)

One transport carries both kinds of file: the relay link's `release.check` and `release.get`. On the hub, hub releases stay with `upkeep`; firmware releases are the updates design's `firmware` module's, with its own operations and record.

- **The releases role** reads every file in its folder (`hsn-hub-<version>-<platform>.hsnr`, and the updates design's `hsn-firmware-<version>.hsnf`, laid out the same way) at start and every 10 minutes ‡, reads each manifest with the matching schema, and keeps an index with each file's kind, version, platform or target, length and SHA-256. The two manifest schemas, the hub release's (`manifestSchema`, now in `hub/src/shell/update/release.ts`) and the firmware release's (with `target` and `roles` in place of `platform`), move to `packages/protocol`, where the hub and the relay both import them. It checks no signature: it is not trusted to. Files are served only on authenticated links (D142): a self-hosted relay fills its folder over its relay link to the operated service. Publishing a release is copying the signed file into the operated relay's folder; no upload interface exists.
- **Checking.** When its link opens and every 24 hours ‡ the hub sends `release.check {platform, running, firmware}`; the relay answers `release.offer` with the newest hub release above `running` for that platform, and the newest firmware above the newest image in the hub's store, each with its `kind`. The shell gives the core `releaseOffered`. A hub release goes to `upkeep`, which records `update_offered` (info) once per version, notified in the `updates` category (optional, D75), and keeps the offer for `update.offers`. A firmware release goes to `firmware`, which records `firmware_release_offered` and answers `firmware.offers` (m3-updates-design section 4).
- **Size caps, per kind, checked against the offer before any byte is fetched:** a hub release at most M2's 256 MB upload cap; a firmware file at most 8 MB, refused before fetching (m3-updates-design section 10).
- **Fetching, only when asked.** `update.fetch {version}` (*manage system*, section 9) makes `upkeep` emit `fileJob {fetchRelease {release: "hub", file, bytes, sha256}}`; `firmware.fetch {version}` makes `firmware` emit the same with `release: "firmware"`. The shell downloads either in pieces of 256 KiB ‡, up to 4 in flight ‡, into the upload store (`UploadStore`, `uploads/`) as an upload of the relay link's own connection (a `ConnId` from the shell's one counter), hashing as it goes. A link that drops during a fetch is waited for up to 10 minutes ‡ and the fetch continues at its offset; then it fails `unreachable`.
  - **A hub release** then runs M2's two staging passes exactly as for `update.upload`, signature first against `PUBLISHER_KEYS`, and ends as M2's jobs do: `fileReady {updateStaged}`, or `failed` with `unreachable`, `badFile`, `badSignature`, `wrongSystem`, `notNewer` or `full`. Approval and the switch are M2's (D54), announced to the relay (section 4).
  - **A firmware release** runs the updates design's `stageFirmware` and ends in its `firmwareStaged` or its refusals. **No `notNewer`:** an older firmware may be fetched, since that is how a bad firmware release is undone.
- **Why only when asked:** a release is 112 MB uncompressed today (M2 section 9), which costs the relay's bandwidth and a Pi's card writes for a version nobody may want; approval follows the download at once, so it adds one wait, of a minute or two.
- **Keys (D123).** `PUBLISHER_KEYS` is empty until the product owner makes the key, so until then every fetched release is refused `badSignature`, as every uploaded one is. Tests sign with `TEST_PUBLISHER_KEY`, which a release build refuses (`releaseKeysProblem`). Releases are made with `hub/packaging/shared/make-release.ts`.
- **Firmware** (D84: "hub and firmware releases"): what the hub does with a firmware file once its signature is checked (its store, signing with the hub's key, D35, its rollout) is the updates design's (section 13).
- **No extra outside connection** (D84): the bytes come over the relay link the hub already holds.

## 7. Per-hub names and the direct-address fallback (D79, D105, RA11, RA12, O8)

This follows S4's recommendation, without the fallback S4 proposed of pointing a blocked name at the relay, which D105 has since ruled out ("Web traffic is never passed through the relay").

### The name

- **Random and public.** The hub makes a name of 16 base32 characters ‡ (80 bits) from its entropy and claims `<name>.<DEPLOYMENT.names.domain>`. It is not the identity: a name is public from its first certificate (S4 1.6), and must not hand strangers what they need to open streams to the hub through the relay. Nothing about the home is in it.
- **Claiming.** Over the relay link: `name.claim {name}` → `name.claimed {fqdn, acmeDirectory?}` or `name.taken` (the hub picks another). The name service ties the name to the hub's identity, so only that hub can change it; the same claim again is accepted. `acmeDirectory` lets the service move hubs to another certificate authority without a software update (S4, recommendation 3).
- **Addresses.** `name.addresses {v4, v6}` with the computer's home-network addresses, sent when they change (the shell's minute check, M2). The service publishes only private addresses (RFC 1918 IPv4 and ULA IPv6 ‡) and refuses others, so no public address is ever published under the name (S4 1.6). Records have a 60 s TTL ‡.
- **Only with the operated relay** (D130). The domain is the operator's; a self-hosted relay has none of ours to give out. Its hubs keep D105's direct address, which works on every router.

### The certificate

- **The hub's own ACME client** in `hub/src/shell/names/`, RFC 8555's subset (account, order, DNS-01, finalize, download) and renewal information (ARI) ‡, written here on `node:crypto` and the DER encoder M2 already has (`hub/src/shell/app/der.ts`) for the request, as M2 chose for its certificate. The account key and the certificate's key (P-256) never leave the hub (`hub_keys`). One certificate names `<name>.<domain>` and `*.<name>.<domain>` (S4, recommendation 5).
- **DNS-01 through the name service:** `name.challenge {values}`; the service answers `name.ok` once the `_acme-challenge` record is published; the hub tells the authority to validate, then sends `name.challengeClear`.
- **Renewal** by ARI, checked twice a day with jitter ‡, falling back to a third of the lifetime left (S4, recommendation 4). Lifetimes shrink to 45 days by 2028 ‡ (S4 1.1), so the name service must be dependable; a hub that cannot renew keeps D105's address working.
- **Serving it.** The apps' listener (8444) offers the per-hub certificate for the name and the self-signed one for addresses, chosen by the name the browser asks for (TLS SNI ‡); its `Host` check gains the name. The listener does not change otherwise (M2 section 5). Link codes gain `n=<name>`, and the link address becomes `https://<name>.<domain>:8444/#link=…` when the name is not blocked.

### Routers that block the name (RA12)

The check of S4's "How the hub should detect a blocking router", at start, at an address change and daily ‡: the hub's own name, the canary and the control name, A and AAAA apart, asked of the system's resolver, of the default gateway on port 53, and of each DNS server the system lists ‡ (on macOS `scutil --dns`, on Linux the resolver configuration or systemd-resolved's servers, on Windows the adapters' servers through `bun:ffi` ‡), with `node:dns`'s `Resolver` and `setServers` ‡. Each answer is classed as S4's table classes it: expected address, blocked (empty, timeout, NXDOMAIN, `0.0.0.0`, REFUSED, SERVFAIL while the control answers), or a DNS problem. The result goes in `hubFacts` (new fields `name` and `nameCheck`), is shown by `names.status` and on the hub's local page, and a change is a `name_check` hub event (info, routine). When blocked: the router instructions of S4's table 2.2 from the translation files where the router is recognised, and D105's direct address, built in M2. The phone app checks from its own side too (S4), which is the phone design's.

### When it is built

The design above is complete, but **nothing of names is built until a domain exists** (the reviewer's ruling): nothing can be proven without one, and D105's direct address already works for every browser. Names are then the last wave (section 12), with `dns-packet` as their test dependency; Pebble is dropped for now. They are not for phones in any case: the phone always connects by address and needs no trust from TLS (m3-design section 2), so names serve the household's browsers only. What cannot be proven until the domain and a DNS provider exist: real issuance, Let's Encrypt's limit of 50 new certificates a week per registered domain until the Public Suffix List accepts the domain (S4 1.3; about 7 new hubs a day), and browsers trusting the real certificate.

```ts
interface NameZone {                       // relay/src/names/zone.ts
  setAddresses(name: string, v4: readonly string[], v6: readonly string[]): Promise<Result<void, ZoneError>>;
  setChallenge(name: string, values: readonly string[]): Promise<Result<void, ZoneError>>; // _acme-challenge.<name>
  remove(name: string): Promise<Result<void, ZoneError>>;
}
```

Implementations: in memory with a local responder for tests; a DNS provider's interface when hosting is chosen (stack.md †). Running our own authoritative DNS server on the open internet is rejected: a provider absorbs the floods such a server attracts, at no work of ours.

## 8. Direct phone-to-hub connection with relay fallback (D56)

- **What M4 builds.** The phone reaches the hub directly on the home network by address, as D132 has it: the apps' listener through the phone design's `hub-net` module, with TLS as carriage only and no pinned certificate fingerprint, the hub proved by Noise with its key pinned at linking (m3-design section 2), and through the relay otherwise, last, retrying home every 60 s (the phone design's provisional value) and when the app comes to the front (m3-design section 6). Both carry the same Noise session; sessions and `seq` are per client, not per socket (M2 section 5), so moving from one path to the other is a reconnect with nothing lost.
- **What waits for cameras (M7).** A direct path between a phone away from home and the hub needs NAT traversal (STUN, TURN, or the ICE of whatever video transport is chosen ‡). That choice belongs with the video design, which waits on O1 and O3; making it now would be a guess. M4 leaves it possible: the relay can gain a role for it, and the addresses a phone and hub would exchange travel inside their Noise session, so the relay would still only introduce them (D56).

## 9. The app channel, version 2

There is one version 2 for this design, the phone design and the updates design, frozen once by the joint step 0. The hub speaks versions 1 and 2 (`HUB_PROTO` becomes `[1, 2]`); its web app speaks 2, and the phone speaks 2 only (m3-design section 3). The phone design's part of version 2 (`hub.info`'s `addresses` and `appsPort`, `pair.prepare`, `pair.finish`, `presence.set`) and the updates design's are in their documents. This design's part, in `packages/protocol/src/app/`:

| Operation | Change | Who | Body | Reply |
| --- | --- | --- | --- | --- |
| `push.register` | yes | the phone itself (kind phone) | `platform: "apns" \| "fcm"`, `environment: "production" \| "development"`, `token` (APNs: 64 to 200 hex ‡; FCM: at most 4,096 characters ‡), `keyId` (16 hex), `key` (43 base64url; never recorded) | `{registered: true}` |
| `push.unregister` | yes | the phone itself | — | — |
| `push.test` | yes | the phone itself | — | `{sent: boolean}`; a test push to this phone, kind `push_test` |
| `relay.status` | no | MS | — | `{url, isDefault, state: "up" \| "down" \| "off", sinceMs, lastError?, roles}` |
| `relay.set` | yes | MS | `url: string \| null` (null: the default) | as `relay.status` |
| `update.offers` | no | MS | — | the newest hub release offered, with its size |
| `update.fetch` | yes | MS | `version` | `{job}`; staged as `update_staged`, as an upload is |

- `hub.info`'s reply gains `relay: {url} | null`. The snapshot gains `push: {registered, valid}` for the asking client. The `hub` event gains `what` values `relay` and `updateOffered`.
- New notifications: `relay_unreachable` (category `hub`, always delivered, never pushed) and `update_offered` (`updates`, optional). `push_test` is pushed only to its phone.
- **Link codes** gain `r=<relay url>`, only when the hub's relay is not the default. `formatLinkQr` adds it; the parser already ignores parameters it does not know (`URLSearchParams`), so the code stays `/1`.
- `OP_OWNERS`: `push.*`, `relay.*` → `relay`; `update.offers`, `update.fetch` → `upkeep`. Firmware releases have their own operations, `firmware.offers` and `firmware.fetch`, owned by `firmware` and defined in m3-updates-design section 4.
- **Not in the first freeze: names** (the reviewer's ruling). When names are built they add `names.status` (no change, MS, `{name, fqdn, certificateUntilMs, check: [{resolver, family, result}], checkedMs}`, owner `app` from `hubFacts`), `names.check` (no change, MS, the result as a `hub` event, owner `shell`), `hub.info`'s `name: string | null`, the `hub` event's `what` value `names`, and `n=<name>` in link codes. Section 12 says what that means for the frozen version.

## 10. Technology choices

| Area | Choice | Why |
| --- | --- | --- |
| Relay runtime | Bun 1.4.2, the hub's pin | Shares `@hsn/protocol` and the Noise code; one runtime to keep current (stack.md, D94) |
| Relay HTTP and WebSockets | `Bun.serve` with Hono 4.13.18, as the hub | Already a dependency; plain WebSockets (stack.md) |
| Relay storage | `bun:sqlite` with Drizzle 0.45.4 and drizzle-kit migrations, as the hub | Already dependencies; one way to write a schema in the repo (QR10, ruled) |
| Errors and validation | neverthrow 8.2.0 with `hsn/must-use-result` on `relay/**`; Zod 4.6.7 | As the hub (HD 10 already names the relay) |
| Hub link authentication | Noise_XN on `@noble/*` 2.4.0, through `packages/protocol`'s state machine | No new cryptography (D125) |
| Push sealing | ChaCha20-Poly1305 from `@noble/ciphers` 2.4.0 on the hub; CryptoKit and `javax.crypto` on the phones ‡ | One primitive on every side |
| APNs and FCM | `node:http2` for APNs ‡ and `fetch` for FCM; JWTs signed with `node:crypto` | No library between our pushes and Apple or Google (stack.md: "sent directly") |
| Hub's WebSocket client | Bun's built-in `WebSocket` | Nothing to add |
| Hub's DNS questions | `node:dns` `Resolver` ‡ | Built in |
| ACME (built with names, last) | Our own client in `hub/src/shell/names/` | M2 chose its own DER encoder over a library for the same path; the subset is small |
| Name zone (built with names, last) | A DNS provider's interface, chosen with hosting (stack.md's † row) | stack.md; no DNS server of ours on the internet |
| Packaging | `bun build --compile` and a Docker image | stack.md |

**New dependencies.** Nothing is installed.

| Name | Version | For | Without it | Status |
| --- | --- | --- | --- | --- |
| `dns-packet` (devDependency of `relay` and `hub` tests) | 5.6.1, already in `bun.lock` through `bonjour-service` 1.4.4 → `multicast-dns` 7.2.5 | The local DNS responder the router check and the name service are tested against | Our own encoder of A, AAAA and TXT answers, about 150 lines | Accepted by the reviewer; added when names are built (last wave) |
| `expo-notifications` | the release for Expo 58 (the local cache holds only 56.0.16, for an older Expo) | The push token, permission, categories and the Disarm action | — | The phone design's (m3-design section 8), not this one's |

The phone design builds the extension, the Android messaging service and their config plugin itself (`app/modules/push/`), so the conditional packages this design first listed for them (an extension-target plugin, `@react-native-firebase/messaging`) are not needed. Pebble, the test certificate authority, is dropped for now with the rest of names; if names are built with a domain, the ACME client is tested against Let's Encrypt's staging service then, and Pebble is asked for again only if that is not enough.

Rejected without listing as candidates: an APNs library and `google-auth-library` (two JWTs and two HTTP requests do not need them), an ACME library such as `acme-client` (looked at again when names are built), and Redis for the relay (stack.md: a self-hosted relay must never need it).

## 11. Test strategy

Everything runs on this Mac with the real hub and a relay started locally (`bun relay/src/main.ts --config relay/test/local.json`, the relay, push and releases roles, listening on port 8480 ‡ on loopback and on the Mac's home-network address), the hub pointed at it with `hsn op relay.set '{"url": "ws://<the Mac's address>:8480"}'`, so that the iOS simulator, which shares the Mac's network, and the Android emulator, which reaches the Mac by that address (m3-design section 2), both find it from `hub.info` ‡. HD 11 and M2 section 10 stay green.

| Piece | Tested by | Stand-in | What the stand-in cannot show |
| --- | --- | --- | --- |
| Noise_XN | The published Noise vectors for XN ‡, our vectors for the relay prologue, the failures (a low-order key, a wrong prologue, message 3 replayed against a new message 2) | — | — |
| Relay frames, phone paths, close codes, `h` and `PushContent` | Zod schemas both ways; vectors in `packages/protocol/vectors/relay-*.json`: a sealed push with fixed key, nonce and content, as exact bytes, which the iOS extension and the Android service also test against | — | — |
| The relay's core | Simulated days with an injected clock: the alert at 180 s and not at 179; the grace of an announced restart and its end; the fresh clock after a relay restart, with `alerted` kept; `back` only after `unreachable`; every fair-use limit at its edge | — | — |
| Hub and relay together | `hub/test/relay/`: the real hub, the real relay, and a scripted phone built from the app's channel code over a relay `Connect`: link by invite through the relay, session, `first`, reconnection with the same `seq`, a session through the relay and one at home for one client, back-off when the relay is killed and restarted, `replaced` when a second hub joins with the same key | — | The internet's own paths: a NAT that drops idle connections, a mobile network |
| The outbox (D102) | The relay killed, a countdown raised, the hub restarted, the relay started: the push arrives once, marked late; routine notices lost by a crash are exactly those M2 accepts | Fake APNs | — |
| Push service | `tools/push-standins/`: a fake APNs on HTTP/2 with a self-signed certificate on loopback, which checks the JWT against a test key, the headers and the body's size, and answers as scripted (200, 410, 429, 500, a stall); a fake FCM with its token endpoint | Fake APNs, fake FCM | Apple's and Google's real acceptance of the topic, the token, the entitlements; delivery times, throttling, payload limits exactly as enforced, Doze on Android |
| Hub-unreachable | The hub process killed: fake APNs receives `unreachable` 180 s ± 2 s after the last frame, then `back`; a test update signed with `TEST_PUBLISHER_KEY` and approved: no alert; a relay restart: the clock afresh | Fake APNs | — |
| The phone's decryption | The iOS simulator with `xcrun simctl push` of the vector's payload ‡; the Android emulator with the stand-in of S5 step 4 (the phone design's tests) | `simctl push`, the stand-in | Real delivery while the app is killed for hours, critical alerts, the locked phone (S10) |
| Releases | A release signed with the test key in the local relay's folder: offered, fetched in pieces with the link cut half-way, staged, approved, switched with the announcement; one with a changed byte refused `badFile`, one with a wrong key `badSignature`, and the loop's 20 ms limit held throughout (M2 section 3) | — | Real bandwidth to a Pi |
| Names (last wave, with a domain) | The name service on `MemoryZone` with the local DNS responder; the ACME client against Let's Encrypt's staging service; the router check against the responder scripted as dnsmasq (empty answer), FRITZ!Box (timeout) and a resolver that passes private answers, and against this Mac's own router, which S4 measured blocks such names | Local DNS | Real routers beyond this one, browsers trusting the real certificate at scale |
| Protection, layer 1 (D142) | `relay/test/load/`: a load script on this Mac opening connections from many loopback addresses (127.0.0.0/8) and IPv6 ones: each per-address and global cap reached and answered with its code, nothing kept for a refused upgrade, memory flat under slow readers and oversized messages, established hub links kept through a flood of new ones, new identities refused past their rate and the stored cap, release egress stopping at the budget. The push service: an item on a relay link without its handshake refused; a refused relay key turned away; a relay naming another relay's hub spending only its own share of that hub's quota, the hub's own relay still served | — | Layer 2: a real volumetric flood, which only the host's filtering meets, and is not tested by us |
| Budget and the Pi | HD 11's budget test with the outbox's rows and the relay link: no new commit; the keepalive's processor time measured on a Pi 4 before release (HB35) | — | — |
| The "done when", locally | `bun run m4`, like `bun run m1a`: the real hub, the local relay, a scripted gateway and sensor from `hub/test/world`, a scripted phone; Away, a door, the countdown push decrypted with the phone's key, its `actions` holding `disarm`, Disarm through the relay as `first`, the countdown cancelled; then the hub killed and the alerts, and a fetched release | All the above | Everything section 14 says waits |

## 12. The order of work

The reviewer writes the joint order of work for the three designs. This section gives what this design contributes to it: its part of the joint step 0, its owners and what each waits for.

### What this design contributes to the joint step 0

One step 0 owner freezes the three designs' interfaces once, reviewed before anyone else starts, as M2's step 0 was. This design's part:

1. **`packages/deployment/`** with its rules and test (section 2), read by `app.config.ts` (m3-design section 2, now on this file in place of `app/product.ts`).
2. **`packages/protocol/src/relay/`**: the hub link's handshake payloads, text frames and binary kinds, without the `name.*` frames; the relay link (D142) on the same frames; the phone paths and close codes; `PushContent` with `actions`, the `h` format and the sealing interface; envelope B's `class` field, defined but unused unless S5 calls for it (section 5); the vectors' file formats. `NOISE_PATTERNS` gains `relay: "Noise_XN_25519_ChaChaPoly_SHA256"`, with the prologues `hsn-relay/1` (hub links) and `hsn-relay-peer/1` (relay links).

   **The two release manifest schemas** move to `packages/protocol`: the hub release's `manifestSchema` from `hub/src/shell/update/release.ts`, and the updates design's firmware manifest, so the hub and the relay import the same ones (section 6).

   **The freeze, and what may still be added.** Channel version 2 and the relay link's version 1 stay open to additions until the first release (the reviewer's ruling on QR11): nothing is in use before it (D119), so names, coming last, add to them without new version numbers. After the first release, M2's rule holds again: anything added is a new version.
3. **This design's part of channel version 2** (section 9), without names.
4. **The hub's model:** the events and effects of section 4, `FileWork.fetchRelease`, `AppListener` `"relay"`, the module `relay` as a stub in `step.ts`'s order where the joint step 0 places it (after `people`), its tables in the next migration of the shared sequence, the decisions and hub events (`relay_link`, `relay_unreachable`, `relay_reachable`, `relay_identity_in_use`, `push_registered`, `push_unregistered`, `push_target_invalid`, `push_dropped`, `update_offered`), `HubRules.relay` with every core value of section 4, `OP_OWNERS`, the `PushKeys` port.
5. **The relay's internal interfaces:** `PushSender`, the release index, the presence core's types, and the rule values of the presence clock and of D142's layer 1. (`NameZone` waits for names.)
6. **Two checks, recorded before the freeze:** the Noise specification's text on reusing a static key, with its section number (QR2, section 3); and that the published Noise vectors include XN ‡.

**Beside step 0:** spike S5 (section 5), by B3 with the phone design's P1; it decides only the phone side and between the uniform envelope and envelope B, so nothing in items 1 to 6 waits for it. And the one-day check of `node:http2` under Bun against the fake APNs (B3), on which the reviewer decides QR5.

### Owners and their work, after step 0

Each owner changes only the folders named; a frozen interface changes only through the step 0 owner.

| Owner | Folders | Steps |
| --- | --- | --- |
| B1 | `packages/protocol/src/relay/` (new files beside the frozen ones), XN in `packages/protocol/src/app/noise.ts`, `packages/protocol/vectors/relay-*.json` | 1. XN against the published vectors. 2. Frame codecs. 3. Sealing and opening, and the push vectors |
| B2 | `relay/src/core/`, `relay/src/shell/`, `relay/src/releases/`, `relay/test/` | 1. Hub links and XN. 2. Phone links and streams. 3. Presence and alerts. 4. D142's layer 1: checks before state, caps, bounded buffers, slow readers, identities, egress budget, and the load tests. 5. Storage. 6. Releases, folder and relay link. 7. The executable and the image |
| B3 | `relay/src/push/`, `tools/push-standins/` | 1. The stand-ins. 2. Relay links and the limits per relay key and hub (D142). 3. APNs. 4. FCM. 5. The push role's own process, account and key files |
| B5 | `hub/src/core/relay/` | 1. Settings and targets. 2. The outbox and its results. 3. Push content per recipient. 4. The link's records and warning |
| B6 | `hub/src/shell/relay/`, `hub/src/shell/app/` (from A2, for M4) | 1. The link, back-off and keepalive. 2. Streams into `AppChannel`. 3. Sealing pushes, and the roster. 4. Fetching releases of both kinds. 5. `announceRestart` |
| A8 | `hub/src/core/upkeep/`, `hub/src/shell/update/`, `hub/src/shell/backup/`, `hub/packaging/` | 1. Hub release offers and `update.fetch`. 2. The announcement in both switches. 3. The new tables in backups. 4. The `backup.key` fix in `hub/src/core/upkeep/` that m3-design section 4 describes (the reviewer's ruling). 5. Signing and notarizing the `.pkg` once AS6 is done |
| A6 | `hub/src/core/notify/` | The new notifications (section 9) |
| P1, P2, P5 (the phone design's owners, by its folders; the reviewer's ruling) | `app/modules/push/` (P1); the relay `Connect` and push registration (P2); `app/src/app/`, `app/src/ui/`, `app/locales/en/` (P5) | P1: the extension and the Android service against this design's vectors, rendering `PushContent`. P2: the relay `Connect`, `push.register`. P5: the screens for relay status, offered updates and "send a test alert" |
| B7 | `hub/test/relay/`, `bun run m4`, the budget and crash additions, the CI workflows | Section 11's integration tests and the local "done when" |

What could collide, and why it does not: `packages/protocol/src/relay/`'s types, the hub's `core/model/`, `db/schema.ts`, the ports and `packages/deployment/` are the step 0 owner's alone; `noise.ts` passes to B1 for XN only; `hub/src/shell/app/` passes to B6; every other folder has one owner.

### Integration

The step 0 owner with each owner: the module in `step.ts`'s order, the loop's new effects (`relayConnect`, `relayRoster`, `pushSend`, `pushKey`, `fetchRelease`), the relay client in `main.ts`, `bun run m4` in continuous integration.

### Real accounts, phones and hosting

As each arrives (section 14): real APNs to the simulator after AS1 and AS2; real FCM after the Firebase project; S10 after real phones and AS3; the operated relay on its host with the domain; the "done when" for real.

### Last: per-hub names, once a domain exists

| Owner | Folders | Steps |
| --- | --- | --- |
| B4 | `relay/src/names/`, `hub/src/shell/names/`, `tools/dns-standin/` (with `dns-packet`) | 1. Name claims and `NameZone`, with the DNS provider. 2. The router check. 3. The ACME client, against Let's Encrypt's staging service. 4. SNI and the `Host` check on the apps' listener, with B6 |

**What putting names last reopens.** Nothing built in the earlier waves is thrown away; but these frozen or built pieces are opened again when names come:

| Piece | What names add | Kind of change |
| --- | --- | --- |
| Channel version 2 | `names.status`, `names.check`, `hub.info`'s `name`, the `hub` event's `names`, `n=` in link codes (section 9) | Additions, allowed until the first release (above) |
| The relay link's protocol | The `name.*` frames | The same |
| The hub's model | `hubFacts`'s `name` and `nameCheck`, the `name_check` hub event, `hub_keys`' four columns in a later migration, `hub_name` in backups | Additions through the step 0 owner, and one more migration in the shared sequence |
| `hub/src/shell/app/listeners.ts`, `policy.ts` (built in M2, B6's for M4) | Two certificates chosen by SNI ‡, and the name in the `Host` check | A change to built code, retested with the listener's existing tests |
| The web app | The name's status and router advice on the hub's page (RA12) | New screens, no change to old ones |

Nothing on the phone changes: the phone never uses names (m3-design section 2).

## 13. What this needs from the phone design

This design owns the relay-to-phone protocol (section 3, "Phones"), the push payload (`h` and `PushContent`, section 5) and its part of channel version 2 (section 9). [m3-design.md](m3-design.md) was read on 2026-11-18 (sections 2, 3, 6, 8 and 10); this table sets what this design needs beside what that design says.

| # | This design needs | What m3-design says | Fits? |
| --- | --- | --- | --- |
| F1 | A development build on the iOS simulator and the Android emulator on this Mac, before any real phone | Section 2: development builds by `expo prebuild` and `expo run:*`, never Expo Go, on the installed simulators and API 37 emulator | Yes |
| F2 | The relay path: React Native's own WebSocket to `<relay>/v1/phone/<identity>/<path>`, the same Noise messages one per WebSocket message, `first` included; the relay asks nothing of the phone | Section 10, items 1 and 2, assume exactly this | Yes. One addition: for local testing the development build must allow `ws://` to the Mac's home-network address (App Transport Security's local-network exception, Android's cleartext setting ‡), which section 2 does not list |
| F3 | The phone learns its hub's relay from `hub.info` (version 2), or a link code's `r=`, or the default | Section 10, item 3, assumes a field of `hub.info` | Yes; `r=` is new to that design and needed for an invite to a self-hosted relay's hub |
| F4 | `push.register {platform, environment, token, keyId, key}` per hub, a key made by the phone; registered again when the token changes, at a link, when the snapshot's `push` says so, and every 30 days ‡ | Sections 6 and 10, item 4: an operation carrying the platform, the token and a 32-byte key per hub | Yes; `keyId`, `environment` and the times of registering are this design's additions |
| F5 | Storage the extension reads: per hub the push key, its key id and the last `armed` | Sections 2 and 6: the push key and the last armed state per hub in an App Group's shared keychain; `armed` written on every `arming` event | Yes, adding the key id; this design also refreshes `armed` from every push |
| F6 | The extension and the Android service decrypt `h` with this design's vectors, render from `n.kind`, choose the loudness, show the actions, drop repeats by hub and `seq` | Section 6: both in `app/modules/push/`, owner P1, with their config plugin | Yes |
| F7 | Critical marking by the extension from `n.critical`, the envelope uniform (D126, D127); envelope B if S5 fails | Section 10, item 6, assumed APNs' critical level and sound in the envelope, which is envelope B | **Differs until S5**: the reviewer ruled for the uniform envelope; the phone design's assumption becomes the named fallback (section 5) |
| F8 | The hub-unreachable and back alerts as sealed pushes of kinds `hub_unreachable` and `hub_back`, their time taken from arrival | Section 10, item 7, assumed a fixed readable payload | **Being changed** in that design (the reviewer ruled for D127) |
| F9 | No collapse identifier on the wire; the phone removes a device's shown countdown when that device's alarm arrives ‡ | Section 10, item 5, asked how a countdown is replaced by its alarm, suggesting a collapse identifier | **Differs**: answered here (section 5); the phone design adopts the local replacement |
| F10 | Identifiers and display name from `packages/deployment/`; the URL scheme stays `hsn` | Sections 2 and 10, item 9, name `app/product.ts`; the scheme stays `hsn` | **Being changed** to `packages/deployment/` (the reviewer's ruling); the scheme now agrees, this design having dropped its `appScheme` |
| F11 | Home first, the relay otherwise; moving between them by reconnecting | Section 6: relay last; home tried again every 60 s and when the app comes to the front | Yes |
| F12 | At home the phone needs nothing of names | Section 2 and D132: the phone connects by address through `hub-net`, TLS as carriage, no pinned fingerprint; names are for browsers | Yes; section 8 follows D132 |
| F13 | The lock-screen Disarm sends `disarm {target: "mine"}` as `first`, without the app lock | Section 6: from the app's JavaScript started in the background; if S5 shows it is too slow, a choice for the product owner | Yes |
| F14 | Several hubs need nothing more: each push names its hub; key ids are per phone and hub | Section 6: one record and key per hub, built now; with several homes a notification starts with the home's name | Yes |
| F15 | A typed code works only at home | Section 3: a typed code finds hubs by mDNS | Yes |
| F16 | Presence offers ("Arm away", "Disarm") delivered by push when away | Section 6: each offer is a notification with one action | **Fits now**: `PushContent`'s first draft carried only `disarm`; it now carries `actions` (`disarm`, `armAway`), so presence needs no new push format. The hub's offer rule is the phone design's (H1) |
| F17 | The screens: relay setting and status, offered updates and `update.fetch`, "send a test alert" (`push.test`) | Not in section 10's owners (P5's list is This phone, Homes, the app lock, notifications) | **Settled**: P5's (the reviewer's ruling) |
| F18 | An owner for the relay `Connect` and push registration | Section 10's waves list them for "M5, after the relay design" without an owner | **Settled**: P2's (the reviewer's ruling) |
| F21 | The link code's prefix stays `hsn://link/1`; `n=` joins with names | Section 3 now writes the prefix as `${DEPLOYMENT.appScheme}://link/1` and lists `n=` in version 2 | **Does not fit**: this design dropped `appScheme` on that design's own earlier argument (boards show `hsn://pair/1`, section 2), and `n=` comes with names, last. That design's section 3 should read `hsn://link/1` and mark `n=` as names' |
| F19 | The bundle id chosen now, before the name, so Apple's critical-alert request can go in (QP1) | Section 2: the final App ID "after the product name" | **Differs**: for the product owner (QP1) |
| F20 | `hub.info`'s home addresses come from the hub, not the relay | Section 10, item 10: optional; that design takes them from `hub.info` and mDNS | Yes: the relay gives none |

**From `docs/m3-updates-design.md`** (section 10, "What this needs from the relay design", read again on 2026-11-18), now as the reviewer ruled: one transport (`release.check`, `release.get`) for both kinds of file; hub releases stay with `upkeep` (`update.offers`, `update.fetch`, `update_offered`); firmware releases are `firmware`'s, with `firmware.offers`, `firmware.fetch` and the record `firmware_release_offered`, and `fetchRelease` carries `release: "hub" | "firmware"`, the firmware outcome running `stageFirmware`; `notNewer` only for hub releases, since an older firmware undoes a bad one; both manifest schemas in `packages/protocol`; a firmware file over 8 MB refused before any byte is fetched (section 6). Its four points of misfit are all settled. Both designs say "the next migration", and the joint step 0 numbers them.

## 14. Readiness

| Piece | Built and proven now, on this Mac | Built, not proven: waits for |
| --- | --- | --- |
| Relay: hub and phone links, streams, presence, alerts, limits, storage | yes, locally with the real hub | Hosting and the domain, for the operated service; a real NAT and mobile network |
| Hub's relay client, outbox, restart announcement | yes | A Pi 4, for the keepalive's cost (HB35) |
| Push sealing and the payload | yes, by vectors on the hub, the extension and the Android service | — |
| Push service to APNs | against the fake APNs | **AS1 and AS2** (owner, Apple account), then real APNs to the simulator; no phone needed |
| Push service to FCM | against the fake FCM | **A Firebase project** (owner), then real FCM to the emulator |
| Decryption on the phone, Disarm with the app closed | on the simulator and emulator (S5) | Real phones (S10) |
| Critical alerts (D92, AP9, D96's loud alert) | the code path, without the entitlement | **AS3**, Apple's grant, which needs the bundle id (QP1); real phones |
| Releases through the relay | yes, with `TEST_PUBLISHER_KEY` | **The publisher key** (D123, owner); hosting for the operated relay |
| Per-hub names, certificates and the router check | not built until a domain exists (the reviewer's ruling); D105's direct address serves meanwhile | **The domain** for hub names, **a DNS provider** and **hosting** (owner); the Public Suffix List later (S4); other real routers |
| Signed macOS installer | — | **AS6** (owner) |
| Protection, layer 1, and the push service's checks (D142) | yes, by the load tests and the relay-link tests on this Mac | Measurements of memory per connection on the chosen host, which set the caps |
| Protection, layer 2 | — | **Hosting** that meets section 3's requirement (QP6) |
| Self-hosting | the executable and image built and run locally | Someone's server |
| The app's identifiers and name | placeholders | **The bundle id** (QP1), **the product name** |

## 15. Decided, and still open

### Decided here (proposed as decisions for architecture.md)

| # | Decided | Rejected, and why |
| --- | --- | --- |
| D125 | The hub's link: TLS, a Noise_XN handshake proving the app key, then frames in the clear inside TLS | A challenge and MAC of our own (new cryptography); everything inside Noise transport (fragmentation, no gain over TLS) |
| D126 | A symmetric push key per phone and hub, made by the phone, given in the channel; one padded size; one envelope for every push, **if S5 shows the iOS extension can raise a push to critical by itself**, else envelope B (section 5) | Sealing to the phone's Noise key (puts the identity key in the extension; more primitives in Swift and Kotlin); a hub-made key (lands in `client_replies`) |
| D127 | The relay's alerts are sealed by the hub in advance, so all pushes look alike (on iOS, only under the same condition as D126) | Alerts in the clear from the relay (Apple, Google and the relay would see which pushes are outages) |
| D128 | One configuration file for name, domain and identifiers; placeholders that never resolve; protocol labels never renamed | Environment variables or per-package settings (several places to change, and a hub that could be built pointing nowhere sensible) |
| D129 | Releases from the relay's folder or upstream, offered at link-up and daily, fetched on request | Automatic download (bandwidth and card writes for unwanted versions); a separate download host (an extra outside connection, D84) |
| D130 | Per-hub names only with the operated name service; hub-held keys; random names, not identities | Names for self-hosted relays (no domain of ours to give); the identity as the name (public in CT logs, and it opens the relay path to strangers) |
| D131 | D56's direct path for video waits for M7; M4 does home-network direct and the relay otherwise | Hole punching now (would guess the video transport) |
| D142 | "Everything the operator runs is protected against outsiders on the internet: the relay, the push service, the releases and names services and the operator's keys. That covers flooding, use of the services by anyone who has not proved a hub or relay key, and exhaustion of storage, memory or paid quota. The owner's home network and hub computer stay as D124 has them." Reason: the product owner's decision of 2026-11-18. Designed in section 3, "Protecting what the operator runs" | Leaving flood protection and the push service's checks as questions (the first draft's QS2 and QS3) |
| — (under D142) | The push service accepts items only over relay links on which the relay proved its own key (XN), each item naming the hub the relay authenticated; limits per relay key and hub together, per relay key, per address and in all; targets travel in the clear inside the hub link, as D59 accepts | Targets sealed by the hub for the push service (`Noise_X`): the reviewer ruled it out, since a stranger holding a token is limited the same way either way, and it would cost a third Noise pattern, its vectors, a cache and a key rotation, only to hide tokens D59 lets the relay see |
| — | The core module `relay`, after `people`, placed by the joint step 0; the outbox durable as its notification | The outbox in the shell only (a restart would lose critical pushes; durability is the core's) |
| — | Names, ACME and the router check in the shell, reported through `hubFacts` | A core module (it would hold nothing the core decides) |
| — | The phone's address pseudonymised by the relay | No address (one flood would lock every phone out); the real address (the hub need not learn it) |

### The reviewer's rulings

| # | Question | Ruled |
| --- | --- | --- |
| QR1 | D125: TLS plus XN, frames in the clear after it | Yes |
| QR2 | The hub's one static key in IK (phones) and XN (relay) | One key. Step 0 checks the Noise specification's text on static key reuse and records its section number; if it says otherwise, a second key and D55 amended (section 3) |
| QR3 | D126 and D127 | Yes, standing only if S5 shows the iOS extension can raise a push to critical by itself; envelope B is the named fallback (sections 5, 16) |
| QR4 | Release format 2 or a compressed format 3 | Format 2 |
| QR5 | APNs from Bun's `node:http2`, or the `push` role on Node | Decided after the one-day check beside step 0 |
| QR6, QR9 | Our own ACME client; `dns-packet` and Pebble | Names move to the last wave; nothing of them is built before a domain exists; Pebble dropped for now; `dns-packet` accepted when names start (section 12) |
| QR7 | Fetch on request (D129) | Yes |
| QR8 | The outbox's burst on reconnect: every critical and the newest 10 others ‡ | Yes |
| QR10 | Drizzle or plain SQL for the relay | Drizzle |

| QR11 | Names after the freeze | Channel version 2 and the relay link's version 1 stay open to additions until the first release (D119); said once, where the freeze is described (section 12) |
| QR12 | `PushContent.actions` | Yes: `actions: ("disarm" \| "armAway")[]` |

### Questions for the product owner: accounts, names, money and scope

| # | Question | Recommendation |
| --- | --- | --- |
| QP1 | Choose the bundle identifier and Android application id now? They are never shown to users and need not match the product's name ‡, and Apple's critical-alert request (AS3), the longest wait in M4, needs one. The phone design registers the final App ID only after the name (m3-design section 2) | Yes: choose them now, register AS1, and send AS3 at once |
| QP2 | Do steps AS1, AS2, AS4 and AS6 of section 5 now, and AS3 after QP1 | Yes. S5 needs none of them; real APNs to the simulator needs AS1 and AS2 |
| QP3 | A Firebase project for FCM, under whose Google account; who keeps its service account key | The product owner's, kept as the publisher key is (D123) |
| QP4 | Where the APNs key and the FCM key are kept | As D123: held by the product owner, copied only to the push service's host |
| QP5 | Two domains: the product's, and a separate registrable domain for hub names (S4, recommendation 1); each a yearly cost | Two, when the name is chosen |
| QP6 | Hosting that meets D142's layer 2 (section 3: always-on volumetric filtering of at least 10 Gbit/s ‡, long-lived WebSockets, the client's address passed through, IPv4 and IPv6 in the EU, 3 TB ‡ a month with a cap or alert on going over); a DNS provider with an interface for the hub-name zone, when names come; and who is told when the operated relay or push service is down, since while it is down no phone is told anything, not even that its hub cannot be reached | A server from a host that includes always-on network filtering (about €5 to €60 a month ‡), a proxy service in front only if floods outgrow it; an outside uptime check that alerts the operator. The uptime check is hosting, not security, so it is here |
| QP7 | The milestone's "done when" (section 1) | As proposed |
| QP8 | Signing installers: the macOS `.pkg` with AS6 now (D119), and Windows, left open by M2 section 12 | Both in M4, as M2 recommended |
| QP9 | Whether the product's name will replace the internal names in installers and folders ("HSN Hub"), which is not a one-line change | Keep them as internal names; decide before the first release if not |

### Questions for the product owner: security

The product owner decided on 2026-11-18 that everything the operator runs is protected (D142). The first draft's QS2 (flood protection) and QS3 (the push service accepting only proven hubs and relays) are therefore designed in (section 3). One question stays, because it is a paid service by a person, not something we build:

| # | Question | What it would cover | Costs | Without it |
| --- | --- | --- | --- | --- |
| QS1 | An outside review of our Noise code. M2's risk table plans one ("a review by someone outside the project before M4 exposes it"); D124 says no review without the product owner asking | Our Noise state machine (`noise.ts`: IK, XXpsk3, and M4's XN); how the hub's session layer and the hub and relay links use it (message order, when the pre-shared key is set, the all-zero check, nonces, the session's lifetime); the linking codes' derivations; the push sealing; the backup file's sealing | A few days of an independent cryptography reviewer, roughly €3,000 to €15,000 ‡ | The published and our own vectors and a fuzzed handshake, as built; a flaw would be found by us or by users. It can be done at any point before public release |

AS5, the filtering entitlement, stays an optional Apple step (section 5): with it an iPhone drops a push it cannot open instead of showing the placeholder.

## 16. Gaps, contradictions and risks

### In other documents (not edited here)

| Where | Gap or contradiction | Reading taken, and the proposed text |
| --- | --- | --- |
| architecture.md | No decisions for the relay's link, push keys, the configuration point, releases, names, D56's scope | D125 to D131 as section 15 has them, each with its reason |
| D59 | Says the relay sees "only encrypted traffic, its timing and the phones' push tokens"; it also sees sizes, internet addresses, which release a hub fetches, and, with names, home-network addresses (D79) | Proposed: "The relay sees only encrypted traffic, its timing and size, the internet addresses of hubs and phones, the phones' push tokens, which release a hub fetches, and, for per-hub names, the hub's home-network addresses (D79)." |
| m2-design.md section 13, Risks | "a review by someone outside the project before M4 exposes it through the relay", against D124's "no security review … without the product owner asking" | QS1 |
| S4, "Fallback when the name is blocked", item 1 | Proposes pointing a blocked name at the relay; D105 later ruled web traffic through the relay out | D105; S4's item is superseded |
| stack.md, "Push content" | "Encrypted to each phone with a key agreed at linking" | Proposed: "Sealed by the hub with a key each phone gives it in the app channel, ChaCha20-Poly1305, one padded size; decrypted on the phone by native code (D126)." |
| stack.md, Relay and Push rows | Name no HTTP framework, no roles, no push transport | Proposed Relay: "TypeScript on Bun, Hono and plain WebSockets as the hub, `bun:sqlite` with Drizzle for hub presence, push tokens and names; one program with the roles relay, push, names and releases (m4-design.md), protected as D142 says." Push: "Sent directly to APNs (HTTP/2, token authentication) and FCM (HTTP v1) by the operated push service, its own process and account, only over relay links on which a relay proved its key (D142); JWTs signed with `node:crypto`, no library." New row, Hub to relay: "TLS, and a Noise_XN handshake proving the hub's app key (D125); relays prove their own key the same way to the push service (D142)." New row, Hosting: "A host with always-on volumetric filtering, long-lived WebSockets and the client's address passed through (D142, m4-design.md section 3)." |
| build-plan.md, S5 | Listed "while boards ship"; no report exists | Run beside the joint step 0 (section 5) |
| build-plan.md, M4 heading | "(needs the Apple account, name and domain)" | Proposed: "(starts on the Mac now; real push needs steps in the Apple account and a Firebase project, real names the domain and hosting, S10 real phones)" |
| m2-design.md section 12, Q14 | Names `tools/release-sign`; the code has `hub/packaging/shared/make-release.ts` | The code's name |
| hub-design.md section 2 | The module table | Gains `relay`, at the place the joint step 0 gives it (after `people`), with the updates design's `firmware` |
| m3-design.md sections 2 and 10 | `app/product.ts` as the configuration point; the hub-unreachable alert as a fixed readable payload; a collapse identifier; critical marking in the envelope | The reviewer ruled for `packages/deployment/` and D127, and that design is being changed; the collapse identifier and the critical marking are answered in section 13 (F7, F9) |
| m3-design.md and m3-updates-design.md | Each numbers its own migration and module place | "The next migration" and "placed by the joint step 0" in all three |
| stack.md, "Push content" and D59, under envelope B | If S5 fails, the relay, the push service and Apple learn which pushes to iPhones are critical | Envelope B's text for D59 and D96 (section 5), applied only then |
| software.md, AP6 and D64 | "hub offline, home not protected" | D96's wording (section 5), since the relay cannot tell a dead hub from an outage |
| D61 against relayed links | The console is trusted on the computer; a relayed connection must never be | A console client is refused on `"relay"` as on `"lan"` (section 4) |
| HB26 and D79 | "No data leaves the home by default", while a per-hub name publishes home-network addresses in public DNS | D79 decided it; section 3's table says it plainly |

### Risks

| Risk | What settles it |
| --- | --- |
| The extension cannot raise a push to critical by itself, so D126 and D127's uniform envelope fails on iOS | S5 step 2 (with the entitlement, S10). If so, envelope B (section 5), already named: critical pushes marked in the envelope; the relay, the push service and Apple learn which pushes to iPhones are critical and when; the hub-unreachable alert always loud on iPhones; D59 and D96 amended as section 5 says. Android unaffected |
| Apple refuses or delays the Critical Alerts entitlement ‡ | Asked early (QP1); until granted, critical pushes are time-sensitive, which silent mode may hold back ‡ |
| `expo-notifications` and our own Android service conflict ‡ | S5 step 5; the phone design's `push` module adjusts |
| A late piece reopens frozen versions: names add to channel version 2 and the relay link's version 1 after their freeze | Settled (QR11): both stay open to additions until the first release |
| m3-design section 3 writes the link prefix as `${DEPLOYMENT.appScheme}://link/1` and puts `n=` in version 2 | This design has no `appScheme` (the scheme stays `hsn`) and `n=` comes with names; section 13, F21 |
| A phone that turned off arm-and-disarm notices keeps a stale `armed`, so the unreachable alert may be quiet when it should be loud (O15) | Pushes of the other kinds and every session refresh it; if S5 shows the filtering entitlement lets the extension drop a push silently, the hub can send a state-only push on every arming. Otherwise accepted and said in the app |
| Bun's `node:http2` client is not sound for APNs ‡ | The one-day check; the `push` role on Node |
| Let's Encrypt's 50 a week per domain caps new hubs at about 7 a day until the Public Suffix List (S4) | Second issuer wired as standby (S4), when names are built; the list when there are thousands of users |
| The relay is the only source of the hub-unreachable alert: if it is down, nobody is told | QP6's outside uptime check (hosting); D142's two layers make it less likely |
| A flood larger than the host's filtering | Accepted: the host's level is the ceiling (D142, layer 2); a proxy service in front raises it if floods come |
| Free identities and relay keys let a many-address effort fill the new-identity cap or the release budget | Both are capped and alerted (D142); legitimate hubs already linked are unaffected, new ones and downloads wait |
| A NAT or mobile network that drops a connection idle for under 30 s ‡ | The keepalive is a value; measured on real networks once the relay is on its host |
| Two hubs restored from one backup fight over the relay link | `replaced` and the 10-minute wait, with `relay_identity_in_use`; M2's mDNS refusal |

### Facts from memory, to check before anything depends on them

| Fact ‡ | Checked by |
| --- | --- |
| A notification service extension runs for `xcrun simctl push`, and on the simulator for real APNs sandbox pushes on Apple silicon | S5 steps 1, 6 |
| The extension may set the interruption level and a critical sound; its time and memory limits (about 30 s, small) | S5 step 2 |
| A notification action without `authenticationRequired` runs with the phone locked, and how long the app has in the background | S5 step 3, S10 |
| An FCM high-priority data message reaches the app's service in the background but not after a force stop; high-priority messages that show nothing may be deprioritised | S5 step 4 |
| CryptoKit's `ChaChaPoly` (iOS 13 and later), `javax.crypto` ChaCha20-Poly1305 (API 28 and later) | S5 step 1, 4 |
| APNs: HTTP/2 only, the JWT's refresh window, the headers and error codes of section 5, the 4 KB payload limit; FCM: the HTTP v1 request, its OAuth scope, the 4 KB data limit, its error codes | B3, against Apple's and Google's documentation, before the stand-ins are written |
| Apple's Critical Alerts entitlement is granted on request for a bundle id; Time Sensitive is a capability; the filtering entitlement exists and is requested; a bundle id can be chosen independently of the app's name | QP1, AS1 to AS5 |
| Bun 1.4.2: the `node:http2` client, `bun build --compile` for the relay; and, for names, `node:dns` `Resolver.setServers` and several certificates chosen by SNI in `Bun.serve` | The one-day check; B2; B4 when names are built |
| The Noise specification lets one static key pair be used with different Noise protocols that share a hash, and not outside Noise (the reviewer's recollection) | The step 0 owner, recorded with the section's number (QR2) |
| The published Noise test vectors include `Noise_XN_25519_ChaChaPoly_SHA256` | The step 0 owner; B1 |
| Hosts commonly include always-on network filtering of about 10 Gbit/s; the price ranges of section 3's options; the PROXY protocol passes the client's address through a filter or proxy | QP6, when hosting is chosen |
| An APNs key can be revoked and replaced in the Apple account, and a Firebase service account key in Google's console | B3, before the push service goes on its host |
| ACME's renewal information (ARI), and Let's Encrypt's coming 45-day lifetime (S4 read these; confirm current) | B4, when names are built |
| `expo-notifications` for Expo 58 and its Android messaging service beside ours | S5 step 5 |
| A development build allows `ws://` to a home-network address (App Transport Security's local-network exception; Android's cleartext setting) | P2, for local testing (section 13, F2) |
| An extension or service can remove a shown notification when a later push replaces it | S5 (section 13, F9) |
| The local network permission on iOS for a phone connecting to the hub's home address (S4 3.3) | The phone design |

### What this design is least sure of

- Whether the extension can choose the loudness alone (S5 step 2), on which D96's "the phone decides by itself" and D126 and D127's uniform envelope rest; envelope B is ready if not.
- The fair-use numbers, which are guesses until running costs are known (D55).
- Whether the name service can be made dependable enough for 45-day certificates on a small project's hosting; D105 is the floor if not.
