# `@hsn/push-standins`: Apple's and Google's push services, on loopback

Owner B3 ([docs/m4-design.md](../../docs/m4-design.md) section 12). Stand-ins for APNs and FCM, so the push role's real client code ([`relay/src/push/`](../../relay/src/push/)) is tested on this Mac without an Apple account, a Firebase project or any request leaving the machine (section 11, "Push service"). They listen on 127.0.0.1 only, on a free port, over TLS with a certificate made for each test, and check what they receive against keys made for each test. Nothing here is a real key, and no real key is ever needed.

Every statement below about what Apple or Google do is from memory and marked ‡: none was checked against their documentation while writing this (m4-design section 16 lists it as B3's to check before anything depends on it). Where a stand-in's behaviour is its own choice, not a claim about the real service, it says so.

| File | What |
| --- | --- |
| `src/apns.ts` | `startApnsStandIn`: the APNs stand-in |
| `src/fcm.ts` | `startFcmStandIn`: the FCM HTTP v1 stand-in and its OAuth token endpoint |
| `src/test-keys.ts` | `makeApnsTestKey`, `makeFcmTestAccount`, `serviceAccountJson`, `writeSecretFile` (0600) |
| `src/certificate.ts` | `loopbackTls`: a P-256 key and a self-signed certificate for `localhost`, 127.0.0.1 and ::1, valid a day |
| `src/jwt.ts` | Reading and verifying a JWT (ES256 and RS256), written apart from the push role's signer |
| `src/safe/attempt.ts` | Every `try` of the workspace |
| `test/standins.test.ts` | The stand-ins' own tests |

No dependencies: `node:http2`, `node:crypto`, `Bun.serve`, and a small `Result` of its own (as `@hsn/protocol` has).

## The APNs stand-in

**What it imitates ‡:**

- HTTP/2 over TLS (ALPN `h2`), one server for one environment (start two for production and sandbox).
- `POST /3/device/<device token>` with token authentication: `authorization: bearer <JWT>`, the JWT ES256 with header `{alg, kid}` and claims `{iss, iat}`, the signature as JOSE's raw r ‖ s (64 bytes) ‡.
- SETTINGS_MAX_CONCURRENT_STREAMS as given (default 1,000), so streams over it are refused (REFUSED_STREAM), as real APNs does while its limit is low ‡.
- Its checks, in this order, each answered with Apple's status and `{"reason": "…"}` ‡:

  | Check | Answer ‡ |
  | --- | --- |
  | Method not POST | 405 `MethodNotAllowed` |
  | Path not `/3/device/<token>` | 404 `BadPath` |
  | No `authorization` | 403 `MissingProviderToken` |
  | Not a bearer JWT; wrong `kid`, `iss`; no numeric `iat`; a signature that does not verify | 403 `InvalidProviderToken` |
  | `iat` more than a minute in the future (the stand-in's own tolerance) | 403 `InvalidProviderToken` |
  | `iat` more than an hour old | 403 `ExpiredProviderToken` |
  | A provider token different from the last, sooner than 20 minutes after it changed | 429 `TooManyProviderTokenUpdates` |
  | No `apns-topic` / another topic than the bundle id given | 400 `MissingTopic` / 400 `BadTopic` |
  | `apns-push-type` missing or unknown | 400 `InvalidPushType` |
  | `apns-priority` not 10, 5 or 1 | 400 `BadPriority` |
  | `apns-expiration` not whole seconds | 400 `BadExpirationDate` |
  | `apns-id` not a UUID | 400 `BadMessageId` |
  | `apns-collapse-id` over 64 bytes | 400 `BadCollapseId` |
  | Device token not 64 to 200 hex digits | 400 `BadDeviceToken` |
  | Empty body / body over 4,096 bytes | 400 `PayloadEmpty` / 413 `PayloadTooLarge` |
  | Body not a JSON object with an `aps` object | 400 `StandInBadPayload`: **the stand-in's own reason**, not Apple's, to catch a malformed body |
  | A token `unregister`ed | 410 `{"reason": "Unregistered", "timestamp": <ms>}` |

- Success: 200 with an `apns-id` header (the request's, or a new UUID) and no body ‡.
- Scripted answers for a request that passed every check: any status and reason (429 `TooManyRequests`, 500 `InternalServerError`, 503 `ServiceUnavailable`, 400 `DeviceTokenNotForTopic`…), optionally late (`delayMs`) or followed by a GOAWAY naming that stream the last processed, as Apple does when it closes a connection ‡; a **stall** (never answers); a **reset** (RST_STREAM); a **drop** (the connection destroyed mid-request).
- `goaway(lastStream?)` on every open connection with `{"reason": "Shutdown"}` ‡, and `dropConnections()`.
- It records every request: the connection and stream it came on, method, path, device token, headers (without `authorization`, which is kept apart), the decoded JWT and the body, and what it answered.

**What it does not imitate:**

- Apple's acceptance of a real topic, token, team or key, or of entitlements; real device tokens (any 64 to 200 hex digits pass).
- Apple's real stream limits and when it raises them, its idle timeout, when it sends GOAWAY by itself, and its TLS (certificate, ALPN refusal of HTTP/1.1).
- Delivery: nothing reaches a device or a simulator; no `apns-unique-id`, no feedback on delivery.
- Throttling as Apple applies it (the stand-in's 429 is scripted), the 4 KB limit for other push types, `apns-push-type` rules beyond the value's name, and anything about certificate (rather than token) authentication.
- On Bun, a scripted **reset** reaches a Bun client as a close without its code ([docs/spikes/B3-http2-under-bun.md](../../docs/spikes/B3-http2-under-bun.md)).

## The FCM stand-in

**What it imitates ‡:**

- HTTPS (HTTP/1.1 over TLS), the OAuth 2.0 token endpoint at `<origin>/token` and HTTP v1's `POST /v1/projects/<project>/messages:send`.
- **The token endpoint** ‡: a form with `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` and `assertion=<JWT>`; the assertion RS256 under the service account's key, `kid` its `private_key_id` if present, `iss` its `client_email`, `scope` including `https://www.googleapis.com/auth/firebase.messaging`, `aud` the token endpoint, `exp - iat` at most an hour, `iat` not more than a minute ahead (the stand-in's own tolerance), not expired. Answers `{"access_token", "expires_in": 3599, "token_type": "Bearer"}`, or 400 `{"error": "invalid_grant", "error_description": "…"}`.
- **The send endpoint** ‡: `Authorization: Bearer <access token>`, one it issued and not past its `expires_in`, else 401 `UNAUTHENTICATED`; then the message's checks, with Google's error shape `{"error": {"code", "message", "status", "details": […]}}`, FCM's own code in a `google.firebase.fcm.v1.FcmError` detail and a field in a `google.rpc.BadRequest` detail:

  | Check | Answer ‡ |
  | --- | --- |
  | Another path or method | 404 `NOT_FOUND` |
  | Body not JSON / no `message` object | 400 `INVALID_ARGUMENT` |
  | `message.token` missing or not of the stand-in's token form (20 to 4,096 of `A–Z a–z 0–9 _ : -`, **the stand-in's own approximation**) | 400 `INVALID_ARGUMENT`, FCM code `INVALID_ARGUMENT`, field `message.token` |
  | `message.data` values not all strings, or keys and values over 4,096 bytes | 400 `INVALID_ARGUMENT`, field `message.data` |
  | `android.priority` not `NORMAL` or `HIGH`; `android.ttl` not a duration like `86400s` | 400 `INVALID_ARGUMENT` |
  | A token `unregister`ed | 404 `NOT_FOUND`, FCM code `UNREGISTERED` |

- Success: 200 `{"name": "projects/<project>/messages/<id>"}` ‡.
- Scripted answers for a send that passed every check: any status, google.rpc status, FCM code and `Retry-After` (429 `RESOURCE_EXHAUSTED`/`QUOTA_EXCEEDED`, 503 `UNAVAILABLE`, 500 `INTERNAL`, 403 `SENDER_ID_MISMATCH`, `THIRD_PARTY_AUTH_ERROR`…); a **stall**; a **drop** (every connection closed, and the stand-in listening again on the same port). The token endpoint can be scripted to stall or refuse.
- `revokeAccessTokens()`, so every token issued answers 401 from then on.
- It records every send (path, `authorization`, content type, body, token, answer) and every token request (grant type, the assertion as sent and decoded, answer), and every access token it issued.

**What it does not imitate:**

- Google's acceptance of a real project, service account, key or registration token; real token formats.
- Delivery to a device or the emulator, collapse keys, topics, conditions, `notification` messages, `validate_only`, APNs or web settings inside an FCM message, and HTTP/2.
- Quotas as Google applies them (429 is scripted), Doze, priority lowering for data messages that show nothing ‡.
- Google's real token endpoint's other grant types and errors, key rotation, and the exact texts of its messages.

## Using them

```ts
import { loopbackTls, makeApnsTestKey, startApnsStandIn } from "../../tools/push-standins/src/index.ts";

const tls = loopbackTls(Date.now());            // a Result
const key = makeApnsTestKey();                  // a Result
const apns = await startApnsStandIn({ tls, keyId, teamId, publicKeyPem, topic, script: (request) => … });
// Point the push role at apns.origin with --apns-production, and trust tls.cert with --test-ca.
```

`relay/test/push/helpers.ts` (`standIns()`) starts both with fresh keys and writes the key files as the push role expects them. Until this workspace is linked by `bun install` (it has no dependencies, so nothing needs linking), it is imported by path.
