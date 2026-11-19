# `app/src/platform/`: per platform

What differs between the web build and the phone build (m3-design.md section 2), frozen by step 0 (0c). How a pair of files is chosen is in `split.ts`: `x.ts` binds the web build's file for tsc and Bun's tests and checks both files against the interface, `x-types.ts` holds the pair's types, `x.web.ts` is the web build's, `x.native.ts` the phone's. `app/tsconfig.native.json` type-checks the app as a phone resolves it. Until wave 1, each `.native.ts` compiles and refuses (`notBuilt`). A lint rule keeps the browser's globals in `*.web.ts(x)` files.

- `client-key.ts`: the record a client keeps per hub, its store, and `seq` (shared).
- `keys.ts`, `keys.web.ts`, `keys.native.ts`: making the client's key and its Diffie-Hellman; the browser's record in IndexedDB (K1).
- `save-file*.ts`: handing an export to the person: the browser's download; on a phone the share sheet (`save-file-share.ts`, wave 1).
- `alerts*.ts`: the system's notification and a tone, for a critical notification while the app is open; on a phone, an announcement and a vibration (`alerts-phone.ts`, wave 1: expo-notifications is not installed).
- `announce*.ts`: saying an alarm, a countdown or an urgent notice to a screen reader at once: iOS is told; a browser and Android read the live region (wave 1).
- `local-network*.ts`: the local network permission: Android 17's `ACCESS_LOCAL_NETWORK`, asked by the app; iOS's, explained before the first connection (wave 1).
- `intl*.ts`: what the phone's Hermes lacks of `Intl`: an English `Intl.ListFormat`, installed by the root layout (wave 1).
- `random*.ts`: where `crypto.getRandomValues` comes from: the browser's own; on a phone, whose Hermes has none, expo-crypto's, installed by `random-start.ts`, the entry's first import. Built (wave 0), not a refusal.
- Types only, for the phone (owners in m3-design.md section 10): `records.ts` (`HubRecords`, `BackupKeys`), `connect.ts` (the phone's `Connect` options), `finder.ts` (`HubFinder`), `scanner.ts` (`Scanner`), `ble.ts` (`BleCentral`, `GattLink`, `SetupSession`, `BluetoothUpdate`, `FirmwareServer`).

The same pattern holds in `src/hub/` for `start` (the root's client and arrived codes) and `digest`, and in `src/ui/` for `qr`, `file-input`, `fonts-ready` and `shell` (the frame around every screen).
