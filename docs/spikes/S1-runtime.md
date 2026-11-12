# S1. Node or Bun for the hub

Measured 12 November 2026. Code and raw results are in [`spikes/s1-runtime`](../../spikes/s1-runtime). Decides D94 and most of O7.

## Summary

- Bun used about a third of Node's memory at rest and started two to three times faster.
- Bun's install is under half the size of Node's on macOS, and about a quarter smaller on Linux.
- Every native add-on we need loaded and worked under both: USB serial, ONNX Runtime and WebGPU.
- Bun's built-in crypto lacks two ciphers: AES-CCM, which device packets use, and ChaCha20-Poly1305. A 70-line AES-CCM built on Bun's AES block cipher matched Node's built-in on 300 random cases and the published test case.
- Bun's single-file executable can carry USB serial inside it, but not ONNX Runtime or WebGPU. Those need their files beside the program, as they do under Node.
- Not tested: Windows, Linux on x64, running as a background service at boot, and behaviour over days.

On the three things the spike was asked to measure, Bun wins two and passes the third with one workaround. My recommendation is Bun, kept reversible: the hub code touches the runtime in three small places (web server start, SQLite driver, AES-CCM).

## What was run

A small hub-shaped service: a Hono web server with a WebSocket endpoint, SQLite through Drizzle, and a set of checks for each thing the hub must load. The same code ran on both runtimes; only the server start and the SQLite driver differ.

| | Node | Bun |
| --- | --- | --- |
| Version | 26.13.1 (current release line) | 1.4.2 on macOS, 1.4.4 on Linux |
| SQLite | better-sqlite3, a native add-on | `bun:sqlite`, built in |
| Form | Bundled to one JavaScript file, add-ons beside it | The same, and also a single-file executable |

Each variant was started three times; figures are the median. "Busy" is after 200 open WebSocket connections and 60,000 rows written in six bursts.

## Memory and start time

Memory is resident memory as the operating system reports it. macOS also has a "footprint" figure, the Memory column in Activity Monitor, shown in brackets.

| | Node | Bun, bundled | Bun, single executable |
| --- | --- | --- | --- |
| **macOS, Apple silicon** | | | |
| Time to first answer | 77 ms | 27 ms | 34 ms |
| At rest | 76 MB (28) | 22 MB (10) | 21 MB (9) |
| Busy | 207 MB (166) | 74 MB (29) | 75 MB (27) |
| With ONNX Runtime and WebGPU also loaded | 242 MB | 125 MB | not applicable |
| **Linux arm64, in Docker** | | | |
| Time to first answer | 64 ms | 28 ms | 32 ms |
| At rest | 69 MB | 26 MB | 29 MB |
| Busy | 151 MB | 45 MB | 55 MB |
| With ONNX Runtime and WebGPU also loaded | 212 MB | 90 MB | not applicable |

Where the memory goes, on macOS:

| Step | Node | Bun |
| --- | --- | --- |
| At rest | 76 MB | 22 MB |
| 5 connections open | 77 MB | 22 MB |
| 200 connections open | 80 MB | 27 MB |
| After 60,000 rows written | 207 MB | 75 MB |
| 20 seconds later | 207 MB | 75 MB |

Connections are cheap on both. The growth comes from the burst of database writes, and neither runtime gave the memory back within 20 seconds. Capping Node's heap at 64 MB lowered its busy figure only to 180 MB. A real hub writes a few rows a minute, so the at-rest figures are the ones that matter.

## Size on disk

| Piece | macOS arm64 | Linux arm64 |
| --- | --- | --- |
| Node runtime | 147 MB | 150 MB |
| Bun runtime | 62 MB | 107 MB |
| Bun single executable, with the hub code and USB serial inside | 63 MB | 110 MB |
| Hub code bundle | 0.5 MB (Node), 0.3 MB (Bun) | the same |
| better-sqlite3 (Node only) | 2 MB | 2 MB |
| USB serial add-on | 0.3 MB | 0.3 MB |
| ONNX Runtime (video only) | 88 MB | 25 MB |
| WebGPU, Dawn (video only) | 22 MB | 19 MB |

Hub without video: about 150 MB on Node; 63 MB (macOS) or 110 MB (Linux arm64) on Bun.

## Does everything load

| Check | Node | Bun |
| --- | --- | --- |
| SQLite through Drizzle | pass | pass |
| AES-128-CCM with an 8-byte tag (device packets) | pass | **fail: "Unknown cipher"** |
| ECDSA P-256 sign and verify (firmware signing) | pass | pass |
| Ed25519 verify (release signature) | pass | pass |
| X25519 key agreement | pass | pass |
| ChaCha20-Poly1305 from the built-in crypto | pass | **fail: "Unknown cipher"** |
| mDNS advertising | pass | pass |
| USB serial: add-on loads and lists ports | pass | pass |
| ONNX Runtime: one inference | pass | pass |
| WebGPU: a compute shader on the Mac's GPU | pass | pass |

Notes:

- **Bun's missing ciphers.** Bun 1.4.2 and 1.4.4 list 28 ciphers; neither AES-CCM nor ChaCha20-Poly1305 is among them, and Bun's Web Crypto has no AES-CCM either. Bun does have the AES block cipher and AES-GCM.
- **AES-CCM workaround.** [`src/ccm.ts`](../../spikes/s1-runtime/src/ccm.ts) builds AES-CCM from the AES block cipher alone. On both runtimes, macOS and Linux, it matched Node's built-in AES-CCM on 300 random cases with 4-, 8- and 16-byte tags, matched the first published test case in RFC 3610, and rejected every tampered tag. The firmware's mbedTLS will be a third check through the shared test vectors.
- **ChaCha20-Poly1305.** The app channel is planned on the `@noble` JavaScript libraries, which do not use the runtime's cipher. Those libraries were not run in this spike.
- **Linux.** USB serial needs the `udev` package, which normal Linux systems have and the bare container did not; with it installed, both runtimes listed ports. The container has no GPU, so WebGPU loaded and reported no adapter on both.
- **Bun single executable.** USB serial worked from inside the executable. ONNX Runtime and WebGPU did not, because each needs companion library files next to it. Run as a bundle with those files beside it, Bun passed both.
- **better-sqlite3 is tied to the Node version.** It had to be rebuilt when moving from Node 22 to 26 on macOS, and it compiled from source in the Linux container, which needs Python and a compiler. Drizzle 0.45 has no driver for Node's built-in SQLite, so Node needs this add-on.
- **One unexplained failure.** One of three starts of the Bun executable in the Linux measurement run exited with an error I did not capture in full. Twenty further starts all succeeded.

## Not tested

- Windows, and Linux on x64.
- Installing either as a background service that starts at boot. On macOS that needs an administrator password.
- A real Raspberry Pi.
- Memory and stability over days or weeks.
- A real device on the USB serial port.
- The `@noble` libraries on either runtime.

## Recommendation

Use Bun for the hub, on these conditions:

1. The hub keeps its three runtime-specific pieces (server start, SQLite driver, AES-CCM) behind small interfaces, so moving to Node later is a day's work.
2. The AES-CCM code is tested against the shared vectors and the firmware on every build.
3. Before the hub milestone, the untested items above are checked: Windows and x64 on hosted build machines, a service at boot, and a week-long run.
4. The video worker is shipped as a runtime with its add-on files beside it, not as a single file. It can run on Bun, since ONNX Runtime and WebGPU both worked there.

The memory and size gaps are real but small in absolute terms on a modern computer. What this spike cannot show is which runtime is steadier over months of unattended running, and that matters more for an alarm hub than 50 MB of memory. That is the reason for condition 3.
