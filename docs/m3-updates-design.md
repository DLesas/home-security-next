# M3 updates design: firmware updates

Proposed 2026-11-18 and revised the same day with the reviewer's rulings and the reconciliation with `docs/m3-design.md` (the phone build and Bluetooth pairing) and `docs/m4-design.md` (the relay), for review before any code is written. It designs four rows of milestone M3 in [build-plan.md](build-plan.md): two-slot updates with trial boot and rollback; the hub signing key, firmware store, rollout and holding updates for armed sensors; update over Wi-Fi; update over Bluetooth from the phone. It also designs the device key change after a hub restore that M2 9 owes to M3 (section 7). What it needs from the two sibling designs, and where they do not yet fit, is in section 10. The three designs share one app channel version 2, one sequence of database migrations and one module order, frozen together by one joint step 0, whose order of work the coordinator writes; section 10 lists what this design contributes to it.

Proposed decisions are numbered D134 to D141 (the relay design has D125 to D131, the phone design D132 and D133) and listed in section 12.

"HD" means a section of [hub-design.md](hub-design.md), "FD" of [firmware-design.md](firmware-design.md), "M2" of [m2-design.md](m2-design.md), "HN" of [hardware-notes.md](hardware-notes.md), "§" of [protocol.md](protocol.md). D and O numbers refer to [architecture.md](architecture.md); UP, FW, GW, SR, HB, AP and PR numbers to [software.md](requirements/software.md). Values marked † are the protocol's provisional values. Values marked ‡ are either this design's own provisional choices, to be set by a measurement or confirmed in review, or facts about the ESP32-S3, ESP-IDF, its bootloader, Bluetooth or flash stated from memory; both must be checked before anything depends on them. Figures marked *(estimate)* are arithmetic on ‡ inputs.

The design in ten lines:

- The board's 8 MB flash holds two 3.5 MB application slots. ESP-IDF's own bootloader, with rollback on, runs a new image on trial; any reset before the image confirms itself boots the old one again.
- An image confirms itself only after it has opened a packet from its own hub: for a sensor, the reply to its Started. Until then it never sleeps deeply, so a deep-sleep wake cannot roll it back by accident.
- Two signatures. The publisher signs a release (Ed25519, as hub releases); only the hub checks it. The hub then signs a 128-byte image header (P-256, the key devices received at pairing); devices check that before they write a single byte.
- One transfer format on every link: the device pulls the image in pieces (`Get`, `Data`), from the hub over its WebSocket or USB, or from the phone over Bluetooth. Pieces carry a CRC; the whole image a SHA-256 under the signature. Resuming is asking from the last checkpoint.
- A device keeps doing its job while it downloads: a sensor still reports its door over LoRa, a gateway still forwards. It is blind only for the restart into the new image, about a second ‡, and only while disarmed.
- The hub keeps at most four images in its data folder (about 4.5 MB *(estimate)*), never in backups. A new core module, `firmware`, decides every offer, hold and go-ahead; the shell stores, signs and serves the bytes, which never enter the core.
- A rollout starts with one device of each role, waits an hour ‡, then does the rest: sirens and gateways one at a time, sensors a few at a time and only while disarmed, nothing installed during a countdown, an alarm or a site move.
- Bluetooth opens on a sensor only after the hub tells it to over LoRa, with a one-time session key the hub gives the phone; a passer-by cannot open a session or hold the sensor awake.
- Update over LoRa is out: one image would take about eight hours of the gateway's whole legal airtime at the fastest rate (section 5).
- After a restore, the hub acts on no packet sealed under a device's old key: it answers each with a new key, sealed under the old one, and the device repeats what it was saying under the new key, so nothing recorded before the restore can be replayed (section 7).

## 1. What this builds, and what it finds

### The build plan's rows, and where each is designed

| M3 piece | Requirements | Here |
| --- | --- | --- |
| Two-slot updates with trial boot and rollback | UP1, UP2, FW8 | Section 2 |
| Hub signing key, firmware store, rollout, holding updates for armed sensors | UP3, UP4, UP7–UP9, HB16, HB17, D35, D84, D91 | Sections 3 and 4 |
| Update over Wi-Fi | UP5, GW7, SR8 | Section 5 |
| Update over Bluetooth from the phone | UP6, AP3, PR3 | Section 5; the screens in `docs/m3-design.md` |
| Spike S9, its firmware-transfer half | UP6 | Section 5, "What spike S9 must measure" |
| The device key change after a restore, owed by M2 9 ("What a restore cannot undo, for devices") and §4's "Known limits" | D53, D122, O16 | Section 7 |

HB17 (create and store each device's key at pairing) is built (HD 9); updates only derive a Bluetooth session key from it (section 5).

### What exists today

Read from the code on 2026-11-18:

| Piece | State |
| --- | --- |
| Firmware core, roles, host bench (`firmware/core`, `roles/*`, `platform/host`, `platform/psa`) | Built and tested on the host. No code mentions slots, trial or rollback. `Hal` has `usb` and `network` links; `LinkKind` is `usb` or `network`; a sensor has no network link (`services.hpp`: "a sensor has no network link until M3"). `StoreKey` uses 0x00–0x04 of the core's range 0x00–0x0F |
| **ESP-IDF platform layer** (`firmware/platform/esp-idf/`) | **Absent.** No folder, no `app_main`, no partition table, no `sdkconfig`, no component manifest, no IDF build; FD 1's table lists the folder as planned. The firmware README says the IDF build "will wrap the same two libraries". M1b has not started; the boards are on order. **ESP-IDF is not installed on this Mac**; installing it needs the product owner's approval |
| Crypto on the device | `hsn_psa` implements `PacketCipher` on PSA (TF-PSA-Crypto 1.1.0 on the host, the version ESP-IDF v6.1 ships). SHA-256 is used for the hub identity. No signature verification yet |
| Pairing data (§9) | Carries the hub's 64-byte P-256 public key; stored in the pairing record (FD 5). The vectors keep `signingPrivateKey` (RFC 6979's test key) "for later firmware-signature tests" |
| The hub's signing key | `hub_keys.signing_private` (PKCS #8) and `signing_public`, made at first start with Web Crypto (`shell/advertise/hub-keys.ts`); the hub identity is the first 8 bytes of SHA-256 of the public key. In backups (D53, M2 9) |
| "Update available" flag | In the reply (§6, bit 2) and in both codecs; the hub always sends `NO_UPDATE` (`core/sensors/reply.ts`) |
| Hub updates (M2 9) | Built: `.hsnr` releases signed with Ed25519 (`node:crypto`), `PUBLISHER_KEYS` empty until the product owner gives the key (D123), staging in pieces, the launcher's switch and rollback. This design reuses its release checks, its upload path and its rule for work in pieces |

### What does not change

- Protocol version 1 and its rules (§3, §4, §11). New message types and new fields at the end of a body only.
- Every existing packet, receiving rule and binding. The new packets follow §4's rows for their receiver.
- The firmware core's rules (FD 1): no heap, no exceptions, no floating point, one task, a non-blocking core, every buffer a member.
- The hub's core shape, durability classes, send gate and loop limit (HD 2, HD 4, HD 5, M2 3). The lockstep wire stays at version 2: new commands travel in `control`, transfer frames in `frame`.

## 2. Two slots, trial boot and rollback (UP1, UP2)

### The flash layout

The board is an ESP32-S3-WROOM-1 with 8 MB of flash and no PSRAM on our board (sensor-board.md); the Olimex development board has the same 8 MB (dev-board-choice.md). The partition table is written once over serial at manufacture and **never changed over the air**, since a power cut while the table is rewritten leaves a board that cannot boot ‡. So it is chosen now, with room to spare.

| Name | Type | Offset | Size | Holds |
| --- | --- | --- | --- | --- |
| bootloader | — | 0x0 ‡ | 32 KB | ESP-IDF's second-stage bootloader with rollback on |
| partition table | — | 0x8000 ‡ | 4 KB | this table |
| `nvs` | data, nvs | 0x9000 | 24 KB | records (FD 5), plus the update record (below) |
| `otadata` | data, ota | 0xF000 | 8 KB | which slot boots and each slot's state: two 4 KB copies, the newer valid one wins ‡ |
| `phy_init` | data, phy | 0x11000 | 4 KB | radio calibration ‡ |
| — | gap | 0x12000 | 56 KB | unused: application partitions start on a 64 KB boundary ‡ |
| `ota_0` | app, ota_0 | 0x20000 | 3.5 MB | slot A |
| `ota_1` | app, ota_1 | 0x3A0000 | 3.5 MB | slot B |
| `spare` | data, undefined | 0x720000 | 896 KB | reserved, unused; room for a crash dump or display data later without moving the slots |

- **No factory partition.** Two slots already give a working image to fall back to; a third copy would cost 3.5 MB and need its own update path. The first serial flash writes `ota_0` with `otadata` blank, which boots `ota_0` ‡.
- **Image size.** About 1.5 MB *(estimate)*: Wi-Fi, lwIP, NimBLE, PSA crypto, the WebSocket client, mDNS and our code. D103 says the size is checked when the first board build exists; a slot of 3.5 MB leaves more than double. The `spare` partition can become slot space only by a serial reflash.
- **The bootloader's size.** With rollback on, the bootloader must fit before 0x8000 ‡. If the first build does not, the table moves to 0x10000 and every offset after it, before any board ships.
- **Ruled** (R7): this table, to be confirmed on the first ESP-IDF build. Proposed with the trial rules below as **D134**.

### States of an image

ESP-IDF keeps a state per slot in `otadata` (HN 7, labelled P there):

| State | Set by | Meaning here |
| --- | --- | --- |
| `NEW` | `esp_ota_set_boot_partition` | Selected, not yet booted |
| `PENDING_VERIFY` | the bootloader, on its first boot | On trial |
| `VALID` | `esp_ota_mark_app_valid_cancel_rollback` | Confirmed |
| `INVALID` | `esp_ota_mark_app_invalid_rollback_and_reboot` | Refused by the image itself |
| `ABORTED` | the bootloader, finding `PENDING_VERIFY` at a boot | Reset while on trial: rolled back |

**What marks a slot good:** only `confirm()` in the image itself, after the health condition below. **What makes the bootloader fall back:** any reset of any kind while the image is `PENDING_VERIFY` (power cut, brown-out, watchdog, panic, software restart, deep-sleep wake, which goes through the bootloader, HN 6); an explicit `reject()`; and a selected image that fails the bootloader's own image check ‡. Rollback needs `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE`, off by default (HN 7, P).

### Healthy, per role

An image is healthy when it has proved, end to end, that it can still do its job and be updated again: its key, storage, crypto and at least one path to the hub work. That means **it has opened a packet from its own hub**, its radio has finished one operation without a fault, and no fatal error has been raised (FD 4, `Health`).

| Role | Healthy when | How long that usually takes | Trial deadline ‡ |
| --- | --- | --- | --- |
| Sensor | The reply bound to its Started arrives (§6: the hub always replies to a Started). That proves transmit, receive on 869.525 MHz, the key, the counter and the stored settings | 1 to 3 s: the event listen time (§8) | 10 minutes: the end of Started's retry run (§7, "No reply from the hub") |
| Siren | A hub command or settings packet opens on either path, and one LoRa transmission completed. The hub sends "report now" (§6, action 3) on both paths to a siren whose Started says it is on trial | 1 to 5 s after its WebSocket is up | 5 minutes |
| Gateway | Welcomed on its link (USB or Wi-Fi), its settings opened, and its continuous receive started without a fault | 1 to 5 s | 5 minutes |

**A sensor that cannot hear the hub for minutes.** It keeps trying Started on the event schedule (2, 5, 10 s, then every 60 s) and stays in light sleep between tries, at about 0.24 mA for the chip (HN 6), so ten minutes cost about 0.04 mAh *(estimate)*. The hub gave it the go-ahead seconds before it restarted (section 4), so ten minutes of silence right after the restart most likely means the new image is at fault. Rolling back is the safe reading. If it was a real outage, the rollout pauses, the hub records why, and a person resumes it; the update is offered again.

### Rules on a trial image

| Rule | Why |
| --- | --- |
| `Device` refuses `deep` while the running image is on trial; the role's wake is capped at `light` | A deep-sleep wake would roll it back (HN(a)42; FD 10 already says so) |
| The stuck-awake bound (FD 6, 20 minutes for the sensor) becomes the larger of the role's and 40 minutes ‡ while an update is active or the image is on trial | A Bluetooth session, a ten-minute trial and their margins must not be taken for a stuck state machine |
| No transfer starts while the running image is on trial | **The image in the other slot must be the confirmed one** whenever that slot is written; by construction a board always holds one working image |
| Stored records change format only by adding fields at the end, and every image reads the fields it knows | After a rollback, or a later downgrade through the hub, an older image must still read the pairing record, the resume point and the settings; one that read "not paired" would be lost until paired again |
| The retained block may change layout; a mismatch is a cold start (FD 2) | Already the rule; a sensor updates only while disarmed, so a cold start costs nothing |

