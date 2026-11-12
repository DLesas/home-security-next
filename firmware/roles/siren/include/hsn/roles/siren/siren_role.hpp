#pragma once

#include <cstdint>

#include "hsn/device/events.hpp"
#include "hsn/device/hal/siren_io.hpp"
#include "hsn/device/role.hpp"
#include "hsn/device/services.hpp"
#include "hsn/device/time.hpp"
#include "hsn/device/timers.hpp"
#include "hsn/protocol/bytes.hpp"

namespace hsn::roles::siren {

/** The siren's timers (design section 7). */
enum class SirenTimer : std::uint8_t {
  auto_stop,
  wifi_report,
  lora_check,
  reconnect,
  port,
  count,
};

/** Settings held from the hub's siren settings; also the flash record. */
struct SirenSettingsHeld {
  std::uint8_t settings_version = 0;
  std::uint8_t wifi_report_interval_seconds = 0;
  std::uint8_t lora_check_interval_units = 0;
  std::uint8_t send_data_rate = 0;
  std::uint8_t command_data_rate = 0;
  std::uint8_t reserved = 0;
  std::uint16_t max_sound_seconds = 0;
};

/**
 * The siren's whole state, kept in the retained block, so a reset that keeps it resumes the
 * sounding (design section 5). Provisional: the siren's owner may reshape it.
 */
struct SirenState {
  /** See protocol::SirenState. */
  std::uint8_t output_state = 0;
  std::uint8_t top_state = 0;
  std::uint8_t reconnect_attempt = 0;
  bool wifi_up = false;
  device::Instant stop_at;
  SirenSettingsHeld settings;
  device::TimerSet<SirenTimer, static_cast<std::size_t>(SirenTimer::count)> timers;
};

/** Bumped whenever SirenState changes. */
constexpr std::uint8_t kSirenStateLayout = 1;

/** The siren controller (design section 7). Skeleton: the behaviour is still to be written. */
class SirenRole final : public device::Role {
public:
  SirenRole(device::Services& services, device::SirenIo& io);

  std::uint8_t role_id() const override;
  void handle(const device::Event& event) override;
  device::Wake next_wake() const override;
  protocol::MutableByteView state_bytes() override;
  std::uint8_t state_layout() const override;
  std::uint8_t state_id() const override;
  device::Duration longest_awake() const override;

private:
  device::Services& services_;
  device::SirenIo& io_;
  SirenState state_;
};

static_assert(device::is_complete_role<SirenRole>, "a role must override every Role method");
static_assert(sizeof(SirenState) <= device::kMaxRoleStateSize, "fits the retained block");

}  // namespace hsn::roles::siren
