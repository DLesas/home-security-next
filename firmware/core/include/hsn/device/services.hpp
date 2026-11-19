#pragma once

#include <cstddef>
#include <cstdint>
#include <type_traits>

#include "hsn/device/hal/build_info.hpp"
#include "hsn/device/hal/firmware_slots.hpp"
#include "hsn/device/hal/key_import.hpp"
#include "hsn/device/hal/link.hpp"
#include "hsn/device/hal/power.hpp"
#include "hsn/device/hal/radio.hpp"
#include "hsn/device/hal/random.hpp"
#include "hsn/device/hal/retained.hpp"
#include "hsn/device/hal/storage.hpp"
#include "hsn/device/hal/update_crypto.hpp"
#include "hsn/device/services/airtime.hpp"
#include "hsn/device/services/health.hpp"
#include "hsn/device/services/log_buffer.hpp"
#include "hsn/device/services/radio_port.hpp"
#include "hsn/device/services/random_source.hpp"
#include "hsn/device/services/secure_channel.hpp"
#include "hsn/device/services/setup.hpp"
#include "hsn/device/services/update.hpp"
#include "hsn/device/time.hpp"
#include "hsn/protocol/cipher.hpp"

namespace hsn::device {

/**
 * The hardware every role shares, as the platform provides it. Links are null where the board
 * has none. A sensor's network link is used only for updates (protocol section 10), and the
 * Bluetooth link only for update sessions (m3-updates-design.md section 5). The cipher holds the
 * paired key, imported by the platform at start-up; `key_import` replaces it after a key change.
 */
struct Hal {
  Storage& storage;
  RetainedMemory& retained;
  Radio& radio;
  Random& random;
  Power& power;
  FirmwareSlots& slots;
  UpdateCrypto& update_crypto;
  KeyImport& key_import;
  Link* usb;
  Link* network;
  Link* bluetooth;
  const protocol::PacketCipher& cipher;
  BuildInfo build;
};

/** The core's part of the retained block (design section 5): plain data. */
struct CoreRetained {
  /** The latest `now` seen; a smaller one at boot means the clock restarted. */
  Instant last_now;
  /** The last start-up (protocol section 6, Started), for uptime. */
  Instant started_at;
  CounterState counter;
  AirtimeState airtime;
  LogState log;
};

static_assert(std::is_trivially_copyable_v<CoreRetained>, "the retained block is copied as bytes");

/** Size of the retained block's header. */
constexpr std::size_t kRetainedHeaderSize = 16;

/** Room left in the retained block for a role's state (design section 5). */
constexpr std::size_t kMaxRoleStateSize =
    kRetainedBlockSize - kRetainedHeaderSize - sizeof(CoreRetained);

/**
 * The shared services (design section 4), built once by the platform and handed to the role.
 * Device starts them at boot and keeps `core` in the retained block.
 */
class Services {
public:
  explicit Services(Hal& hal_in)
      : hal(hal_in),
        random(hal_in.random),
        log(core.log),
        airtime(core.airtime),
        radio_port(hal_in.radio, airtime, random, log),
        channel(hal_in.cipher, hal_in.storage, core.counter, &hal_in.key_import, &log),
        setup(hal_in.storage, hal_in.build),
        health(hal_in.storage, hal_in.build),
        update(hal_in, setup, health, random, log) {}

  /**
   * Whole seconds since the last start-up (gateway status, protocol section 6).
   */
  std::uint32_t uptime_seconds(Instant now) const {
    const Duration up = now - core.started_at;
    const std::int64_t whole = up.us <= 0 ? 0 : up.us / 1000000;
    return static_cast<std::uint32_t>(whole > 0xFFFFFFFF ? 0xFFFFFFFF : whole);
  }

  Hal& hal;
  CoreRetained core;
  RandomSource random;
  LogBuffer log;
  AirtimeBudget airtime;
  RadioPort radio_port;
  SecureChannel channel;
  SetupService setup;
  Health health;
  UpdateService update;

private:
  /** Not copyable: declared and never defined (the core's source rules forbid "= delete"). */
  Services(const Services&);
};

}  // namespace hsn::device
