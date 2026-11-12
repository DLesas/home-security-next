# Firmware

Firmware for the sensors, sirens and gateways (ESP32-S3, ESP-IDF v6.1). It holds the device protocol of [docs/protocol.md](../docs/protocol.md), version 1, checked byte for byte against [packages/protocol/vectors](../packages/protocol/vectors), and the device layer of [docs/firmware-design.md](../docs/firmware-design.md): events, the Runner, the hardware interfaces, the shared services, host fakes, and the three role skeletons. The codec was written from the specification and the vectors only, without reading the TypeScript implementation, so a misreading on either side shows up as a mismatch.

## Layout

```
CMakeLists.txt, CMakePresets.json   host build; the ESP-IDF build will wrap the same two libraries
cmake/                              compile options, pinned dependencies, the core rule checks
core/                               hsn_core: portable C++17, no heap, no platform includes
  include/hsn/protocol/
    bytes.hpp      byte views, bounded little-endian reader and writer
    error.hpp      Error and Result
    cipher.hpp     PacketCipher, the only crypto the core knows
    binding.hpp    the three bindings of section 4
    packet.hpp     read_header, open_packet, seal_packet, nonce and associated data
    layout.hpp     field descriptors that declare every wire layout once
    messages.hpp   bodies of sections 5 and 6, decode_message, log entries
    setup.hpp      pairing data (section 9) and USB setup messages (section 10)
    framing.hpp    COBS and the streaming frame decoder (section 10)
    counters.hpp   sender resume points and the strictly-higher receive rule (section 4)
    units.hpp      unit conversions with integer arithmetic
    radio.hpp      data rates and LoRa time on air (section 2)
  include/hsn/device/   the device layer (design sections 2–6)
    time.hpp events.hpp role.hpp timers.hpp status.hpp services.hpp device.hpp runner.hpp
    hal/           one header per hardware interface, vendor-free
    services/      secure channel, airtime, radio port, retry, random, log, record, setup, health
  src/             the above, plus codec.hpp, the one encoder and decoder; src/device/ for the layer
roles/<role>/                       hsn_role_sensor, _siren, _gateway: one Role each (skeletons for now)
platform/psa/                       hsn_psa: PacketCipher on PSA Crypto; hub_identity, the SHA-256 of section 9
platform/host/                      hsn_host: a fake per interface, HostBoard and HostInstance, and the
                                    bench: Simulation, Medium, TestHub, timeline (see its README.md)
tests/                              doctest host tests: protocol/ (codec and vectors), device/, roles/,
                                    host/ (the bench), system/; rule probes
```

## Rules of the core

`hsn_core` must run on a battery sensor with a small task stack, and must never misbehave on bytes from the radio:

- C++17 exactly (`CMAKE_CXX_EXTENSIONS OFF`), built with `-fno-exceptions -fno-rtti`. ESP-IDF v6 defaults to gnu++26; the core does not depend on that.
- No heap. Callers supply every buffer. Variable parts are views into the input: a forwarded packet's or transmit request's inner packet, Wi-Fi name and password, log text. Log entries are visited one at a time (`LogEntryReader`) or appended one at a time (`LogEntriesWriter`).
- Only allocation-free standard headers, no platform includes, no floating point, no recursion, every loop bounded by an input length or a constant.
- No undefined behaviour on any input: integers are assembled from bytes, little-endian on every host; signed values are converted by arithmetic; slices clamp to their view.
- Results are values: `Error` and `Result<T>` are `[[nodiscard]]` types. Nothing throws or aborts.
- Namespaces `hsn::protocol` (codec) and `hsn::device` (device layer). Roles live in `hsn::roles::<role>` and follow the same rules.
- Interfaces have a protected, non-virtual destructor (a virtual one references `operator delete`). `device::Role`'s methods have do-nothing defaults defined in the core instead of being pure virtual, because a pure virtual function makes every role library reference `__cxa_pure_virtual`. Test code deriving from `Role` is built without RTTI, like the core that emits `Role`'s vtable.

What can be enforced is enforced by CTest:

| Test | Enforces |
| --- | --- |
| `core_symbols` | `libhsn_core.a` references no `operator new`/`delete`, `malloc`, `free`, `abort`, `__cxa_*` exception or pure-virtual symbols, unwinder or `__throw_*` symbols |
| `core_sources` | core sources include only `<array> <cstddef> <cstdint> <cstring> <limits> <optional> <tuple> <type_traits> <utility>` and the core's own headers (`hsn/protocol/*`, `hsn/device/**`, the private `codec.hpp`), and use none of `float`, `double`, `new`, `delete`, `malloc`, `free`, `throw`, `try`, `catch`, `typeid`, `dynamic_cast`, `goto`, or allocating `std::` types |
| `role_<role>_sources` | the same rules for `roles/<role>/`, which may include the core's public headers and its own `hsn/roles/<role>/*` only: not another role, a platform header or `codec.hpp` |
| `role_<role>_symbols` | each role library passes the `core_symbols` check |
| `*_catches_violations` | each check fails on a probe that breaks its rules, so neither passes vacuously |
| `-Wframe-larger-than=512` | in builds without sanitizers, a core, role or PSA function with a stack frame over 512 bytes does not compile |

Recursion is not checked mechanically; the core has none.

## How each layout is declared once

Every body is a plain struct with a `static constexpr auto layout()` that returns a tuple of descriptors in wire order:

```cpp
static constexpr auto layout() {
  return std::make_tuple(field("action", &SirenCommand::action),
                         field("soundSeconds", &SirenCommand::sound_seconds));
}
```

