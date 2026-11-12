#pragma once

#include <array>
#include <cstdint>

#include "hsn/device/events.hpp"
#include "hsn/device/hal/sensor_io.hpp"
#include "hsn/device/role.hpp"
#include "hsn/device/services.hpp"
#include "hsn/device/time.hpp"
#include "hsn/device/timers.hpp"
#include "hsn/protocol/bytes.hpp"

namespace hsn::roles::sensor {

/** The sensor's timers (design section 7). */
enum class SensorTimer : std::uint8_t {
  next_heartbeat,
  reply_moment,
  listen_end,
  retry,
  countdown_end,
  local_alarm_end,
  pairing_hold,
  reset_hold,
  port,
  count,
};

/**
 * Settings held from the hub's reply. This is also the flash record: it excludes the armed
 * state, which lives in retained memory only (protocol section 6, decision G1).
 */
struct SensorSettings {
  std::uint8_t settings_version = 0;
  std::uint8_t countdown_seconds = 0;
  std::uint8_t heartbeat_interval_units = 0;
  std::uint8_t link_check_every = 0;
  std::uint8_t send_data_rate = 0;
  std::uint8_t reply_data_rate = 0;
  std::int16_t clock_correction_ten_ppm = 0;
};

/**
 * The sensor's whole state, kept in the retained block between wakes (design section 5).
 * Provisional: the sensor's owner may reshape it within device::kMaxRoleStateSize, bumping
 * kSensorStateLayout.
 */
struct SensorState {
  /** Retained only, never in flash; false after a start with no retained memory. */
  bool armed = false;
  SensorSettings settings;
  std::uint8_t top_state = 0;
  std::uint8_t heartbeats_since_link_check = 0;
  std::uint8_t unanswered_in_row = 0;
  bool listen_at_own_rate = false;
  bool door_open = false;
  std::uint8_t door_change_count = 0;
  bool local_alarm_sounded = false;
  std::uint8_t report_kind = 0;
  std::uint8_t attempt = 0;
  std::uint8_t sent_count = 0;
  std::uint8_t button_phase = 0;
  device::Instant door_changed_at;
  device::Instant report_origin;
  device::Instant button_pressed_at;
  /** Counters of the current event's tries, newest first (protocol section 4). */
  std::array<std::uint32_t, device::kMaxBoundCandidates> sent_counters{};
  std::array<device::Instant, device::kMaxBoundCandidates> sent_ended_at{};
  device::TimerSet<SensorTimer, static_cast<std::size_t>(SensorTimer::count)> timers;
};

/** Bumped whenever SensorState changes. */
constexpr std::uint8_t kSensorStateLayout = 1;

/** The longest a sensor stays awake: a retry run, a countdown and a local alarm (section 6). */
constexpr device::Duration kSensorLongestAwake = device::seconds(20 * 60);

/** The door sensor (design section 7). Skeleton: the behaviour is still to be written. */
class SensorRole final : public device::Role {
public:
  SensorRole(device::Services& services, device::SensorIo& io);

  std::uint8_t role_id() const override;
  void handle(const device::Event& event) override;
  device::Wake next_wake() const override;
  protocol::MutableByteView state_bytes() override;
  std::uint8_t state_layout() const override;
  std::uint8_t state_id() const override;
  device::Duration longest_awake() const override;

private:
  device::Services& services_;
  device::SensorIo& io_;
  SensorState state_;
};

static_assert(device::is_complete_role<SensorRole>, "a role must override every Role method");
static_assert(sizeof(SensorState) <= device::kMaxRoleStateSize, "fits the retained block");

}  // namespace hsn::roles::sensor
