# K1. A browser's non-extractable key

Run 15 November 2026 on the owner's Mac by A7 (m2-design.md section 11, "Beside step 0"). Checks what section 5 assumes of a browser: Web Crypto's X25519 makes a **non-extractable** key, the key object survives in IndexedDB, `deriveBits` with it gives the Noise results the vectors expect, and Web Locks and BroadcastChannel work, on the hub's two kinds of page: HTTPS behind a clicked-through certificate warning, and the console's plain HTTP on 127.0.0.1.

## Result

**Passes in Chrome 157 and Chromium 156 on macOS, on both pages.** Safari and Firefox were **not run**: Firefox is not installed, and driving Safari needs its remote automation turned on, a system setting this run may not change. Nothing was found that makes the design's assumption wrong; until Safari and Firefox are run, section 13's "a browser that fails cannot be linked" is open for them.

## Setup

- A Node server serving one check page twice, under a strict policy (`script-src 'self'`, `style-src 'self'`, `connect-src 'self'`, no frames): over HTTPS with a self-signed P-256 certificate for 127.0.0.1, and over plain HTTP on 127.0.0.1, as the console listener is.
- The page is bundled with `bun build --target browser` from the protocol package's own `noise.ts` (A1's), so the Noise checks run the real state machine in the browser.
- Playwright drove the installed Chrome (`channel: "chrome"`) and Playwright's Chromium build, each with a persistent profile, headless. The HTTPS page was opened **without** `ignoreHTTPSErrors`: the warning page appeared and was clicked through ("Advanced", "Proceed"), as a person does.
- The code is in A7's scratch folder (`scratchpad/A7/k1/`: `page.ts`, `run.mjs`); it can move to `spikes/k1-browser-key/` if the owner wants it kept, and run again for Safari and Firefox.

## Checks

| Check | HTTPS after warning | Console (HTTP, 127.0.0.1) |
| --- | --- | --- |
| `isSecureContext`, `crypto.subtle`, `navigator.locks`, `BroadcastChannel` present | pass | pass (loopback is a secure context) |
| `generateKey({name: "X25519"}, false, ["deriveBits"])` gives a private key with `extractable: false` | pass | pass |
| `exportKey` of that key as `pkcs8`, `jwk` and `raw` refused | pass | pass |
| The key pair stored in IndexedDB (structured clone of the `CryptoKey`s), read back after a reload: still non-extractable, `deriveBits` against a fixed public key gives the same 32 bytes | pass | pass |
| The same after the browser was closed and started again on the same profile | pass | pass |
| The vectors' client static key imported as a non-extractable key (PKCS #8), used as the Noise `StaticKey` (`dh` through `deriveBits`): every IK and XXpsk3 vector of `app-noise.json` gives exactly the vector's messages, handshake hash and transport messages | pass (5 of 5) | pass (5 of 5) |
| `deriveBits` with a low-order public key (all zero) | refused, `OperationError` (Noise's `allZeroDh`, as `noise.ts` maps it) | same |
| Web Locks: a second tab's `request(..., {ifAvailable: true})` gets no lock while the first holds it; a waiting request gets it when the holder's tab closes | pass | pass |
| BroadcastChannel between the two tabs, both ways | pass | pass |

## Not checked

- Safari and Firefox (above). O12 ran Safari 27 by hand behind the warning for IndexedDB and `isSecureContext`, but not Web Crypto's X25519, non-extractability or Web Locks.
- A week's survival of the key (section 11 asks for it ‡): only a reload and a browser restart were run.
- A real hub's certificate and address on the home network: the page used 127.0.0.1 for both.
- Bun's own Web Crypto also makes non-extractable X25519 keys and refuses low-order keys the same way, so the app's unit tests run the same key code under `bun test` as the browser does.

## What it decides

The browser's static Diffie-Hellman is Web Crypto's `deriveBits` over a non-extractable X25519 key kept in IndexedDB (`app/src/platform/keys.web.ts`), behind the Noise code's `StaticKey` interface; no change to `noise-interface.ts` is needed. One tab holds the session, chosen with Web Locks; the others talk to it over BroadcastChannel (section 5).