### Behind the platform interface

Three additions to the core's HAL and services, so the host simulator can run every rule without a board. Ruled (R1): the image passes through the core's `UpdateService` into this interface; the platform does not run the transfer on its own.

```cpp
namespace hsn::device {
struct BootImage {                      // what this boot is running
  protocol::FirmwareVersion version;
  bool on_trial;                        // PENDING_VERIFY
  bool rolled_back;                     // the other slot was ABORTED or INVALID since the last confirm
  protocol::FirmwareVersion failed;     // that slot's version, when rolled_back
};
class FirmwareSlots {                   // ESP-IDF: esp_ota_ops and esp_partition on the slot not running
public:
  virtual BootImage running() = 0;
  virtual std::uint32_t capacity() = 0;                          // bytes of the other slot
  virtual HalError erase(std::uint32_t offset) = 0;              // one 4 KB sector: ≤ 400 ms ‡
  virtual HalError write(std::uint32_t offset, ByteView bytes) = 0;      // ≤ 4 KB, inside erased space
  virtual HalError read(std::uint32_t offset, MutableByteView out) = 0;  // ≤ 4 KB
  virtual HalError select() = 0;        // esp_ota_set_boot_partition: checks the image format, marks NEW
  virtual HalError confirm() = 0;       // mark valid
  virtual HalError reject() = 0;        // mark invalid; the caller then restarts
protected: ~FirmwareSlots() = default;
};
class UpdateCrypto {                    // hsn_psa: PSA on the host and the target
public:
  virtual void sha256_start() = 0;
  virtual void sha256_add(ByteView bytes) = 0;
  virtual void sha256_finish(MutableByteView digest) = 0;        // 32 bytes
  virtual bool verify_p256(ByteView public_xy, ByteView digest, ByteView signature_rs) = 0;
  virtual void session_key(ByteView nonce, std::uint32_t address, MutableByteView out) = 0;  // section 5
  virtual void hmac_sha256(ByteView key, ByteView message, MutableByteView out) = 0;
protected: ~UpdateCrypto() = default;
};
}
```

- `Hal` gains `FirmwareSlots& slots`, `UpdateCrypto& update_crypto`, and `Link* bluetooth` (`LinkKind::bluetooth`, section 5); a sensor also gains its `network` link, used only for updates (§10).
- `session_key` uses the device key the platform loaded from the pairing record, so the raw key stays where `PacketCipher` already keeps it.
- Erases are one sector per call so each stays inside FD 3's 500 ms bound: a 64 KB block erase can take up to about 2 s ‡. The ESP-IDF implementation writes with `esp_partition_erase_range` and `esp_partition_write` on the slot `esp_ota_get_next_update_partition` names, not `esp_ota_begin` and `esp_ota_write`, so a download can resume after a reset with nothing to reopen ‡; `select()` then calls `esp_ota_set_boot_partition`, which checks the ESP image format ‡.
- **`UpdateService`**, a new core service beside `SetupService` (FD 4), owns the update: the offer, the transfer frames, two 4 KB sector buffers, the checkpoint, the read-back hash, the signature check, the trial and the Bluetooth session. It has no clock of its own, takes `now`, and returns its own `Wake`, which `Device` merges with the role's. Roles call it where they open and send packets (they own the keys and the receiving rules, §4): `update_flag(reply)`, `offer(body)`, `healthy(now)`, and `next_packet()` for the update query and status they must send.
- **`Device`** passes link frames that start with 0xF2 to `UpdateService`, as it passes 0xF1 setup messages to `SetupService` (FD 2, step 3); applies the trial rules above; and adds `BootImage` to Started (section 5).
- **Store key 0x05 `update`**, in the core's range: format byte, the 128-byte image header, the stage (partial or verified) and the bytes written up to the last checkpoint; at most 134 bytes. Written at the start, every 64 KB ‡ (about 24 writes per image), when verified, and erased when confirmed, refused or discarded. `erase_all_but_role` removes it.

## 3. Signing (D35, D84, UP3, UP4)

### Two signatures

| | The publisher's | The hub's |
| --- | --- | --- |
| Key | Ed25519, the product owner's (D123), compiled into the hub as `PUBLISHER_KEYS` | P-256, `hub_keys.signing_private`, one per hub (D35) |
| Over | A release file's manifest, which binds the image by its SHA-256 | A 128-byte image header, which binds the image by its SHA-256 |
| Checked by | The hub only, when a release is added | Every device, before it writes anything |
| Label in the signed bytes | `hsn-firmware/1`, a zero byte | `hsn-image/1`, a zero byte |

Devices never see the publisher's signature: they would need Ed25519 as well, and owners' own builds have none (D84). The S3 has no ECC hardware (HN 2), so the device verifies once per update, in software, through PSA; the time is unmeasured (HN(b)) and is taken once, before any flash write, so it costs no more than a second ‡ of a download.

The two labels differ from each other and from hub releases' `hsn-release/1` (M2 9), so a signature made for one kind of file can never pass as another, even with one publisher key for both (section 12, question P1). This section is proposed as **D136**.

### The publisher's firmware release file

`hsn-firmware-<version>.hsnf`, laid out exactly as a hub release (M2 9, `shell/update/release.ts`), so the hub reuses its reader:

| Bytes | Field |
| --- | --- |
| 0–3 | `HSNF` |
| 4 | format 1 |
| 5–7 | zero |
| 8–11 | the manifest's length, u32 little-endian, at most 64 KB ‡ |
| 12… | the manifest, UTF-8 JSON, strict: `{kind: "firmware", version: "MAJOR.MINOR.PATCH", target: "esp32s3", roles: [1, 2, 3], payloadBytes, payloadSha256, madeMs}` |
| next 64 | Ed25519 over `hsn-firmware/1`, a zero byte, and every byte before the signature |
| rest | the payload: the ESP-IDF application image as `idf.py build` writes it, uncompressed |

