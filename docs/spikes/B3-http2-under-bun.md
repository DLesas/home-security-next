# B3: `node:http2` under Bun 1.4.2, for APNs

Run 2026-11-18 on this Mac (Apple silicon, macOS), Bun 1.4.2, Node 22.14.0 for comparison. The question from [m4-design.md](../m4-design.md) section 5 (QR5): can Bun 1.4.2's `node:http2` client hold a connection to APNs and send requests as the push role needs, or must the push role run on Node?

## Answer: yes

Bun 1.4.2's `node:http2` **client** is sound for the push role. Against a Node 22 server it behaved as Node 22's own client does in every case tried, with two differences in how failures are reported, both handled in [`relay/src/push/safe/http2.ts`](../../relay/src/push/safe/http2.ts). The push role can run on Bun; nothing here calls for D94's seam to Node.

Bun's `node:http2` **server** has two faults (below). They matter only to the APNs stand-in, which is test code; Apple's servers are not Bun.

## What was tried

Two ways, both on loopback with a self-signed certificate made for the run:

1. **Scratch probes** (in the reviewer's scratchpad, not in the repository): a small `node:http2` server and client, each run under Bun and under Node, in the four pairings, with the server scripted per request.
2. **Regression tests** in the repository, [`relay/test/push/http2-under-bun.test.ts`](../../relay/test/push/http2-under-bun.test.ts): the push role's own HTTP/2 wrapper and APNs sender against the APNs stand-in ([`tools/push-standins/`](../../tools/push-standins/README.md)), so the finding is checked on every `bun run check`.

### The four pairings (scratch probes)

| Case | Node client, Node server | Bun client, Node server | Node client, Bun server | Bun client, Bun server |
| --- | --- | --- | --- | --- |
| 40 requests at once, before SETTINGS arrived, server limit 5 | 200s, and REFUSED_STREAM (7) for the excess | the same | the same | the same |
| Requests after SETTINGS arrived, limit 5 (50 at once) | — | — | — | all 200: the client holds the excess itself |
| One connection for many requests | 1 session | 1 session | 1 session | 1 session |
| GOAWAY after an answer, then a request on the same session | `request()` throws `ERR_HTTP2_INVALID_SESSION` | the error arrives as an `error` event, not a throw | throws | event |
| GOAWAY naming stream 1 the last, 5 more in flight | — | the 5: `ERR_HTTP2_GOAWAY_SESSION`, rstCode 7 (safe to resend) | — | — |
| A new session after GOAWAY | works | works | works | works |
| A stalled answer, cancelled by the client after 300 ms | the session stays usable | the same | the same | the same |
| Server resets the stream (INTERNAL_ERROR) | `ERR_HTTP2_STREAM_ERROR`, rstCode 2 | the same | **no reset arrives**: the client times out | the stream closes with rstCode 0 |
| Server destroys the TLS socket mid-request | stream closes, rstCode 8 | the same, and the session is destroyed | **the socket is not closed**: the client times out | as Node's |
| A request on a session the server destroyed | error | error | error | error |
| Connecting to a closed port | session `ECONNREFUSED`, stream `ERR_HTTP2_STREAM_CANCEL` | the same | — | — |
| 5,000 requests, 100 at a time, 50 ms answers, one session | — | all 200, 2.7 s, memory up 28 MB | — | — |
| HTTP/2 PING | ok | ok | — | — |

### What the client code does about it

- **Waits for the server's SETTINGS** before its first request (`Http2Connection.ready`). A client that sends first has every stream over the server's limit refused, under Node as under Bun; APNs is said to allow few streams until a connection's first token is checked ‡, so this matters. After SETTINGS, the client library holds the excess itself: 200 pushes at once against a limit of 10 had none refused (the first test).
- **Treats a closed session both ways**: a throw from `request()` (Node) and an `error` event (Bun) both become `refused`, since nothing was sent.
- **Classes each failure** by whether the server may have processed the request: REFUSED_STREAM and `ERR_HTTP2_GOAWAY_SESSION` are `refused` and are sent again on a new connection (at most twice); a reset, a lost connection and a timeout are not sent again by the push role, since the push may have been delivered, and the hub's outbox retries them (at least once, as the design says).
- **After a GOAWAY** the connection takes no new requests and is left to finish what the server is still answering; the next push opens a new one. A broken connection is closed.
- **Its own timeout per request**, which cancels the stream and keeps the connection.
- **Back-off between failed connections** (`RELAY_BACKOFF`), so a service that is down is not hammered: pushes meanwhile are `retryLater` at once.

### The regression tests

| Test | Shows |
| --- | --- |
| 200 pushes at once share one connection, within the server's stream limit | multiplexing, connection reuse, the limit kept (10 in flight at the server, none refused) |
| a client that does not wait for SETTINGS has streams over the limit refused | why the wrapper waits |
| the wrapper waits for SETTINGS, reports the limit, and classes an unprocessed stream as refused | `ready`, `streamLimit`, a closed connection |
| sequential pushes reuse the connection | one connection for 30 pushes |
| after a GOAWAY the next push opens a new connection | GOAWAY and reconnect |
| streams above a GOAWAY's last stream are refused, sent again on a new connection, and delivered | GOAWAY with streams in flight: the processed one kept, the others resent |
| a connection lost mid-request is retryLater, and the next push reconnects | connection loss |
| a stalled answer times out without losing the connection | a slow server |
| a reset stream is retryLater | a failing stream |
| a server that is gone | a failing server, and the back-off |
| a connection that never answers SETTINGS times out | a server that accepts TCP and says nothing |

Changing the wrapper so it does not wait for SETTINGS fails four of them.

## What it does not show

- **Apple's own server.** Its stream limits, its idle timeout, when it sends GOAWAY, its TLS (ALPN `h2` only ‡). The stand-in imitates the documented behaviour from memory ‡; real APNs waits for the Apple account's steps AS1 and AS2 (m4-design section 14).
- **Days-long connections.** The longest run was seconds. A connection idle for long may be closed by Apple ‡ or a NAT; the sender reconnects on the next push, which the GOAWAY and loss tests cover, but no test holds a connection for hours.
- **Load beyond a few thousand pushes.** Enough for this service's size; not a benchmark.
- **Bun releases after 1.4.2.** The regression tests are the guard when the pin moves.

## Bun's server faults, for the stand-in

The stand-in runs on Bun's `node:http2` server, so two of its scripts do not behave as the same code on Node would: a scripted **reset** reaches a Bun client as a close with no code, and destroying the raw TLS socket does not close the connection (the stand-in destroys the HTTP/2 session instead, which works). Neither is relied on for more than "the stream ended without an answer". If a future test needs the exact reset code, the stand-in can run under Node.

## Facts from memory ‡

- APNs serves HTTP/2 only, at `api.push.apple.com` and `api.sandbox.push.apple.com`, port 443 (or 2197).
- APNs announces a low stream limit until the first provider token on a connection is verified, then raises it.
- APNs sends GOAWAY with a JSON reason (`{"reason": "Shutdown"}`, among others) when it closes a connection, and closes idle ones.
