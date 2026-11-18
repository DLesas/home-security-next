# `packages/protocol/verify/`: owner A9

M2, step 1 (docs/m2-design.md section 11). Independent checks of the committed vectors, written from the specifications without reading the library in `packages/protocol/src`: `verify-vectors.mjs` for the device protocol, `verify-app-vectors.mjs` for the app's. `bun run verify:vectors` runs the first.

M4 (docs/m4-design.md section 11): `verify-relay-vectors.mjs`, B1's, checks `relay-*.json` the same way (its own XN on Node's X25519, Node's ChaCha20-Poly1305); `verify-vectors.mjs` calls it.