A descriptor holds the field's name in the vectors and a pointer to the member. The member's C++ type chooses the wire form: `uint8_t` u8, `int8_t` i8, `uint16_t`, `int16_t` and `uint32_t` little-endian, `std::array<uint8_t, N>` N bytes, `bool` a strict 0/1 byte, `LengthPrefixed<Max, …>` a length byte and a view, `CarriedPacket` an 18-to-255-byte view to the end of the body, a struct with `flag_bits()` one flags byte (bit 0 first, unnamed bits ignored on decode and written as zero), and a struct with `layout()` its own fields. `checked_field` adds a validity check (pairing address), `fixed_byte` a constant that is not a field (pairing format version).

One private codec in `core/src/codec.hpp` walks these tuples with index sequences and fold expressions, for both directions; it reads the descriptors as compile-time constants, so the names never reach the binary. `decode_body`, `encode_plaintext`, `decode_setup_body` and `encode_setup` are explicitly instantiated for every message in `messages.cpp` and `setup.cpp`. The tests walk the same tuples to turn a decoded struct into JSON and compare it with the vector's `fields` object, and to build a struct from `fields` for the encoder, so a field missing, misnamed or out of order fails the vectors.

Enumerated fields keep the raw byte, with named constants in a struct (`SirenAction::test`) and one helper, `is_known<SirenAction>(value)`.

## The packet path

```cpp
// Receiving: read_header alone gives the address for the key lookup; open_packet checks the
// tag, then the type's direction; decode_message checks the type is known and decodes the body.
const auto opened = open_packet(cipher, packet, Direction::from_hub,
                                Binding::sensor_packet(my_counter), PacketLimit::radio, plaintext);
if (opened.ok()) {
  const Error error = decode_message(opened.value().type, opened.value().body, visitor);
}

// Sending: take a counter (saving its resume point first when asked), encode, then seal.
const auto taken = send_counter.take();
const auto plaintext_size = encode_plaintext(heartbeat, plaintext);
const auto packet_size =
    seal_packet(cipher, {Direction::to_hub, address, taken.value().counter}, Binding::none(),
                ByteView(plaintext).first(plaintext_size.value()), PacketLimit::radio, out);
```

`PacketCipher` is the core's only crypto dependency. `hsn::psa::PsaPacketCipher` implements it with `psa_aead_encrypt` and `psa_aead_decrypt`, `PSA_ALG_AEAD_WITH_SHORTENED_TAG(PSA_ALG_CCM, 8)`, and an AES-128 key imported once by `set_key` and destroyed with the object. It includes only `<psa/crypto.h>`. On a failed tag the plaintext buffer is zeroed, by the cipher and again by the core.

## Not in the firmware

- **The hub's 64-packet receive window and its restore jump of 2²⁴** (section 4). They are hub-only. The vector harness skips `counters.json`'s `replayWindow` and `restore` sections in an explicit, commented list; replayed packets under the window rule are still opened. The test hub in `hsn_host` has the window, checked against `replayWindow` in `tests/host/replay_window_test.cpp`.
- **`signingPrivateKey`** in `pairing-data.json`: kept there for later firmware-signature tests. The `hubIdentity` section is checked, with `psa_hash_compute`.
- **Snr and airtime as fractions.** The core gives the SNR in hundredths of a decibel (`snr_hundredths_db_from_quarters`), which is exact; airtime is already in hundredths of a percent on the wire. The tests compare both with the vectors' decimal values.

## Building and testing

Needs CMake 3.28 or later, Ninja and a C++17 compiler; configuring downloads the pinned dependencies.

```sh
bun run check:firmware         # configure, build and test with AddressSanitizer and UBSan
bun run format:firmware:check  # clang-format, from the clang-format-node dev dependency
bun run check:firmware:gcc     # both presets with GCC 15 on Linux, in Docker
bun run check:all              # bun run check, then check:firmware
cd firmware && cmake --workflow --preset host-release   # optimised, no sanitizers
```

Before merging from a Mac, run `check:firmware:gcc`: the devices and CI build with GCC, which catches what Apple clang lets through. It needs Docker and copies the firmware and the vectors into a `gcc:15` container, so the Mac's build folders are not touched.

Build folders are `firmware/build/<preset>`. `HSN_VECTORS_DIR` points the tests at `packages/protocol/vectors`; a file or top-level section there that the harness does not handle fails the run.

Pinned dependencies (`cmake/dependencies.cmake`), each by archive and SHA-256:

| Dependency | Version | Use |
| --- | --- | --- |
| TF-PSA-Crypto | 1.1.0, tag commit `29160dd8`, the one Mbed TLS 4.1.0 bundles and ESP-IDF v6.1 ships | `hsn_psa` on the host; library only |
| doctest | 2.5.3, commit `2d0a9359` | tests |
| nlohmann/json | 3.12.0, commit `55f93686` | tests only |

TF-PSA-Crypto comes from its release archive of that tag, not a git checkout: the archive carries the generated driver wrappers, which a checkout would need Python's jinja2 and jsonschema to generate.

## On the target, still to check

From the reviewer checklist of [hardware notes](../docs/hardware-notes.md): ESP-IDF calls `psa_crypto_init` at start-up (`set_key` calls it again, harmlessly); a heap trace around one seal and one open on the S3 (items 2 and 3; on v6.1 `psa_import_key` allocates once per key, and the ESP AES driver allocates its context at set-up); and the vectors passing on the target build too (item 7).

## Spec rules behind three choices

- A frame that decodes to no bytes is passed on and fails as too short (section 10, "Framing").
- An identity's hub identity bytes are ignored when "paired" is 0 (section 10, setup messages).
- The direction check comes before the known-type check; the order does not matter (section 3, "Any failed check drops the packet").

`SendCounter::take` also refuses a state that could repeat a counter; that guards the class's own invariant and is not a protocol rule.
