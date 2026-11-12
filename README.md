# home-security-next

A self-hosted home security system: battery door sensors and a siren on long-range radio, a hub that runs on the user's own computer, and phone and web apps that reach it from anywhere through an encrypted relay.

This repo is a fresh start. The earlier system in `../home_security` is the reference for behaviour and the source of the pieces worth carrying over.

## Status

Requirements, architecture, spikes, and the device protocol in TypeScript (`packages/protocol`) and C++ (`firmware/core`), both checked against the same test vectors. Run `bun install`, then `bun run check:all`; `bun run check:firmware:gcc` repeats the firmware tests under GCC in Docker.

## Documents

- [Architecture and decisions](docs/architecture.md)
- [Software requirements](docs/requirements/software.md)
- [Board requirements](docs/requirements/sensor-board.md) (one board for sensor, gateway and siren controller)
- [Technology choices](docs/stack.md)
- [Device protocol](docs/protocol.md)
- [Build plan](docs/build-plan.md)
- [Spike reports](docs/spikes/)

## Planned layout

Folders are created as code lands.

```
firmware/
  core/              portable C++17, no heap, no platform includes
  roles/             sensor, siren, gateway
  platform/psa/      packet encryption on PSA Crypto, shared by the host tests and the chip
  platform/esp-idf/  ESP32-S3 implementation of the core's interfaces
  tests/             host tests against fake hardware
hub/                 one TypeScript service with SQLite: API, schedules, notifications, firmware store
  video/             video worker: cameras, motion models on WebGPU, object detection, recording
relay/               remote-access relay
app/                 one React Native (Expo) codebase: phone app, and the web app the hub serves
packages/
  protocol/          packet codec, app messages, encryption and test vectors shared by hub, relay and app
hardware/
  board/             KiCad project: one board for sensor, gateway and siren controller
  siren-addon/       12 V switching add-on
docs/
```

## Build order

Details in [docs/build-plan.md](docs/build-plan.md).

1. Order the development boards; run the spikes that need no hardware (hub runtime, radio rules, alarm standard, per-hub names, push).
2. Door to siren in software: protocol, firmware core, three device roles and a minimal hub, joined by a simulated radio.
3. Door to siren on the bench when the boards arrive, with the range, timing and radio spikes.
4. Board design starts here and runs alongside the rest, because manufacture takes weeks.
5. Hub and the app's web build.
6. Pairing and firmware updates.
7. Relay and push service.
8. Phone-only features.
9. Cameras and video.
