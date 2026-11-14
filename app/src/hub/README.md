# `app/src/hub/`: the channel client

Owner **A7** (m2-design.md section 11). The connection, the Noise session and reconnection (1, 2, 4, then every 10 s ‡: `APP_RECONNECT_MS`), requests with their `id` and `seq` (the next `seq` written to storage before it is sent), events with their `rev`, file chunks; all on `@hsn/protocol/app`, whose types are frozen by step 0. One tab holds the session for the browser (Web Locks and BroadcastChannel, K1).
