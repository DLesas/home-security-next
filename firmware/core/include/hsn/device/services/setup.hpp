#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

#include "hsn/device/hal/build_info.hpp"
#include "hsn/device/hal/link.hpp"
#include "hsn/device/hal/storage.hpp"
#include "hsn/device/services/log_buffer.hpp"
#include "hsn/device/services/record.hpp"
#include "hsn/device/time.hpp"
#include "hsn/protocol/bytes.hpp"
#include "hsn/protocol/counters.hpp"
#include "hsn/protocol/setup.hpp"

namespace hsn::device {

/** Pairing data as stored (protocol section 9): 192 bytes, no padding. */
struct PairingRecord {
  std::uint32_t address = 0;
  protocol::DeviceKey key{};
  protocol::HubIdentity hub_identity{};
  protocol::SigningKey firmware_signing_key{};
  std::uint8_t site_channel = 0;
  std::uint8_t allowed_data_rate_mask = 0;
  std::uint8_t wifi_name_size = 0;
  std::array<std::uint8_t, protocol::kMaxWifiNameSize> wifi_name{};
  std::uint8_t wifi_password_size = 0;
  std::array<std::uint8_t, protocol::kMaxWifiPasswordSize> wifi_password{};

  /** Copies decoded pairing data; the Wi-Fi views are copied into the arrays. */
  static PairingRecord from(const protocol::PairingData& pairing);

  /** Where a network link connects; views into this record. */
  LinkTarget link_target() const;
};

/** The stored role: one byte (D103). */
struct RoleRecord {
  std::uint8_t role = 0;
};

/** Record versions. */
constexpr std::uint8_t kPairingRecordVersion = 1;
constexpr std::uint8_t kRoleRecordVersion = 1;

/** Returns a role's counter step: 64 for sensors, 1,024 for the rest (protocol section 4). */
protocol::CounterStep counter_step(std::uint8_t role);

/**
 * Reads the stored role for the platform's start-up switch: 0 when none is stored or it cannot
 * be read.
 */
std::uint8_t stored_role(Storage& storage);

/** What the device must do after a setup message. */
enum class SetupAction : std::uint8_t {
  none,
  /** Restart: the pairing or the role changed. */
  restart,
};

/** The outcome of one setup message. */
struct SetupResult {
  /** Bytes of the reply in the caller's buffer; 0 for no reply. */
  std::size_t reply_size = 0;
  SetupAction action = SetupAction::none;
};

/**
 * The USB setup messages of protocol section 10, and the stored role and pairing. The rules:
 * a release gateway accepts Provision only while unpaired, release sensors and sirens refuse it;
 * a development build accepts Provision and Erase at any time. Set role: a release build accepts
 * it only while no role is stored; a development build at any time, forgetting the pairing when
 * the role changes; an unlisted role is refused and the identity shows the role unchanged.
 */
class SetupService {
public:
  SetupService(Storage& storage, const BuildInfo& build);

  /**
   * Reads the role and the pairing from flash.
   */
  HalError load();

  /**
   * Returns the stored role, or 0.
   */
  std::uint8_t role() const {
    return role_.stored() ? role_.get().role : 0;
  }

  bool paired() const {
    return pairing_.stored();
  }

  const PairingRecord& pairing() const {
    return pairing_.get();
  }

  /**
   * Returns this device's identity message.
   */
  protocol::Identity identity() const;

  /**
   * Handles one setup message (starting with 0xF1) received on USB, writing any reply into
   * `reply` (at least 32 bytes).
   */
  SetupResult handle(protocol::ByteView message, protocol::MutableByteView reply, LogBuffer& log,
                     Instant now);

  /**
   * Handles setup received on USB or inside an authenticated Bluetooth session, writing any
   * reply into `reply` (at least 32 bytes). USB applies its existing setup rules. Bluetooth
   * accepts Provision only when a role is set and the board is unpaired, and refuses Erase and
   * Set role. Other links are ignored.
   */
  SetupResult handle(LinkKind link, protocol::ByteView message, protocol::MutableByteView reply,
                     LogBuffer& log, Instant now);

  /**
   * Erases keys and settings, keeping the role (PR4).
   */
  HalError factory_reset();

private:
  SetupResult provision(const protocol::Provision& message, protocol::MutableByteView reply,
                        LogBuffer& log, Instant now, LinkKind link);
  SetupResult set_role(const protocol::SetRole& message, protocol::MutableByteView reply,
                       LogBuffer& log, Instant now);
  SetupResult reply_identity(protocol::MutableByteView reply, SetupAction action) const;
  SetupResult reply_provision(std::uint8_t outcome, protocol::MutableByteView reply,
                              SetupAction action) const;

  Storage& storage_;
  BuildInfo build_;
  Record<RoleRecord> role_;
  Record<PairingRecord> pairing_;
};

}  // namespace hsn::device