The hub refuses, in order: a wrong magic, format or manifest (`badFile`); a signature no publisher key verifies (`badSignature`; every real file until D123's key exists); a target other than `esp32s3`, or an application image whose header names another chip (`wrongTarget`); a payload over the slot's 3.5 MB (`tooLarge`); a payload whose length or SHA-256 differs (`badFile`). The application image's own header is checked for the ESP magic byte 0xE9 and chip id 9 (ESP32-S3) ‡, and its app description for a version string equal to the manifest's ‡.

### The device image header

128 bytes, little-endian, made and signed by the hub for every image it stores, official or not:

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 4 | `HSNI` |
| 4 | 1 | format 1 |
| 5 | 1 | flags: bit 0 an owner's own build (not from the publisher); others zero |
| 6 | 1 | roles: bit 1 sensor, bit 2 siren, bit 3 gateway (D103: all three for every image today) |
| 7 | 1 | target: 1, an ESP32-S3 board of ours |
| 8 | 3 | version: major, minor, patch (§3) |
| 11 | 1 | zero |
| 12 | 4 | image bytes |
| 16 | 32 | SHA-256 of the image bytes |
| 48 | 8 | the identity of the hub that signed it (§9) |
| 56 | 8 | zero |
| 64 | 64 | ECDSA P-256 over SHA-256 of `hsn-image/1`, a zero byte and bytes 0 to 63: `r` then `s`, 32 bytes each, big-endian |

The **image id** is bytes 16 to 23, the first 8 bytes of the image's hash. The file a device pulls is this header followed by the image; offsets in transfer frames count from the header's first byte.

The hub signs with `@noble/curves`' P-256 (RFC 6979, deterministic), in `packages/protocol`, from the private scalar the shell exports from `hub_keys` through Web Crypto. Deterministic signatures keep lockstep runs and vectors byte-identical; Web Crypto's are randomised ‡.

### What a device checks, in order

1. Magic, format, target, zero bytes: else refused `badHeader`.
2. Hub identity equals the paired one: else `wrongHub`.
3. Its own role's bit is set: else `wrongRole`.
4. Image bytes ≤ `slots.capacity()`: else `tooLarge`.
5. The signature verifies under the paired signing key (§9's 64 bytes, given to PSA with a leading 0x04, HN(a)5): else `badSignature`.
   Nothing has been written to flash before this point.
6. While writing: each `Data` frame's CRC-32; a bad one is dropped and asked again.
7. After the last byte: the slot read back, SHA-256 equal to the header's: else `hashMismatch`, and the download starts again from zero.
8. At "install now": `slots.select()`, which checks the ESP image format ‡: else `imageCheck`.

There is no version check on the device: the hub decides which version a device runs, and going back to an older image is how a bad release is undone. Anti-rollback is not designed in (section 12, P4).

### The hub's signing key

| Question | Answer |
| --- | --- |
| Where it lives | `hub_keys` in `hub.db`, written through at first start, readable only by the hub's account; the private half leaves the shell only into a backup (HD 5, M2 9). It never enters the core, a record or an event |
| How devices learn it | In the pairing data (§9), over USB today and over Bluetooth from M3 (`docs/m3-design.md`). Every device paired to a hub holds the same key |
| Hub restore | The backup holds it (D53), so a restored hub signs with the same key and has the same identity; every device keeps accepting its images. The device-key change M2 13 plans for after a restore does not touch it |
| Hub replaced without a backup | A new key and a new identity. The devices' own keys are lost too, so each is paired again anyway (factory reset, D89), and pairing gives the new signing key |
| Changing the key | Not possible without pairing every device again: the identity devices use to find the hub (§10) is the hash of this key. Nothing in M3 rotates it |
| A compromised hub | Can sign anything for its own devices (D35, accepted) |

### An owner's own build

D35 and D84: an owner may run firmware they built.

- On the console only (permission C and *manage system*, M2 6): `firmware.upload` with `own: {version}`, or `hsn firmware add <file.bin> --own --version 1.4.0`. The file is the raw application image `idf.py build` writes.
- The hub checks the ESP header and chip as above, that the version given equals the app description's ‡, and the size. The console says, before going on: "this build was not made or checked by the publisher; every device you roll it out to will run it". The person confirms.
- The hub signs it with flag bit 0 set and stores it as kind "own build". The app shows it as such on every screen that names a version.
- It is rolled out exactly as an official image. Nothing else about it differs.

## 4. The firmware store and rollout on the hub (UP7–UP9, HB16, HB17)

### Where images are kept (D112)

- **In the data folder**, `firmware/`: for each image, the payload once (`<sha256>.bin`, the official file's payload range copied out, or the own build) and nothing else; the 128-byte header and the official manifest and signature are in the database (below). It is data, not program, so it is not in the program tree (M2 9, "Two trees").
- **At most four images ‡ and 8 MB ‡.** In practice: the release being rolled out, the one before it, and an own build, about 4.5 MB *(estimate)*. A fifth is refused (`storeFull`) until a person removes one; the hub never removes one by itself, and refuses to remove an image a rollout uses.
- **The upload** lands in `uploads/` as M2 6 has it, capped at 8 MB ‡ for a firmware job, deleted when the job ends.
- **Against the 500 MB**: the folder in ordinary running goes from about 296 MB (M2 3) to about 304 MB, and at a hub version switch, briefly, from about 575 to 583 MB. Firmware is in no backup: it can be added again, and a restored hub learns what each device runs from its Started.
- Proposed as **D140**.

Staging is a file job in pieces of 256 KB ‡ between the loop's turns (M2 3, "The loop's time"), as a hub release is: check the header, manifest and signature; hash the payload; copy it out; make and sign the header; `fileReady {firmwareStaged}`.

**Where a release comes from.** In M3, a file on the console (`firmware.upload`, `hsn firmware add`). From M4, through the relay as `docs/m4-design.md` section 6 has it: the relay's `release.offer` lists firmware files beside hub releases; the shell gives the core `releaseOffered`; `firmware` (not `upkeep`, which owns the hub's own updates) takes the entries whose manifest says `kind: "firmware"`, records `firmware_release_offered` once per version, notifies the `updates` category, and keeps them for `firmware.offers`. `firmware.fetch {version}` emits the relay design's `fileJob {fetchRelease {file, bytes, sha256}}` with `release: "firmware"`; it lands in `uploads/` and its outcome runs `stageFirmware` as an upload would, ending in `fileReady {firmwareStaged}` or a failure with section 3's reasons. A listing over 8 MB is refused before fetching. As there, nothing is fetched until a person asks, and nothing reaches a device until a person approves a rollout.

### Where it sits in the core and the shell

**A new core module, `firmware`**, placed in `step.ts`'s order by the joint step 0. This design needs only that it come after `alarm` and `site` and before `sensors`, so a reply built in `sensors` reads the current offer through `firmware`'s view; placed after `sensors` it would still work, one step late, as `slots` does (HD 2). `SendRef` numbers move with any insertion, which is harmless (M2 2).

| Module | Change |
| --- | --- |
| **`firmware`** | **new.** Owns the store's index, releases offered by the relay, rollouts, each device's update state, Bluetooth sessions, the transfer grants in force. Acts on: `accepted` Started, update query and update status packets; `armedChanged`; countdown and alarm through `alarm`'s view; the site move through `site`'s view; `releaseOffered` (its firmware entries); `fileReady`; its operations; `transferProgress`; `linkClosed`; timers (soak, trial watch, session expiry, reminders, the gateway's busy bound). Emits: `updateOffer` messages, `transferGrant` and `transferRevoke` effects, `fileJob`, `bluetoothSession` effects, decisions, rows written now |
| `sensors` | Sets the reply's "update available" flag from `firmware`'s view; replies to any heartbeat while an offer waits for that sensor (HD 8's "when to reply" gains this case); seals and sends `updateOffer`s to sensors, on LoRa or on the sensor's WebSocket; accepts a sensor's packets on a network link while it updates |
| `sirens` | Seals and sends `updateOffer`s, one packet at a time as settings are (§7); sends "report now" to a siren on trial |
| `gateways` | Seals and sends `updateOffer`s inside the session |
| `intake` | Update query and status allowed on every path (§5) |
| `links` | A transfer frame (0xF2) that reaches the core, because no grant covers it, is rejected and counted (`transferNotGranted`, HD 6's `rejects`) |
| `notify` | The `updates` category (D75: can be turned off) |
| `upkeep` | A hub version switch also waits while any device is installing or on trial |
| `app` | Device objects in `device.list`, `device.show` and the snapshot gain `update: {state, held, method} \| null`, read from `firmware`'s view |

The key of each device stays with the module that owns it (HD 2): `firmware` decides, the owner seals.

**The shell**, `hub/src/shell/firmware/`:

| File | Does |
| --- | --- |
| `release.ts` | Reads and checks `.hsnf` files with `shell/update/release.ts`'s parser and the publisher keys |
| `own-build.ts` | Checks a raw application image |
| `stage.ts` | The staging job in pieces; makes and signs the header (`packages/protocol`'s `signImageHeader`) |
| `store.ts` | The `firmware/` folder: write through a temporary file, sync, rename; remove; check at start that every indexed file is there and hashes right |
| `serve.ts` | Answers `Get` frames on a granted link from the store, as the shell answers `fileChunk` (M2 6); sends `transferProgress` inputs every 64 KB ‡ |
| `session.ts` | Derives a Bluetooth session key from the device key (`KeyStore`) and sends it in the reply, as the shell sends history pages (M2 6) |

One new port, `Transfers`: `grant(link, image, header, file)`, `revoke(link)`; it emits `transferProgress {link, image, bytes}` and `inputRejected` for frames it refuses. **This is a small departure from HD 3**: the shell now reads the first two bytes of a frame. It reads only the transfer format, never a packet, and serves only what the core granted.

### Tables

All configuration or small state, written now unless marked, created by the next migration in the one sequence the joint step 0 freezes.

| Table | Columns | Key |
| --- | --- | --- |
| `firmware_images` | `id`, `image_id` blob(8), `sha256` blob(32), `version` (as `devices.firmware`), `kind` (0 official, 1 own build), `roles` (mask), `bytes`, `header` blob(128), `manifest` (official: the manifest JSON and signature; null for own builds), `file`, `added_ms`, `added_by`, `removed_ms` | `id`; unique `image_id` among those not removed |
| `rollouts` | `id`, `image` (`firmware_images.id`), `devices` blob (u32 LE each), `pilots` blob, `stage` (0 pilots, 1 soak, 2 rest, 3 paused, 4 done, 5 cancelled), `approved_by`, `approved_ms`, `soak_until_ms`, `paused_reason`, `paused_device`, `ended_ms` | `id`; at most one not ended |
| `device_updates` | `device_id`, `rollout_id`, `state` (below), `method` (0 its own link, 1 joins Wi-Fi, 2 Bluetooth), `held` (0 no, 1 armed, 2 battery, 3 waiting its turn, 4 needs a phone, 5 countdown, alarm or site move, 6 gateway always busy (below), 7 key change after a restore not finished (section 7)), `bytes` (routine), `attempts`, `last_reason`, `since_ms`, `ble_nonce` blob(8), `ble_expires_ms`, `reminded_ms` | `device_id` |

`device_updates.state`: 0 none, 1 planned, 2 offered, 3 fetching, 4 verified, 5 installing, 6 on trial, 7 confirmed, 8 rolled back, 9 refused, 10 cancelled.

No new audit table. Records are decisions (HD 6), each with its device. Every name starts `firmware_` or `rollout_`, because M2's hub updates already use `update_refused`, `update_rolled_back`, `update_switching` and `update_healthy` (M2 9), and `docs/m4-design.md` adds `update_offered` for hub releases:

| Decision | Level | `value` | When |
| --- | --- | --- | --- |
| `firmware_added`, `firmware_removed` | info | the image's row id | staged, removed |
| `rollout_started`, `rollout_resumed`, `rollout_done`, `rollout_cancelled` | info | the rollout | |
| `rollout_paused` | warning | the rollout; detail the device and reason | a rollback or a refusal other than a hold |
| `firmware_release_offered` | info | the version | the relay offered a firmware release (M4) |
| `firmware_held` | info | `held`'s code | a hold begins or changes |
| `firmware_device_offered` | info | the method | |
| `firmware_session_opened` | info | — ; detail the client | a session key handed to a phone |
| `firmware_verified`, `firmware_installing`, `firmware_on_trial`, `firmware_confirmed` | info | the version | |
| `firmware_refused` | warning | the device's reason | |
| `firmware_rolled_back` | warning | the failed version | |
| `firmware_reminder` | info | days armed | D91's reminder sent |

Hub events: `firmware_file_refused` (warning: `badFile`, `badSignature`, `wrongTarget`, `tooLarge`, `storeFull`), `firmware_store_damaged` (critical: an indexed file missing or wrong at start).

**Durability.** Accepted update query and status packets are committed now, as Started is (HD 5): each changes what the hub may tell the device next, and none may be replayed. Every transition of `device_updates` but `bytes` is now. A rollout writes about eight "now" commits per device, once per release: about 600 for home C (75 devices), on the day of a rollout only. The budget test's ordinary day does not change; it gains a rollout day with its own line (section 8). Transfer frames are not packets (they carry nothing encrypted) and are not rows: a row per piece would add about 1,600 rows and 1.6 MB per device update. Their totals are in the decisions and the device's statuses (section 12, R6).

### How a rollout proceeds

A release arrives (from a file in M3, through the relay from M4) and is announced: an `updates` notification to people with *manage system* (D54). Nothing is offered to any device until a person approves. The rollout's rules, the holds and the hub's go-ahead are proposed as **D139**.

1. **Approval** (`rollout.start`, *manage system*): the image, the devices (all of the image's roles by default), and optionally the pilots. Recorded `rollout_started`.
2. **Pilots**: one device of each role present ‡, chosen by the hub unless named: a disarmed sensor with Wi-Fi details and a good battery, a siren, and a gateway that is not the only one hearing any sensor where there is a choice. One pilot at a time: sensor, siren, gateway ‡.
3. **Soak**: one hour ‡ after the last pilot confirms. The rollout pauses if any pilot restarts by watchdog or fatal error, goes silent, or rolls back.
4. **The rest**: sirens and gateways one at a time between them (D91); sensors up to four at a time ‡, fetches up to four at a time ‡; no gateway installs while any sensor is on trial ‡, so the trials keep their path to the hub.
5. **Done** when every planned device is confirmed. Devices still held stay listed; the rollout stays open for them until a person ends it.

**Before any offer**, per device ‡:

| Condition | Otherwise |
| --- | --- |
| Paired and heard in the last two heartbeat intervals (sensors) or connected (sirens, gateways) | wait |
| The device's running image is confirmed (Started had no trial flag) | wait |
| Sensor disarmed (D91, UP9) | held: armed. A reminder in the `updates` category after 24 hours ‡ armed, then at most daily |
| Battery at or above 30% ‡, or on USB power (UP7); sirens and gateways on mains | held: battery |
| No countdown, alarm or site move (D115) running | held: countdown, alarm or site move |
| No key change after a restore still pending for the device (section 7) | held: key change |

**Before the go-ahead** ("install now"), the same again, plus: no provisioning or hub version switch under way; for a siren or gateway, no other siren or gateway installing or on trial. The go-ahead is committed before it is sent.

**While a countdown or alarm runs**, the hub revokes every grant and answers `Gone {paused}`; downloads resume when it ends, from their checkpoints.

**Arming during a download**: the download goes on, the door is still watched (section 6), and the install waits until the sensor is disarmed.

**Choosing the method**: a siren or gateway fetches on its own link (Wi-Fi, or USB for a gateway on the cable, D81). A sensor with Wi-Fi details (D47) is offered "join Wi-Fi" first; if it reports `noWifi` or `hubNotFound`, or has no details, it is held as "needs a phone" and the app lists it (UP6). The hub remembers the last result per sensor and does not try Wi-Fi again for it in the same rollout. Any device can be offered Bluetooth when a person asks from the phone.

**After a hub restart** the rollout continues from its stage; offers are made again; devices resume from their checkpoints.

### What the app shows

From `rollout.status` and the `deviceUpdate` event (below). Words are the app's; these are the states it must tell apart:

| State | Meaning for the person |
| --- | --- |
| held: armed | Waits until disarmed; still protecting |
| held: battery | Charge it first |
| needs a phone | Out of Wi-Fi range: update it from the phone, near it |
| waiting its turn | — |
| fetching, with percent | Downloading; still watching its door |
| verified | Downloaded; installs at its turn |
| installing | Restarting; not watching for a few seconds |
| on trial | Checking the new version |
| confirmed | Up to date, with the version |
| rolled back | The new version failed on this device; it went back to the old one and works |
| refused, with reason | Could not update, and why |

A rollout that paused shows why on the update screen and in history, and offers resume or cancel.

### How a failed update is reported

| Failure | The device reports | The hub |
| --- | --- | --- |
| Refused before writing (wrong hub, role, size, signature) | `Update status {refused, reason}` | `firmware_refused`, warning; pauses the rollout: the image or the store is wrong, not the device |
| Broken during the download (link lost, flash error, hash mismatch) | the same; resumes or restarts by itself up to 3 times ‡ | `firmware_refused` after the third; pauses |
| No Wi-Fi, hub not found | `refused {noWifi | hubNotFound}` | held: needs a phone; no pause |
| Trial failed | after the rollback, Started with `rolled back` and the failed version | `firmware_rolled_back`, warning, notified in `updates`; pauses the rollout |
| No contact after the go-ahead | — | after the trial deadline plus 2 minutes ‡ (12 or 7 minutes) without a Started: `firmware_refused {noContact}`; the device's own silence rules run as usual |

### App operations and events

Additions to the one app channel version 2 the three designs share (frozen by the joint step 0), with M2 6's permission letters (MS manage system, C console only):

| Operation | Change | Who | Body | Reply |
| --- | --- | --- | --- | --- |
| `firmware.list` | no | MS | — | images (id, version, kind, roles, bytes, added), and each device's version and update state |
| `firmware.offers` | no | MS | — | the firmware releases the relay offered (M4), with their size |
| `firmware.fetch` | yes | MS | `version` | `{job}`; staged as an upload is (above) |
| `firmware.upload` | yes | MS, C | `job` (an upload, M2 6), `own?: {version}`, `confirmOwn?: true` | the image staged, or why not |
| `firmware.remove` | yes | MS | `image` | — |
| `rollout.start` | yes | MS | `image`, `devices?: "all" \| [ids]`, `pilots?: [ids]` | the plan |
| `rollout.pause`, `rollout.resume`, `rollout.cancel` | yes | MS | `rollout`; for `resume`, `device?` and `force?: true` (a gateway held as always busy, section 5) | the rollout |
| `rollout.status` | no | MS | — | the rollout and every planned device's state, held reason, method, bytes, last reason |
| `firmware.bluetooth` | yes | MS (the phone build uses it; the console may, for the bench) | `device` | section 5, "What this gives the phone design" |
| `firmware.download` | no | MS | `image` | `{job}`, then the file as `fileChunk` events, as `backup.export` (M2 6) |

Event `deviceUpdate` (named apart from M2's `update.*` operations, which are the hub's own), to people with *manage system*: `{device, image, state, held, method, bytes, of, reason?}`, at each transition and at most once every 2 seconds ‡ of progress.

`hsn`: `hsn firmware add <file> [--own --version <v>]`, `hsn firmware list`, `hsn firmware remove <image>`, `hsn rollout start <image> [--pilot <device>]…`, `hsn rollout status|pause|resume|cancel`. All but `firmware add` are `hsn op` forms.

## 5. Transport

### The device messages

New message types (§5) and bodies (§6). All are sealed packets with the usual receiving rules of their receiver (§4).

| Type | Name | From | To | Paths | Reply |
| --- | --- | --- | --- | --- | --- |
| 0x06 | Update query | any device | hub | any | sensors: always answered (an Update offer or a Reply), reply wanted |
| 0x07 | Update status | any device | hub | any | sensors: always answered, reply wanted |
| 0x83 | Update offer | hub | any device | any | — |
| 0x84 | Key change | hub | any device | any | the device's next packet, under the new key (section 7) |

**Update query (0x06)**, sent when a reply carries "update available", and on every (re)connection while the device holds part of an image:

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 8 | Image id held, zeros for none |
| 8 | 1 | Held: 0 nothing, 1 part, 2 verified |
| 9 | 4 | Bytes held, up to the last checkpoint |
| 13 | 1 | Battery, encoded as in §6 |
| 14 | 1 | Flags: bit 0 has Wi-Fi details, bit 1 on USB power or mains |

**Update offer (0x83)**: bound to the packet it answers, for a sensor; as settings are, for a siren (strictly higher counter); in the session, for a gateway.

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | Action: 0 nothing (discard anything held), 1 fetch on the link this offer came by, 2 join Wi-Fi and fetch, 3 open Bluetooth, 4 install the verified image now, 5 keep what you hold and wait |
| 1 | 8 | Image id |
| 9 | 4 | File bytes (header and image) |
| 13 | 3 | Version |
| 16 | 8 | Bluetooth session nonce (action 3), else zeros |
| 24 | 1 | Bluetooth window, in units of 10 seconds (action 3) |

**Update status (0x07)**:

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 8 | Image id |
| 8 | 1 | Stage: 1 fetching, 2 verified, 3 refused, 4 installing (sent just before the restart), 5 confirmed, 6 cancelled |
| 9 | 1 | Reason: 0 none, 1 battery, 2 armed, 3 noWifi, 4 hubNotFound, 5 linkLost, 6 badHeader, 7 wrongHub, 8 wrongRole, 9 tooLarge, 10 badSignature, 11 hashMismatch, 12 flash, 13 imageCheck, 14 windowEnded (Bluetooth), 15 sessionRefused, 16 onTrial, 17 radioBusy (a gateway, above) |
| 10 | 4 | Bytes written |

Over LoRa a device sends only stages 2 to 6, never progress. The largest of the three is the offer: 43 bytes on air, about 87 ms at SF7 and 2.1 s at SF12 (§2's formula, HN 3); the query is 33 bytes and the status 32. A sensor sends two to four of them per update.

**Started (0x05) gains two fields** at its end (§11): offset 8, image flags (bit 0 on trial, bit 1 rolled back since the last confirmed image); offset 9, the failed version (3 bytes, zeros for none). An older hub ignores them.

### Transfer frames

Not packets: they carry nothing secret and are checked by the signature. Each starts with 0xF2, which no packet starts with (packets start 0x10 or 0x18, setup messages 0xF1, §10). One frame per WebSocket message, per COBS frame on USB, per Bluetooth write or notification. Little-endian.

| Kind | Name | From | Body after 0xF2 and the kind byte |
| --- | --- | --- | --- |
| 0x01 | Get | device | image id (8), offset u32, length u16 |
| 0x02 | Data | source | image id (8), offset u32, CRC-32 of the data u32, data |
| 0x03 | Gone | source | image id (8), reason u8: 0 not available, 1 not granted, 2 paused, 3 out of range |
| 0x10 | Hello | device, Bluetooth only | device address u32, device random (8), image id (8), bytes held u32, largest data u16 |
| 0x11 | Open | phone | tag (16) |
| 0x12 | Done | device, Bluetooth only | image id (8), result u8 (0 verified, 1 refused), reason u8 (as Update status) |

- **Sizes.** A Data frame's header is 18 bytes. On Wi-Fi and USB, data is at most 1,000 bytes, so a frame stays inside the 1,024-byte buffers the links already have (§3, FD 1). On Bluetooth, at most the ATT payload less 18: 164 bytes at an MTU of 185, 496 at 517 ‡.
- **Pull.** The device asks; the source answers each Get with one Data or one Gone. A source sends nothing unasked. Up to 4 Gets ‡ outstanding on Wi-Fi and USB, 8 ‡ on Bluetooth; a Get unanswered after 2 s (3 s on Bluetooth) ‡ is asked again; a Data that matches no outstanding Get, or fails its CRC, is dropped.
- **Order.** The header (offset 0, 128 bytes) first, then the image in order, never more than the current sector and the next ahead, so two 4 KB buffers hold everything in flight.
- **CRC-32**: the reflected polynomial 0xEDB88320, initial value and final XOR 0xFFFFFFFF, as the retained block's ‡.
- **Resume** is asking from the last checkpoint. Within a session nothing else is needed; after a link drop the device sends an Update query on the new link (the hub grants per link); after a reset, the update record gives the checkpoint.
- **Ruled** (R2, R3, R5): frames in the clear; the hub's shell reads the 0xF2 prefix on granted links; the sizes, windows and timeouts above are provisional values, each to be measured (Wi-Fi and USB on the boards, Bluetooth in S9). The format is proposed as **D137**.

### Over Wi-Fi and USB: sirens, gateways, and sensors in range (UP5, GW7, SR8)

```
Hub                                          Device
 │── Update offer {1 or 2, image, bytes} ──→│ siren, gateway: on its link
 │                                          │ sensor: in a reply to its query, then joins Wi-Fi,
 │                                          │   finds the hub by mDNS (§10), opens the WebSocket
 │←── Update query (on this link) ──────────│ sensor only: identifies the link
 │── Update offer {1} ─────────────────────→│ grant on this link
 │←── Get {0, 128} ─────────────────────────│
 │── Data {header} ────────────────────────→│ checks 1–5 before any flash write
 │←── Get × 4 … ────────────────────────────│ erase a sector, write, checkpoint every 64 KB
 │── Data × 4 … ───────────────────────────→│
 │←── Update status {fetching} every 256 KB ‡ (links only)
 │←── Update status {verified} ─────────────│ read back, SHA-256 equal
 │── Update offer {4 install now} ─────────→│ at its turn (section 4)
 │←── Update status {installing} ───────────│ links drain (FD 3, Waiter); restart
 │←── Started {new version, on trial} ──────│ sensor: on LoRa, as always
 │── reply / welcome / report now ─────────→│ healthy: confirm
 │←── Update status {confirmed} ────────────│
```

- **A sensor in Wi-Fi range** (UP5) joins only for the update: 30 s ‡ to join and find the hub, else `noWifi` or `hubNotFound` over LoRa. Its LoRa side runs throughout, so its heartbeats and door reports go on. It leaves Wi-Fi after the status `installing`, or on any refusal.
- **A break**: the link reports `down` (FD 3); the device reconnects on its usual back-off (1, 2, 4, 8, 15, 30 s) for up to 2 minutes ‡, then sends an Update query on the new link and continues from its checkpoint. After 2 minutes without a link it reports `linkLost` (over LoRa for a sensor) and keeps the part; the next offer resumes it.
- **USB.** A gateway on the cable fetches over USB with the same frames. On the Olimex board the USB link is the CH340X bridge's UART: at 921,600 baud ‡ about 90 KB/s, 17 s for 1.5 MB; at 115,200 baud about 2½ minutes *(estimate)*. The board's own native USB will be faster ‡.
- **What a gateway does with radio traffic while it updates.** It goes on listening and forwarding; forwarded packets and transmit results go before Gets on its link. Flash writes happen only while no transmit request waits for its moment and the radio is not receiving ‡, so a reply at a given time is not made late by a sector erase (up to 400 ms ‡). It is deaf only during its restart and reconnection: about 1 s to boot ‡, then USB at once or Wi-Fi in 2 to 5 s ‡, then hello and welcome. A door report in that gap is retried by the sensor at 2, 5 and 10 s (§7), so it arrives a few seconds late at worst, or at once through a second gateway. Under 60 s, the hub raises no gateway-offline alert (D97); past it, the alert is a real one. Ruled (R11).
- **A site so busy that a transmission is always waiting.** The gateway asks for no more pieces than it can write, so a closed write gate only slows the download. If it writes no sector for 10 minutes ‡ while fetching, it stops, keeps its part and checkpoint, and reports `Update status {refused, radioBusy}` (reason 17). The hub records `firmware_held` with `held` 6, "gateway always busy", and offers again after an hour ‡. After the third such hold in one rollout ‡ it stops offering by itself and the app says: "This gateway is too busy to update without delaying replies. Update it at a quiet time, or with fewer sensors on it." A person may then choose "update now anyway" (`rollout.resume` with `device` and `force: true`, *manage system*): the gateway writes even with a transmission waiting, each reply it makes late is answered "too late" and covered by the sensor's retry (§7), and the hub records each as usual. The install itself, a few seconds, is never forced past a countdown or alarm. A home with a second gateway loses nothing.
- **A siren** keeps both paths and its commands while it downloads. It installs only when off and when no countdown or alarm runs; during its restart (about 1 s ‡, plus 2 to 5 s ‡ to rejoin Wi-Fi) the hub would reach it on LoRa first.
- **The hub's side**: `serve.ts` answers each Get from the store file within the loop's limit (a read of 1 KB). Four transfers at once are a few hundred inputs a second at most; no commit.

### Over Bluetooth from the phone (UP6, AP3)

Bluetooth is off outside pairing and update sessions (PR3). **Decided** (the coordinator's ruling, proposed as **D138**): for an update it opens only on the hub's offer, over LoRa (or the device's link), never on a button hold; and the update has its own GATT service, separate from pairing's, which uses protocomm's own layout (`docs/m3-design.md` section 5). Rejected: the 5 s hold `docs/m3-design.md` first assumed, which would let anyone near a sensor keep its radio and processor awake; one service for both, which would mix protocomm's endpoints with this design's frames; and a ticket signed with the hub's key, which a sensor without a clock could not expire and which would still need the hub's word over LoRa to turn Bluetooth on.

1. A person with *manage system* chooses "update with my phone" for a device. The phone asks `firmware.bluetooth {device}`. The hub checks the conditions of section 4, draws an 8-byte nonce from the input's entropy, commits the session (`ble_nonce`, expiry 15 minutes ‡), and the shell replies with the session key (below) and what the phone needs; the reply is the only place the key travels, inside the app's channel (M2 5). The phone downloads the image (`firmware.download`) if it does not hold it. **Asking again** for a device whose session is still live does not make a second session and is not refused: the hub answers with the same session (the same nonce, so the same key) and the time that is left of it, and writes no second decision. So a phone whose reply was lost on the way, or a person who chooses "Start again" after a failed attempt, is never turned away by their own session. The request is a change like any other (M2 5): its `commands` row is written in the step that grants it, nothing is left pending, and the reply kept for its `seq` holds no key; a retry with that `seq` is answered by the same rule while the session lives, and with `unavailable` once it has ended. After a restart the hub treats a session whose life ended while it was off exactly as the expiry does when it runs live: an offered or fetching Bluetooth update goes back to planned.
2. The sensor learns of it at its next reply ("update available"): at its next heartbeat (within 3 minutes by default), or at once if the person opens its cover, which sends a cover report that is always answered (§6). It sends an Update query and gets an offer with action 3, the nonce and the window.
3. It advertises for the window, 120 s ‡, as `hsn-<address as 8 hex digits>` in the scan response, with the update service's UUID in the advertisement. Its LoRa side runs on.
4. The phone connects, asks for the largest MTU (517), and subscribes to notifications. The sensor notifies **Hello**. The phone answers **Open** with the tag. A wrong tag closes the connection; five wrong in one window ‡ end it (`sessionRefused` over LoRa).
5. The sensor pulls the file with Gets (notifications); the phone answers with Data (writes without response). On a drop, the phone reconnects within the window or the session's life; Hello's "bytes held" tells it nothing it needs, since the device asks.
6. At the end the sensor notifies **Done** and sends `Update status {verified}` over LoRa; the hub answers with "install now" when section 4's conditions hold, else "wait". Bluetooth stops when Done is sent, at the window's end with nobody connected, after 30 s ‡ without progress, or at the session's life.

**The session key.** `K = HKDF-SHA256(key = the device's 16-byte key, salt = the nonce, info = "hsn-ble-update/1", a zero byte, the device address u32)`, 32 bytes. **The tag**: the first 16 bytes of `HMAC-SHA256(K, "hsn-ble-open/1", a zero byte, address u32, the device random, the image id)`. The device key never leaves the hub's shell or the device; the phone learns only K, which dies with the session. One nonce serves one session; a new offer replaces it. This is what keeps the Bluetooth radio defended (D124): without K nobody can open a session, keep a sensor awake beyond its window, or start a window at all. The image's integrity does not depend on it; the signature does that.

### Time and battery, worked out

All *(estimate)*. Image 1.5 MB ‡; flash at about 45 ms to erase a 4 KB sector and 0.5 ms to program 256 bytes ‡, so about 20 s to write 1.5 MB, which bounds every transfer at about 75 KB/s; the device's average current while transferring 70 mA ‡ (CPU, radio, flash), while advertising with the chip awake 35 mA ‡ (Bluetooth cannot share light sleep with the RC slow clock, HN 6); Wi-Fi 120 mA ‡. Usable cell 2,700 mAh and about 2 mAh a day of ordinary running (sensor-board.md's basis).

| Case | Link rate ‡ | Transfer | Whole session (connect, check, transfer, restart, trial) | Charge | Share of the cell | Days of ordinary running |
| --- | --- | --- | --- | --- | --- | --- |
| Bluetooth, good: Android, MTU 517, 2M PHY, short connection interval | 50–80 KB/s, flash-bound at 75 | 25 s | about 45 s | 0.8 mAh | 0.03% | 0.4 |
| Bluetooth, typical: iPhone, MTU 185, 15–30 ms interval | 15–30 KB/s | 50–100 s | about 2 minutes | 2.1 mAh | 0.08% | 1 |
| Bluetooth, poor: busy air, slow JavaScript bridge | 5–8 KB/s | 190–300 s | about 5½ minutes | 6.4 mAh | 0.24% | 3 |
| Bluetooth window ends with no phone | — | — | 120 s advertising | 1.2 mAh | 0.04% | 0.6 |
| Wi-Fi, in range | flash-bound | 20–25 s | about 30 s (join 2–5 s ‡) | 1.0 mAh | 0.04% | 0.5 |
| Wi-Fi attempt that fails | — | — | 30 s | 1.0 mAh | 0.04% | 0.5 |

Fixed costs in each session: the signature check, up to 1 s ‡ (HN(b): unmeasured); the read-back hash, under 0.5 s ‡ with the S3's SHA hardware; the restart, about 1 s ‡; the trial, 1 to 3 s.

### What spike S9 must measure

For the transfer half of S9 (the pairing half is `docs/m3-design.md`'s), with a throwaway ESP-IDF app on an Olimex board and the Expo development build, on a real Android phone and a real iPhone:

1. The MTU each phone settles on, the connection interval and PHY, and whether each can be requested from `react-native-ble-plx`.
2. Throughput of the pull protocol with 4, 8 and 16 Gets outstanding, for 1.5 MB, with flash writes running on the board, at 1 m and 10 m through a wall.
3. Whether flash erases and writes drop or stall the Bluetooth connection ‡, and how long a Get waits at worst.
4. Current with the power profiler: advertising, connected and idle, transferring, erasing; the energy of a whole session.
5. Time to scan, connect and open a session from the app; reconnection and resume after a forced drop.
6. What each phone does when the screen locks or the app goes to the background mid-transfer.
7. NimBLE's flash and RAM cost in the image (D103), and whether Bluetooth can light-sleep on the RC slow clock (HN 6).
8. P-256 verification time on the S3 through PSA (HN(a)6).

If the typical case is below 10 KB/s, compression (section 12, P7) is reconsidered.

### What this gives the phone design

The exact interface for `docs/m3-design.md`. The screens and their words are that design's.

**From the hub**, over the app's channel (M2 5, 6):

- `firmware.bluetooth {device}` → `{device, address: u32, imageId: hex(8), version: "x.y.z", fileBytes, sha256: hex(32), sessionKey: base64url(32), windowS, expiresInMs, needsWake: boolean}`; `needsWake` true when the sensor learns of it only at its next reply, so the app says "open its cover, or wait up to <interval>". Refusals: `held {armed | battery | countdown | alarm | siteMove | keyChange}`, `notPaired`, `onTrial`, `noImage`. A live session for the device is not a refusal: the reply is that session again (step 1 above). The key is never stored on the phone beyond `expiresInMs`, never logged, never shown.
- `firmware.download {image}` → `{job}`, then `fileChunk` events and a `fileFailed` on failure (M2 6). The file is the 128-byte header and the image, exactly the bytes the device pulls. The phone may check the header's hash against `sha256` and keep the file by image id until the session ends.
- `deviceUpdate` events and `rollout.status` for every state the screens show (section 4), and `update: {state, held, method}` on every device object, so a device's page knows whether it needs a phone and why it is held; the device's own progress over Bluetooth is the phone's to show, from the offsets it serves. The new version arrives as the `device` event the registry already sends when a Started names it.

**Over Bluetooth**, the device side as above:

| Item | Value |
| --- | --- |
| Service UUID (in the advertisement) | `1012a7e5-5d53-44e0-9170-6c34720148a4` ‡ |
| Characteristic `rx`: phone writes, without response | `9e848f59-78c5-4f7e-b604-38d088ceda4f` ‡ |
| Characteristic `tx`: device notifies | `0a218c6e-e0b9-4cfe-9580-e13887bcd840` ‡ |
| Device name, in the scan response | `hsn-` and the address as 8 lower-case hex digits, most significant first; the phone finds the sensor by the `address` in `firmware.bluetooth`'s reply, not by chip id (pairing's `hsn-<4 hex>` name belongs to the other service) |
| MTU | the phone asks for 517; the device uses what is agreed |
| Frames | 0xF2 frames as above, one per write or notification, never split |
| Order | subscribe to `tx` → Hello → Open → (Get → Data)… → Done |
| Phone's duty | answer each Get with exactly the bytes asked, from the file, with their CRC-32; answer a Get outside the file with Gone `outOfRange`; reconnect after a drop until the session's expiry |

The update service is separate from pairing's (D138). A board advertises one or the other, never both: the pairing window's protocomm service, or this one during an update window.

### Over LoRa: out

Out, for the reasons D10 gives, with the numbers. A 255-byte packet holds about 223 bytes of image after the packet's 18 and a frame's 14 bytes; 1.5 MB is about 7,050 packets. At SF7 each takes 400 ms on air, 2,820 s in all: at 869.525 MHz's 10% (D104), **about 8 hours of the gateway's whole legal airtime**, leaving none for replies and siren commands, which D104, D108 and D111 rely on. At SF12 each takes 9 s: **about 7 days**. The sensor would listen throughout and send its Gets within 1% on the site channel. Even a delta of a tenth of the image would take most of an hour of all the airtime at the best rate.

## 6. Safety during an update

### How long a device does not do its job

| Device | During the download | During the restart | During the trial | If the trial fails |
| --- | --- | --- | --- | --- |
| Sensor | Watches its door and reports it over LoRa, as always. An input change waits at most one sector erase, up to 400 ms ‡, while flash is busy | Blind: about 1 s ‡ (bootloader image check and start) | Watches; never sleeps deeply | One more restart, about 1 s ‡ |
| Siren | Sounds and answers on both paths | Off and unreachable about 1 s ‡, then LoRa; Wi-Fi in 2 to 5 s ‡ | Sounds | One more restart |
| Gateway | Forwards | Deaf about 1 s ‡, then up to 5 s ‡ to reconnect | Forwards | One more restart |

A sensor updates only while disarmed (D91), and a door opening while disarmed is logged only (D46), so its second of blindness never costs an alarm; and the hub gives the go-ahead only with no countdown, alarm or site move running. D91 says "a sensor cannot report its door for about a minute while it installs"; with this design it is about a second (section 13). Proposed as **D135**, amending D91.

**What the hub and app show**: "installing" from the status sent before the restart until Started; "on trial" until confirmed. The hub's silence and offline rules run unchanged, since every gap above is far shorter than them.

### Every stage, and a power cut or reset there

The running image is always the confirmed one when the other slot is written (section 2), so the right-hand column always has a working image to boot.

| Stage | State on flash | A power cut or reset here leads to | Why it still boots something that works |
| --- | --- | --- | --- |
| Offer received, header checked | nothing written | the old image boots; the offer comes again | `otadata` untouched |
| Erasing or writing the other slot | that slot partly written; `update` record at the last checkpoint | the old image boots; the next query reports the part and resumes from the checkpoint, writing that sector again | `otadata` still selects the running slot; the bootloader never looks at the other |
| Writing the checkpoint record | NVS writes whole or nothing (HN 7) | the old checkpoint stands | as above |
| Reading back and hashing | as above | as above; the hash is computed again | as above |
| Verified, waiting for the go-ahead | the other slot complete; record says verified | the old image boots; the query reports "verified"; the hash is checked again before `select` | as above |
| `select()`: writing `otadata` | one of the two copies being written | the bootloader takes the newer valid copy: either the old image, or the new one in `NEW` | either image works; a new image in `NEW` goes on trial |
| Restarting into the new image | new image `NEW`, then `PENDING_VERIFY` at its first boot | a reset before it confirms rolls back: the old image boots and reports `rolled back` | the bootloader marks it `ABORTED` and boots the old slot (HN 7, P) |
| On trial | `PENDING_VERIFY` | rollback, as above; also a watchdog reset, a panic, a brown-out, a deep-sleep wake | as above |
| The new image fails the bootloader's image check | — | the bootloader boots the other valid slot ‡ | the old slot is valid |
| `confirm()`: writing `otadata` | one copy being written | the newer valid copy: `VALID` (confirmed) or still `PENDING_VERIFY` (then rolled back) | either image works |
| Confirmed, sending `confirmed` | `VALID` | the new image boots; its Started (no trial flag) tells the hub | it is confirmed |
| The hub loses power at any stage | the hub's state is committed now at each transition | the hub resumes the rollout; devices resume from checkpoints; a trial without the hub for its deadline rolls back | devices never depend on the hub to boot |

## 7. Changing device keys after a restore (D53, D122, O16)

M2 9 ("What a restore cannot undo, for devices") found the gap and owed its fix to M3; no design was asked to write it until now. A restored hub's replay windows are the backup's, so every device packet sent between the backup and the restore, if someone recorded it off the air or the home network, can be accepted once (§4, "Known limits"). For routine packets that is harmless (HD 5's table). For door, cover, button and Started reports it is not: a replayed door report carries its age, so the hub would date an opening to the replay and, if armed, sound the sirens.

M2 9 already fixes the mechanism, and this section follows it: **a key change, not a counter change**; a hub-to-device message carrying a new 16-byte key, sealed under the old key with the usual binding, and acknowledged by the device's next packet under the new key; the device's counters restart under the new key from one step, as at pairing; the device stores the new key and its resume point before it acknowledges; and after a restore the hub never acts on a packet under an old key, but answers it with the key change, and the device reports again. Moving counter bases was rejected there and stays rejected. Proposed as **D141**.

### The choices M2 9 leaves, made

| Choice | Made | Rejected |
| --- | --- | --- |
| The message's form | A new type, **0x84 Key change**, hub to any device, any path; its body is the new key, 16 bytes. "Report again" is always meant, so it carries no flag | Fields appended to the Reply: a reply's body is fixed (§3, §11), so every reply would grow by 17 bytes; a flag: nothing but "report again" is ever wanted |
| Which devices | Every paired device: sensors, sirens and gateways | Sensors only: a recorded siren report or gateway hello replays too |
| When the hub makes a device's new key | At the first packet under the old key from that device after the restore, from that input's entropy | All at the restore: a step may take at most 28 bytes of entropy (HD 2), and a key made for a device never heard again would sit unused |
| The binding | The answer's usual one: to a sensor, the counter of the packet it answers (§4); to a siren, none, under the strictly-higher rule, as settings; to a gateway, its hello's random, **in place of the welcome** | M2 9's "on a gateway's session": opening a session under the old key would be acting on an old-key packet |
| Sirens | Sent a Key change at the restored hub's first start, on both paths, in place of §7's "report now" | Waiting for each siren's next report: up to 30 s in which the hub may act on nothing the siren says |
| What the device keeps | The new key only, from the moment it is written; the hub keeps both until it hears the new one, and sends the same new key again if the first is lost | The device keeping both: two keys to try on every packet, for nothing |
| How long | Until each device is heard under its new key, however long that takes | A deadline after which devices must be paired again: a sensor in a drawer would be lost for no reason |

### The hub

- **The restore marks every device.** `applyRestore`'s one transaction (M2 9), which already moves the counters by 2²⁴ and raises clients' sequence numbers, also sets `rekey = 1` on every `device_keys` row. `device_keys` gains, in the next migration, `next_key` blob(16) (null when none) and `rekey` (0 none, 1 required). Both stay in that table, apart from every query, as the key does (HD 6).
- **Opening.** `KeyStore` holds both keys; `DeviceCipher.open` tries `next_key` first, when there is one, then `key`, and `OpenedPacket` says which (`keyUsed: "current" | "next"`): a change to the `DeviceCipher` port (HD 3), at most two AES-CCM passes per packet.
- **A packet under the old key while `rekey = 1` is never acted on.** `intake` checks its tag, records it (its `rx` row flagged `oldKey`; its replay window untouched) and emits `oldKeyPacket`, not `accepted`, so no module can act on it by mistake. The module that owns the device's key (`sensors`, `sirens` or `gateways`, HD 2) answers with a Key change. When `next_key` is null it takes 16 bytes of entropy and writes `next_key` now, and the send gate holds the Key change until that commit (HD 4); otherwise it sends the same key again. At most one Key change per device every 10 s ‡, so a flood of replays costs at most that airtime. Decision `key_change_sent` (info).
- **The key bytes and the core.** As with Provision (HD 2: "the only keys the core is ever given"), the core holds a new key only in the step that makes it; pending keys reach it in the boot snapshot (`rekeyKeys`, beside `provisioningKeys`) and leave it only inside Key change.
- **The first packet under the new key** is accepted as usual and, in the same "now" commit, switches the device: `key = next_key`, `next_key` null, `rekey = 0`, the hub's resume point for the device back to 1,024 (counters start at 1 under a new key, §4), its replay window cleared. Decision `key_changed` (info). The packet is then acted on as any other: a door report starts its countdown from the opening it states (D106).
- **After the switch**, a packet under the old key fails its tag, as from a stranger, and is counted in `rejects` (HD 6).
- **Backups.** A key change is a change to paired devices, so it starts a backup at once (D122, coalesced within 60 s). Backups hold `next_key` and `rekey`, so a restore in the middle of the changes loses nothing.
- **What the app shows**: a device not yet heard under its new key is "Not heard since the restore" until it is; firmware offers and Bluetooth sessions wait for it (`held` 7, section 4). The silence rules run as usual.

### Each device

On a Key change it can open (a sensor: bound to one of its own packets; a siren: counter strictly higher; a gateway: bound to its hello's random), in this order:

1. Write the pairing record with the new key (FD 5; whole or nothing).
2. Write the resume point as one step: 64 on a sensor, 1,024 on a siren or gateway (§4).
3. Import the new key into its `PacketCipher`.
4. Send again, under the new key, what it was saying: a sensor its current report, a door report with its age still counting from the opening (DS3, D106), or after a heartbeat a heartbeat asking for a reply; a siren a report (reason 1); a gateway a new hello.

Key first, then resume point: a power cut between 1 and 2 leaves the new key with the old, higher resume point, so counters are skipped, never repeated under any key. A cut before 1 leaves the old key, and its next packet draws the same Key change again. The device never sends under the old key after step 1. In the core: `SecureChannel::change_key(key, now)`; each role adds its step 4.

### What it costs

| | Cost *(estimate)* |
| --- | --- |
| A battery sensor | One Key change heard in a listen window it opens anyway (34 bytes: 77 ms at SF7, 1.8 s at SF12, §2's formula); two flash writes (the 192-byte pairing record and the resume point); one more packet and its reply. About 0.006 mAh at sensor-board.md's 0.003 mAh a report, once per restore |
| The report it repeats | One exchange later: about 2 s at SF7 and 5 s at SF12. A door report's countdown still counts from the opening (D106), so the alarm comes no later |
| The hub | Two "now" commits per device, once per restore: about 150 for home C |
| Airtime | One 34-byte packet per device on 869.525 MHz |

### A device out of range at the time

It keeps its old key and goes on using it. Nothing on the hub expires: when its first packet arrives, a day or a month later, it is answered with the Key change and continues as above. Meanwhile the hub acts on nothing it sends, and the silence rules say it is missing, as they would anyway. A device reset and paired again meanwhile gets a new key from pairing (PR4).

One case cannot be covered: a restore from a backup made before a device's last key change. That device holds a key the restored hub never knew and must be paired again. D122's immediate backups make this need an old file chosen on purpose. Recommended addition to the restore console's words (M2 9): "devices whose keys changed after this backup must be paired again".

So no packet recorded before a restore is ever acted on: before its device's switch it draws only a Key change, and after it it fails its tag. O16's accepted replay no longer exists.

### How it is proven

- **Host simulator.** `TestHub` gains `restore(snapshot)`, which returns its device state (keys, windows, counters) to an earlier copy and marks every device, and this section's rules; the `Medium` gains `replay(transmission)`, which sends a recorded transmission again from the timeline. Tests: an armed door report recorded after a backup and replayed after the restore starts no countdown and draws a Key change, and the real sensor, at its next heartbeat, changes key, after which a real opening gets its countdown from the opening; a power cut before the first flash write and between the two; a sensor out of range for 30 simulated days, then back; a siren changed at the hub's start, its replayed report not acted on; a gateway's replayed hello answered with a Key change and the real gateway reconnecting under the new key; a flood of replays drawing one Key change every 10 s.
- **The real hub in lockstep.** A real restore needs a phone holding the backup key (M2 9), which the bench has none of, so the lockstep hub accepts one more test-only control command, only with `--bench-lockstep` as its seeded keys are (HD 11): `restore {file, key}`, which runs `applyRestore` with the key the controller gives and restarts the hub. The wire stays at version 2 (the command travels in `control`). `RemoteHub` gains `backup_now()` and `restore()`. A new system test, `restore_rekey_test.cpp`, runs the door, out-of-range, siren and gateway cases above against the real hub.
- **The hub's own tests.** Scenario tests (HD 11's `World`), and crash tests at each commit: the new key written and the Key change not sent; the switch committed and the reply not sent. Vectors for 0x84 in `packages/protocol`.

### Its part of the joint step 0, and its owner

- **Protocol**: type 0x84 and its body; §4's "Known limits" paragraph on restores replaced; §7 "Hub restart" for a restored hub; vectors.
- **Firmware interfaces**: `SecureChannel::change_key`, and the role contract's "report again" hook.
- **Hub model**: `oldKeyPacket`, `keyUsed`, `rekeyKeys` in the boot snapshot, `device_keys`' two columns in the next migration, the decisions `key_change_sent` and `key_changed`, the lockstep `restore` command.
- **Owners**: K1 (hub) for the key change in `intake`, `sensors`, `sirens`, `gateways`, `shell/cipher/`, the `KeyStore` and `applyRestore`'s transaction; K2 (firmware) for `SecureChannel` and its tests; the three role owners for step 4; U10 for `restore_rekey_test.cpp` and `RemoteHub`.

## 8. Test strategy

### On the host simulator

New pieces in `hsn_host`: `FakeFirmwareSlots` (two slots of a test size, 64 KB ‡, every erase and write recorded, sectors that read as garbage after a cut); a fake bootloader with `otadata`'s two copies and states, run by `SimDevice` at every boot; boards whose running role is chosen by the image they boot (a test maps a version to a role factory: a good one, one that never confirms, one that hangs and trips the watchdog, one that cannot open packets); `FakeBluetoothLink`; and `ScriptPhone`, which plays the phone's part from a session key and a file.

| Test | Proves |
| --- | --- |
| Device and `UpdateService` unit tests | every check of section 3 in its order, with nothing written before check 5; frames, windows, CRC, re-asking; checkpoints; deep sleep refused on trial; the stuck-awake bound; Started's fields |
| A power cut at every flash operation | for each erase, write and record write of a whole update in turn, and for each `otadata` write: cut there, boot, and the board runs a working image, then finishes the update from its checkpoint. About a hundred runs of a short scenario |
| A bad image, a wrong signature, a wrong hub, a wrong role, too large | refused before any write; the slot untouched |
| A rollback | an image that never confirms rolls back at the deadline; one that hangs rolls back by the watchdog; a power cut on trial rolls back; each reports `rolled back` and the failed version |
| Doors during an update | a door opening during a download is reported as usual; the input delay stays within one erase |
| Bluetooth | a wrong tag, five wrong tags, an expired window, a drop and resume; no session without an offer |
| Records | a new image that adds fields to a record, rolled back: the old image reads it |
| `psa` | SHA-256, P-256 verification, HKDF and HMAC against the vectors |

### Through the real hub in lockstep

As the system tests run today (`bun run check:firmware:lockstep`), with `RemoteHub` given an own build (`hsn firmware add --own`, a 64 KB test image), in `firmware/tests/system_roles/`:

- `update_rollout_test.cpp`: four sensors (two with Wi-Fi details), a siren, a gateway on USB and one on Wi-Fi. The pilots, an hour's soak in seconds of host time, the rest; sirens and gateways one at a time; at most four sensors at once; every device confirmed.
- `update_held_test.cpp`: a sensor armed throughout is held, reminded after 24 hours, and updates once disarmed; a countdown during a download pauses every transfer and resumes after; a low battery holds.
- `update_rollback_test.cpp`: an image that fails its trial on sensors rolls back, the rollout pauses, the hub records why.
- `update_bluetooth_test.cpp`: a sensor without Wi-Fi updated by `ScriptPhone` with a key from `firmware.bluetooth`.
- `update_gateway_load_test.cpp`: thirty sensors through a gateway that updates; nothing lost inside the gateway; reply results within the tolerance of the load test without an update. A second case keeps a transmission always waiting: the gateway reports `radioBusy` after its bound, is held, and updates when forced, its late replies covered by the sensors' retries.
- `restore_rekey_test.cpp`: the key change after a restore (section 7).

### Hub tests

Unit and scenario tests of `firmware` (every condition of section 4, at its boundary); the store (refusals in order, a damaged store at start, the four-image limit); staging within the loop's limit (M2 10); the serving of granted and refused frames; a crash at every transition of a rollout (HD 11's crash tests); the write budget's rollout day for home C; vectors in `packages/protocol` for the three messages, Started's fields, the transfer frames, CRC-32, the image header and its signature (RFC 6979's key from `pairing-data.json`), and the session key and tag.

### What needs a real board

The ESP-IDF `FirmwareSlots` on real flash and the real bootloader's rollback, including a deep-sleep wake on trial and fast boot (HN(b)); power cuts at random moments by the MOSFET module on the order list switching the board's supply, a few hundred times; a brown-out during a write on a cell; erase times against the 400 ms bound; the image size (D103) and the bootloader's size; the signature check's time; Wi-Fi throughput; the USB gateway's rate; flash work beside the radio's interrupts and listen windows; current with the profiler.

### What needs a real phone

Spike S9; the app's Bluetooth path on Android and iOS; locking and backgrounding; resume after a drop; the session key's handling on the phone.

## 9. New dependencies

Nothing is installed by this design, and nothing is added until the reviewer approves it.

| Name | Version | Side | What for | Alternative without it |
| --- | --- | --- | --- | --- |
| ESP-IDF `app_update` (`esp_ota_ops`) and the bootloader's rollback | ESP-IDF v6.1 (stack.md), not installed here | firmware platform | `otadata`, selecting, confirming, rejecting, the running image's state | our own `otadata` and bootloader: far more work, no benefit |
| ESP-IDF `esp_partition`, `spi_flash` | v6.1 | firmware platform | erasing, writing and reading the other slot | — |
| NimBLE (ESP-IDF's `bt` component) | bundled with v6.1 ‡ | firmware platform | the Bluetooth link (stack.md already chose it) | Bluedroid, larger |
| ESP-IDF Wi-Fi, `esp_netif`, lwIP | v6.1 | firmware platform | sensors' Wi-Fi for updates; already in the image for sirens and gateways | — |
| `espressif/esp_websocket_client` | 1.8.0 (HN 8) | firmware platform | planned for M1b already; M3 adds only the sensor's use | — |
| `espressif/mdns` | 1.15.1 (HN 8) | firmware platform | planned for M1b already | — |
| TF-PSA-Crypto | 1.1.0, pinned (`firmware/cmake/dependencies.cmake`); in v6.1 as Mbed TLS 4.1 | `hsn_psa` | SHA-256, P-256 verification, HKDF, HMAC: already a dependency, more of it used | — |
| `node:crypto` in Bun | Bun 1.4.2 | hub shell | Ed25519 for publisher signatures, SHA-256: already used | — |
| `@noble/curves` | 2.4.0, already in `packages/protocol` | protocol package (hub, vectors) | deterministic P-256 signing of the header | Web Crypto (randomised signatures) |
| `@noble/hashes` | 2.4.0, already in `packages/protocol` and `hub` | protocol package, phone | HKDF and HMAC for the session | — |
| `react-native-ble-plx` | not installed; named in stack.md † | app, phone build (`docs/m3-design.md`) | the phone's Bluetooth | — |

Considered and not proposed: compression or delta updates (`espressif/esp_delta_ota` ‡, or the ROM's inflater ‡), section 12, P7.

## 10. The order of work

The coordinator writes one order of work for the three designs. This section gives what this design contributes to the joint step 0, its owners by folder, and exactly which later steps need (a) ESP-IDF installed on this Mac, which needs the product owner's approval, (b) boards in hand, or (c) M1b's ESP-IDF platform layer written.

### Its part of the joint step 0

Frozen once, by the one step 0 owner, with the other two designs' parts:

1. **Protocol.** The messages 0x06, 0x07, 0x83 and 0x84; Started's new fields; the transfer frames; the image header and its signed bytes; the `.hsnf` file and its manifest schema; the session key and tag. Text in `docs/protocol.md` (proposed in the report), types and codecs in `packages/protocol` (with `signImageHeader` and CRC-32), the C++ codec's descriptors, and every vector.
2. **Firmware interfaces.** `FirmwareSlots`, `UpdateCrypto`, `BootImage`, `LinkKind::bluetooth`, the `Hal` fields, store key 0x05, `UpdateService`'s interface to the roles and to `Device`, `SecureChannel::change_key` and the role's "report again" hook (section 7), the new log codes, and `Device`'s trial rules as stubs.
3. **Hub model.** The `firmware` module as a stub, placed in `step.ts`'s order by the joint step 0 (section 4 says what it must come after and before); `updateOffer`, `oldKeyPacket`; the `transferGrant`, `transferRevoke` and `bluetoothSession` effects; `transferProgress`; `fileJob {stageFirmware, removeFirmware}` and the `release` field of the relay design's `fetchRelease`; `keyUsed` on `OpenedPacket` and `rekeyKeys` in the boot snapshot; the `Transfers` port; section 4's three tables and `device_keys`' two columns, in the next migration of the one sequence; the decisions; the `HubRules` values; the lockstep-only `restore` command (section 7).
4. **App operations**, in the one channel version 2: `firmware.list`, `firmware.offers`, `firmware.fetch`, `firmware.upload`, `firmware.remove`, `firmware.bluetooth`, `firmware.download`, `rollout.*`; the `deviceUpdate` event; device objects' `update` field; and the matching control commands for `hsn`.

### Owners, step 1

Labels for the coordinator to merge into the joint plan. Each owner changes only the folders named; a frozen interface changes only through the step 0 owner.

| Owner | Folders | Steps |
| --- | --- | --- |
| U1 | `firmware/core/src/device/update*`, `firmware/core/include/hsn/device/services/update*`, `firmware/tests/device/update*` | 1. `UpdateService`: frames, checks, flash order, checkpoints. 2. Trial and confirmation. 3. The Bluetooth session |
| U2 | `firmware/platform/host/` (the new fakes, the fake bootloader, `ScriptPhone`, `TestHub`'s update and restore rules, `Medium::replay`), `firmware/tests/host/update*` | 1. Fakes and the boot path. 2. Power cuts at every operation. 3. `TestHub` serving, offers and key changes |
| U3 | `firmware/platform/psa/` | `UpdateCrypto` on PSA, against the vectors |
| U4, U5, U6 | `roles/sensor/`, `roles/siren/`, `roles/gateway/` with their tests | Each role's health condition, its update packets, its "report again" after a key change; the gateway's write gate and busy bound |
| U7 | `hub/src/core/firmware/` | The module: store index, offered releases, rollout, conditions, offers, sessions, records |
| U8 | The update parts of `hub/src/core/sensors/`, `sirens/`, `gateways/`, `intake/`, `links/`, `app/` | Sealing and sending offers, the reply flag, sensors on a network link, the new paths, rejected frames, device objects' `update` |
| U9 | `hub/src/shell/firmware/`, `hub/cli/` (the `firmware` and `rollout` commands) | Release and own-build checks, staging, the store, serving, the session key |
| K1 | The key change in `hub/src/core/intake/`, `sensors/`, `sirens/`, `gateways/`; `hub/src/shell/cipher/`, the `KeyStore`, `applyRestore`'s transaction | Section 7, hub side, with its scenario and crash tests |
| K2 | `firmware/core/src/device/secure_channel*` and its tests | `change_key` and its flash order |
| U10 | `hub/test/budget/`, `hub/test/crash/`, `firmware/tests/system_roles/update_*` and `restore_rekey_test.cpp`, `RemoteHub`'s new commands | The rollout day, crash points, the six lockstep tests |

U8 and K1 touch the same four hub folders for different features; the coordinator either gives both to one owner or splits them by file.

### Step 2: integration

The step 0 owner with each: `firmware` in `step.ts`'s order, the loop's handling of the new effects, `serve.ts` behind the `Transfers` port on every link kind, the lockstep tests green.

**Nothing in steps 0 to 2 depends on ESP-IDF, boards or M1b's layer.** The firmware side builds with CMake and the host compiler against TF-PSA-Crypto 1.1.0, which the host build already pins and fetches; the hub side runs on Bun; the rollout and the key change are proven through the real hub in lockstep on the simulated radio. Two things are built in steps 0 to 2 against stated layouts rather than real artefacts, and are checked again in step 3a: the hub's check of an ESP-IDF application image's header (tested on images the test makes from the layout ‡), and the partition table (written as a CSV, which only ESP-IDF compiles).

### Step 3: ESP-IDF, boards, M1b, phones

| Step | Needs (a) ESP-IDF installed | Needs (b) boards | Needs (c) M1b's layer | Also | What |
| --- | --- | --- | --- | --- | --- |
| 3a | yes | no | no | — | Build an image: its size against the 3.5 MB slot (D103), the bootloader's against 0x8000, the partition table compiled; a real application image for the hub's own-build check and for making a test `.hsnf`; `platform/esp-idf/update/` compiled against v6.1's headers |
| 3b | yes | yes | no | the power profiler | On a throwaway ESP-IDF app: the real bootloader's rollback (trial, reset, deep-sleep wake, fast boot), sector erase and program times, P-256 verification time through PSA, power cuts during `otadata` writes |
| 3c | yes | yes | no | an Android phone and an iPhone | S9's transfer half (section 5), on a throwaway app with the update service |
| 3d | yes | yes | yes | phones, for Bluetooth | `FirmwareSlots` on `esp_partition` and `esp_ota_ops`, the sensor's Wi-Fi link and the update service on NimBLE in `platform/esp-idf/`; updates end to end over Wi-Fi, USB and Bluetooth; the gateway under load while it updates; random power cuts with the MOSFET module; current per session |
| 3e | yes | yes | yes | — | The key change on real boards after a real restore |

The NimBLE host on the board is shared by pairing and updates: one owner of `platform/esp-idf/bluetooth/` (`docs/m3-design.md` names F1), with the update service written there to this design's frames.

### What this needs from the relay design

Read in `docs/m4-design.md` sections 6 and 13. **What fits:** the releases role indexes `hsn-firmware-<version>.hsnf` files beside hub releases; `release.check`'s `firmware` field carries the newest version in the hub's store, and `release.offer` answers with the newest firmware above it; `release.get` downloads in pieces of 256 KiB ‡ into `uploads/`, resuming at its offset; the relay checks no signature and the hub checks every byte against `PUBLISHER_KEYS`; nothing is fetched until a person asks (D54); the bytes travel over the link the hub already holds (D84).

**What does not fit yet**, for the coordinator or the relay design:

1. **Who owns firmware offers and fetches.** The relay design routes `releaseOffered`, `update.offers`, `update.fetch` and `fetchRelease` to `upkeep`, ending in `fileReady {updateStaged}` with `wrongSystem` and `notNewer` among its refusals. Firmware is `firmware`'s: this design proposes `firmware.offers` and `firmware.fetch {version}` owned by `firmware`, and a `release: "hub" | "firmware"` on `fetchRelease`, whose firmware outcome runs `stageFirmware` and ends in `firmwareStaged` or section 3's refusals. No `notNewer`: an older image may be fetched to undo a bad release. The alternative is one `update.fetch {version, kind}`.
2. **The offer's record.** The relay design records `update_offered` once per hub version; this design records `firmware_release_offered` for firmware. One notification kind with a `kind` field would also do.
3. **The manifest schema.** The releases role reads `manifestSchema` from `hub/src/shell/update/release.ts`, which has `platform`; a firmware manifest has `target` and `roles` instead. Both schemas should move to `packages/protocol`, where the relay can import them.
4. **Size.** The relay design fetches under M2's 256 MB upload cap; a firmware listing over 8 MB is refused before fetching.

### What this needs from the phone design

Read in `docs/m3-design.md` sections 5, 7 and 10. **What fits:** the app's steps of section 7 (the image cached with `expo-file-system` and resumable, finding and connecting, progress with the screen kept awake, "Carry on" after a lost connection, the result from the hub); `FirmwareTransfer` over `GattLink`, whose inside is to answer the device's Gets until Done, with progress the highest offset served over the file's bytes; `react-native-ble-plx` behind `BleCentral`; the scripted board and the simulator bridge in `tools/ble-bench`, which must gain a model of the device's side of the update service; S9 run with real phones at M3's start. Its section 10's eight questions are answered here:

| Its question | Answer |
| --- | --- |
| 1. The largest image | Up to 3.5 MB (the slot); about 1.5 MB expected. The file the phone holds is the 128-byte header and the image |
| 2. How the phone gets the image | `firmware.download {image}`, by image id (from `firmware.bluetooth`'s reply), as `fileChunk` events |
| 3. Which devices need Bluetooth, and why one is held | `update: {state, held, method}` on every device object, plus `deviceUpdate` events (section 4) |
| 4. How a sensor opens Bluetooth | Only on the hub's offer (D138): at its next heartbeat, or at once if its cover is opened; `needsWake` tells the app which to say |
| 5. The service, chunks, flow control, end | Section 5: UUIDs, frames, the device pulling with windows of 8, writes without response, resuming by the device's own Gets, Done before the device reports to the hub |
| 6. Is the session authenticated | Yes: a session key from the hub and the Hello and Open exchange. A ticket signed with the hub's key was rejected (section 5) |
| 7. How the result reaches the hub | The device's `Update status` over LoRa, then its Started; the app sees `deviceUpdate` and the `device` event |
| 8. One service with pairing | No: separate services (D138) |

**What does not fit yet**, to change in `docs/m3-design.md` (not edited here):

1. Section 5, "The pairing window": "on a paired board at a 5 s hold while disarmed, for an update session only (updates design)" goes; a paired board opens Bluetooth for an update only on the hub's offer.
2. Section 5, "Advertising": the state "paired with an update window open" goes from pairing's service data; an update window advertises the update service instead.
3. Section 7, step 2, "Open Bluetooth on the sensor": becomes "wait for the sensor, or open its cover", by `needsWake`.
4. Section 7, step 3, "by the sensor's chip, as in pairing": by the `hsn-<address>` name.
5. Section 7, step 5, "The sensor is installing it": it installs when the hub gives the go-ahead, which may wait for its turn or a disarm; "Sent. It installs when the hub says so."
6. Section 9, S9's point 4, "written without response with its flow control": the device-driven pull with windows of 4, 8 and 16 (section 5's list).
7. The phone design's hub operations (`pair.prepare`, `pair.finish`) and this design's (`firmware.*`, `rollout.*`) all go into the one channel version 2.

## 11. Readiness

(a) ESP-IDF installed (the product owner's approval), (b) boards in hand, (c) M1b's platform layer written.

| Piece | Built and proven on this Mac now | Needs (a) | Needs (b) | Needs (c) | Also waits for |
| --- | --- | --- | --- | --- | --- |
| Protocol text, TypeScript and C++ codecs, vectors (updates and key change) | yes | — | — | — | — |
| `UpdateService`, `Device`'s trial rules, the HAL interfaces, `change_key` | yes, on the host | — | — | — | — |
| Fakes, fake bootloader, power cuts at every write, replayed packets | yes | — | — | — | — |
| `UpdateCrypto` on PSA | yes, on the host | to build for the target | to prove on the target | — | — |
| Roles' health, update handling and "report again" | yes, on the host and in lockstep | — | real radios | yes | — |
| Hub module, tables, store, signing, serving, operations, `hsn` | yes | — | — | — | — |
| A rollout and a key change through the real hub in lockstep | yes | — | — | — | — |
| The hub's check of a real ESP-IDF application image | on synthetic images | a real image | — | — | — |
| Official releases | with the test key only | — | — | — | the publisher's release key (D123) |
| Releases fetched through the relay | no | — | — | — | the relay (M4), and section 10's four points |
| Partition table, image and bootloader size | written, not compiled | yes | — | — | — |
| The real bootloader's rollback, flash timings, P-256 time | no | yes | yes | — | the power profiler |
| `FirmwareSlots` on real flash; Wi-Fi and USB updates; random power cuts | no | yes | yes | yes | Windows USB also W1 (M2 9) |
| The update service on NimBLE; the phone's Bluetooth path; S9 | no | yes | yes | yes, except S9 (a throwaway app) | a real Android phone and iPhone |
| The key change on real boards | no | yes | yes | yes | — |
| Times and battery (section 5) | estimates | yes | yes | — | the power profiler, phones |

## 12. Decided, and still open

### Proposed decisions, D134 to D141

For architecture.md, numbered after the relay design's D125 to D131 and the phone design's D132 and D133.

| # | Decision | Rejected, and why | Here |
| --- | --- | --- | --- |
| D134 | Every board has a fixed partition table of two 3.5 MB slots, an 896 KB reserve and no factory slot, never changed over the air. A new image runs on trial under ESP-IDF's rollback, never sleeps deeply until it confirms, and confirms only after it has opened a packet from its own hub (a sensor: the reply to its Started), within a deadline (10 minutes for a sensor, 5 for a siren or gateway ‡). A transfer never starts while the running image is on trial. Stored records change only by adding fields at their end | A factory slot: a third copy for no gain over rollback. Confirming on a self-test at boot: proves nothing about the key or the path. A soak on the device: hours awake drain a sensor | Section 2 |
| D135 | A device keeps doing its job while it downloads; it is out of service only for the restart into the new image, about a second, and a sensor updates only while disarmed. Amends D91 | D91's sensor out of service for a minute: unnecessary, since the LoRa radio is separate from the 2.4 GHz one | Section 6 |
| D136 | Two signatures. The publisher signs a release (Ed25519, `hsn-firmware/1`); only the hub checks it. The hub signs a 128-byte image header with its P-256 key (`hsn-image/1`, deterministic), which devices check before writing anything. Devices make no version check. An owner's own build is signed by the hub after a person confirms it on the console | ESP-IDF's signed apps: RSA only on the S3 and a key fixed in the build, against D35. Devices checking the publisher's signature: a second algorithm, and own builds have none. A version floor on the device: physical access defeats it, and it stops the hub undoing a bad release | Section 3 |
| D137 | One transfer format on WebSocket, USB and Bluetooth: the device pulls pieces (`Get`, `Data`, frames starting 0xF2), in the clear, each with a CRC-32, the whole checked by the signed hash. The hub's shell serves the pieces the core has granted, and records a transfer by its decisions and the device's statuses, not frame by frame | HTTP ranges: a second server and format, nothing for USB. Encrypted packets per piece: counters per piece, and a phone cannot encrypt. The core per piece: about 1,600 steps per device for no decision | Sections 4, 5 |
| D138 | For an update, Bluetooth opens on a device only on the hub's offer (over LoRa or its link), for a window of 2 minutes ‡, on a GATT service of its own, separate from pairing's protocomm service. A phone opens a session with a one-time key the hub derives from the device key and gives it inside the app's channel | A 5 s button hold: anyone near could keep the sensor awake. One service with pairing. A ticket signed by the hub: a sensor has no clock to expire it, and Bluetooth still needs the hub's word to turn on | Section 5 |
| D139 | A rollout is approved by a person; it starts with one pilot of each role and an hour's soak ‡, then the rest: sirens and gateways one at a time, sensors four at a time ‡, only while disarmed and above 30% battery ‡ (P9). A device installs only on the hub's go-ahead, never during a countdown, an alarm or a site move; transfers pause during a countdown or alarm. A rollback pauses the rollout | One pilot of any role: a role-specific fault would reach every device of the other roles. Installing when verified: the hub could not keep D91's rules | Section 4 |
| D140 | The hub keeps at most four firmware images (8 MB ‡) in its data folder, never in backups, and never removes one by itself | Keeping every release: unbounded on a Pi's card | Section 4 |
| D141 | After a restore, the hub acts on no packet under a device's old key: it answers with a new key (0x84 Key change) sealed under the old one, and the device stores it, then its resume point, and repeats what it was saying under the new key. The hub makes each new key at the device's first old-key packet and keeps both keys until it hears the new one, with no deadline. Sirens get theirs at the restored hub's first start; a gateway gets its in place of the welcome. Settles O16 | Moving counter bases (rejected in M2 9). A deadline, then pairing again. Making every key at the restore: over a step's entropy. A session under the old key for gateways: acting on an old-key packet | Section 7 |

LoRa stays out under D10; section 5 adds the numbers.

### The reviewer's rulings

| # | Question | Ruling |
| --- | --- | --- |
| R1 | Data through the core's `UpdateService` into a HAL, or the platform doing the transfer | Through the core |
| R2 | Transfer frames in the clear, or sealed | In the clear |
| R3 | The shell reading the 0xF2 prefix (HD 3) | Yes, on granted links only |
| R4 | HKDF-SHA256 and HMAC-SHA256 for the Bluetooth session | Yes |
| R5 | Windows of 4 and 8, 1,000-byte pieces, 64 KB checkpoints, 2 and 3 s re-asks, 120 s window, 15-minute session | Accepted as provisional values, each to be measured (section 5) |
| R6 | No row per transfer frame | Yes |
| R7 | The partition table and its reserve | Yes, to be confirmed on the first board (step 3a) |
| R8 | Deterministic signing with `@noble/curves` | Yes |
| R9 | Trial deadlines | Yes, provisional |
| R10 | A siren's health condition | Yes |
| R11 | The gateway writing flash only when no transmission waits | Yes, with the bound for a site that is always busy (section 5) |
| R12 | Pausing every transfer during a countdown or alarm | Yes |
| R13 | Update queries and statuses committed now | Yes |

### Questions for the product owner

**Beyond the decided signing (D124: not designed in; each can be asked for):**

| # | Measure | Defends against | Costs | Can it be added later | Without it |
| --- | --- | --- | --- | --- | --- |
| P2 | Secure Boot (eFuses burned with a key digest) | Someone with the board in hand flashing their own firmware over USB, or writing its flash directly | A fused key per board, irreversible; on the S3 RSA only (HN 2); a key fixed at manufacture, which conflicts with D35 and owners' own builds unless each owner fuses their own; a slower boot ‡ | Only on boards not yet fused; fusing in the field is irreversible and risky ‡ | A person with physical access can replace a device's firmware. The hub still notices a device that stops answering with its key, and that person could already read the key (§13) |
| P3 | Flash encryption (and NVS encryption) | Reading the device key out of a stolen or opened device | eFuses, a one-way switch per board; harder development and recovery; some flash speed ‡ | Same as P2 | A stolen sensor reveals its own key, as §13 already accepts; no other device is affected |
| P4 | Anti-rollback counters (eFuses) | Installing an older signed image with a known flaw | A limited number of fuse steps ‡; meaningful only with P2; owners can never go back | Yes, before boards are fused | Only the hub can install an older image (it must sign it), which is also how a bad release is undone |

**Scope, money and behaviour:**

| # | Question | Recommendation |
| --- | --- | --- |
| P1 | One publisher key for hub and firmware releases, or two (D123) | One, with the separate labels of section 3 |
| P5 | Opening a sensor's cover to start a Bluetooth update raises a tamper notification that cannot be turned off (D75). Keep it, or let the hub mark it "during an update you started" | Keep it, and let the app say beforehand that it will come |
| P6 | Pilots and an hour's soak make every release take at least an hour to reach every device | Accept |
| P7 | Compression for Bluetooth: about a third shorter ‡, for a decompressor on every device | Not now; reconsider if S9's typical case is under 10 KB/s |
| P8 | The real Android phone and iPhone the build plan lists are needed at M3's start for S9 | Buy them now |
| P9 | A battery floor of 30% for updates (UP7 gives no figure) | 30% on the interim curve (about 3,700 mV ‡) |

## 13. Gaps, contradictions and risks

### In other documents (not edited here)

| Where | Gap or contradiction | Reading taken |
| --- | --- | --- |
| D91 | "A sensor cannot report its door for about a minute while it installs" | About a second here (section 6); D91's text should follow |
| GW7 | "Updated over Wi-Fi": a gateway on the cable uses USB only (D81) and may hold no Wi-Fi details (PR2) | Over its link, Wi-Fi or USB |
| D72, HD 8 "When to reply" | The hub replies to a heartbeat only when settings differ or asked; the "update available" flag then waits for a link check, up to 15 minutes | The hub also replies while an offer waits for that sensor |
| §5, §6, §10, §14 | No update messages, Started fields or transfer frames; §14 says they come with M3 | Proposed text in the report |
| §10, D101 | "Each binary WebSocket message carries exactly one packet" | One packet or one transfer frame |
| §5's "Paths" for sensors | LoRa only | A sensor also uses Wi-Fi while it updates (§10 already says sensors use Wi-Fi only for updates) |
| FD 1, FD 3, FD 5 | No `FirmwareSlots`, no Bluetooth link, no update record; FD 1 lists `platform/esp-idf/` as if it existed | Section 2; the folder does not exist yet |
| FD 5, "Each record carries a version byte" | Silent on reading records a newer image wrote | Records grow only at their end (section 2) |
| FD 6, stuck awake | 20 minutes, shorter than a Bluetooth session and a trial together | 40 minutes while updating |
| HD 3, "The shell knows nothing of the protocol" | The shell now serves 0xF2 frames | Accepted for that prefix (R3) |
| D110 | "Every packet" recorded | Transfer frames are not packets; summarised (R6) |
| M2 3, D112 | The data folder's shares have no firmware store | Add up to 8 MB: about 304 MB in ordinary running, 583 MB briefly at a switch |
| HB33, UP7 | No battery floor for updates | 30% (P9) |
| D35, architecture | Silent on changing the hub's signing key | It cannot change without pairing every device again (section 3) |
| stack.md, "Pairing exchange" | Names ESP-IDF's provisioning layer; in v6.0 it left ESP-IDF for `network_provisioning` in idf-extra-components, with security versions 0 and 1 off by default (HN 1) | For `docs/m3-design.md` |
| hardware-notes.md | Written for the Heltec V3; the order is the Olimex board (dev-board-choice.md). Both have 8 MB of flash, so section 2 holds; the USB notes (HN 7) differ: the Olimex's CH340X UART is not the Heltec's CP2102 | Rates in section 5 are for the CH340X ‡ |
| §4 "Known limits", O16 | Accept that packets recorded between a backup and its restore can each be replayed once | No longer true with D141 (section 7); proposed text in the report |
| §7 "Hub restart" | Sends every siren "report now" | After a restore, a Key change instead (section 7) |
| HD 3 `DeviceCipher`, HD 2 "the only keys the core is ever given" | One key per device; only provisioning keys reach the core | Two keys during a key change; pending keys reach the core as provisioning keys do (section 7) |
| M2 9, restore's console words | Say how old the people and permissions are | Also: devices whose keys changed after the backup must be paired again (section 7) |
| `docs/m3-design.md` sections 5, 7, 9, 10 | The 5 s hold for updates, one Bluetooth service, finding by chip, "installing" after sending, S9's flow control | Section 10, "What this needs from the phone design": seven changes |
| `docs/m4-design.md` sections 6, 9 | Firmware offers and fetches routed to `upkeep`; the manifest schema in the hub's shell | Section 10, "What this needs from the relay design": four points |

### Risks

| Risk | What settles it |
| --- | --- |
| Bluetooth throughput from React Native far below the estimate | S9; compression (P7) if needed |
| Flash work disturbing Bluetooth, Wi-Fi or the radio's interrupts on the S3 ‡ | S9 and the gateway load test on a board; the DIO1 handler in IRAM (FD 3) |
| The bootloader with rollback larger than 32 KB | The first ESP-IDF build; the table moves before any board ships |
| The image larger than estimated (D103) | The first build; 3.5 MB slots leave room |
| A deep-sleep wake with fast boot skipping the rollback logic (HN(b)) | Not used on trial (section 2); tested on the board |
| A real outage during a trial rolls good images back | Rare; the rollout pauses and a person resumes |
| P-256 verification slow or heap-hungry on the S3 (HN 2) | Once per update, on the platform side; measured in S9 |
| A record format change that an older image cannot read | The rule of section 2 and the rollback test with an extended record |
| `react-native-ble-plx` maintenance and new React Native versions | `docs/m3-design.md` |
| A flood of replayed packets after a restore draws Key changes and airtime | One Key change per device every 10 s ‡ (section 7) |
| A restore from an older backup strands devices whose keys changed since | D122's immediate backups; the console says so (section 7) |

### What this design is least sure of

- Every Bluetooth figure in section 5: from memory, and the JavaScript bridge's cost is a guess until S9.
- Flash timings and the ESP-IDF calls' exact behaviour (resuming with `esp_partition_*` then `esp_ota_set_boot_partition`, the two `otadata` copies, the bootloader falling back from an image that fails its check): all ‡, all checked on the first board.
- Whether a gateway's flash writes can always be kept out of the way of transmits at a given time on a busy site; section 5's bound and forced update cover the case where they cannot.
- The key change's one assumption beyond M2 9: that answering a replayed old-key packet with a Key change, which only the real device can open, gives an attacker nothing; reviewed against §13's table, it gives nothing but airtime, which the 10 s limit bounds.
