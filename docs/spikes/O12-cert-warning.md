# O12. The web app behind a one-time certificate warning

Run 12 November 2026 on the owner's Mac. Code is in [`spikes/o12-cert-warning`](../../spikes/o12-cert-warning). Checks D105's fallback: when a router blocks the hub's name, a browser opens the hub's direct address over HTTPS with a certificate it does not trust, and the user clicks through the warning once.

## Result

Everything the web app needs worked in Chrome and Safari after the warning was clicked through. Firefox was not tested because it is not installed.

## Setup

- A Bun server on the Mac's home-network address, 192.168.5.66, serving the same check page two ways:
  - over HTTPS with a self-signed certificate for that address;
  - over plain HTTP, as a baseline.
- The page runs each check in the browser and posts the results back to the server, so the record is the browser's own report.
- The owner opened the HTTPS address in Chrome 157 and Safari 27.0.1 and clicked through the warning. The plain-HTTP baseline ran in the Claude desktop app's built-in browser, which is Chrome 156.

## Checks

"Needed" means the web app depends on it under D105 and [stack.md](../stack.md). The rest are recorded for information.

| Check | Needed | HTTP baseline (Chrome 156) | HTTPS after warning, Chrome 157 | HTTPS after warning, Safari 27 |
| --- | --- | --- | --- | --- |
| Random numbers | yes | pass | pass | pass |
| Our JavaScript encryption: X25519, ChaCha20-Poly1305, SHA-256 (`@noble`) | yes | pass | pass | pass |
| Request to the hub on the same address | yes | pass | pass | pass |
| Live connection (WebSocket) to the hub | yes | pass (`ws`) | pass (`wss`) | pass (`wss`) |
| Store this browser's key in IndexedDB | yes | pass | pass | pass |
| localStorage | yes | pass | pass | pass |
| Page counts as secure (`isSecureContext`) | no | **false** | true | true |
| Camera interface, for scanning a QR code | no | **missing** | present | present |
| Browser's built-in crypto (`crypto.subtle`) | no | **missing** | works | works |
| Clipboard interface | no | **missing** | present | present |
| Service worker | no | **missing** | **refused: SecurityError** | registered |

## What this means

- D105 works as designed in both browsers tested. The page counts as secure after the click-through, so even the browser features we don't depend on are mostly there.
- Chrome refuses service workers on such a page, as the S4 research found. The web app must not rely on one: no offline cache and no background work. The hub serves the app every time, which it does anyway.
- On plain HTTP our encryption still works, but the camera and clipboard are missing. Plain HTTP stays ruled out (D79): the app could not scan a QR code, and anything on the home network could alter the page as it loads.
- The browser warns about the certificate on every new visit until the user adds it to their trusted certificates. "One-time" in D105 should read "each time the browser asks". A later improvement: the hub keeps the same certificate, so a user who trusts it once is never asked again.

## Not covered

- **Firefox:** not installed on this Mac.
- **Phones:** iPhone Safari and Android Chrome were not run. The simulators could cover this.
- **Key surviving a reload:** neither browser sent a second report, so it is not shown that the stored key survives a reload behind the warning. Within one visit it was stored and read back.
- **Camera and clipboard permission:** both interfaces were present, but permission was not requested, so actual camera use behind the warning is untested.
- **The browser's own key storage:** Chrome and Safari may treat site data under an untrusted certificate differently over weeks. This was a single session.
