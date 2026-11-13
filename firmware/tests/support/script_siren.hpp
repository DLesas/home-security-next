#pragma once

// A scripted siren for the test hub's tests: it listens continuously on 869.525 MHz, connects its
// network link, and judges every command or settings packet with the core's open_command. A new
// command is acted on and answered with a report on the path it came by, an exact repeat is
// answered again, an older one gets nothing (protocol section 7). Settings set its command rate,
// and its site channel and sending rate from its next transmission, which is how it follows a
// move of the site. It can log scripted entries and
// send them over Wi-Fi as they arise. Not the siren role: no regular reports, no LoRa checks, no
// reconnects.

#include <array>
#include <cstdint>
#include <vector>

#include "hsn/device/events.hpp"
#include "hsn/device/hal/siren_io.hpp"
#include "hsn/device/role.hpp"
#include "hsn/device/services.hpp"
#include "hsn/device/time.hpp"
#include "hsn/protocol/messages.hpp"
#include "script_log.hpp"

namespace hsn::test {

/** How a ScriptSiren behaves. */
struct ScriptSirenConfig {
  std::uint8_t command_data_rate = 5;
  std::uint8_t send_data_rate = 5;
  /** Connect the network link at boot. */
  bool wifi = true;
  std::int8_t power_dbm = 14;
  /** Entries it logs, in time order; each goes over Wi-Fi as it arises, while connected. */
  std::vector<ScriptLogEntry> log_entries;
};

/** What a ScriptSiren got, kept by the test. */
struct ScriptSirenLog {
  struct Command {
    /** The board's clock. */
    device::Instant at;
    std::uint32_t counter = 0;
    std::uint8_t type = 0;
    std::uint8_t action = 0;
    std::uint16_t seconds = 0;
    device::CommandVerdict verdict = device::CommandVerdict::too_old;
    bool by_wifi = false;
  };
  std::vector<Command> commands;
  std::uint32_t reports_by_wifi = 0;
  std::uint32_t reports_by_lora = 0;
  /** The settings version it holds. */
  std::uint8_t settings_version = 0;
  /** Log entries packets its network link took. */
  std::uint32_t log_packets = 0;

  /** Commands with one verdict. */
  std::size_t count(device::CommandVerdict verdict) const;
};

/** The scripted siren. */
class ScriptSiren final : public device::Role {
public:
  ScriptSiren(device::Services& services, device::SirenIo& io, const ScriptSirenConfig& config,
              ScriptSirenLog& log);

  std::uint8_t role_id() const override;
  void handle(const device::Event& event) override;
  device::Wake next_wake() const override;
  protocol::MutableByteView state_bytes() override;
  std::uint8_t state_layout() const override;
  std::uint8_t state_id() const override;
  device::Duration longest_awake() const override;

private:
  void listen(device::Instant now);
  void on_command(protocol::ByteView packet, bool by_wifi, protocol::PacketLimit limit,
                  device::Instant now);
  void report(bool by_wifi, device::Instant now);
  void send_lora(device::Instant now);
  void send_logs(device::Instant now);

  device::Services& services_;
  device::SirenIo& io_;
  ScriptSirenConfig config_;
  ScriptSirenLog& log_;
  std::uint8_t command_rate_;
  /** Where it sends: from its pairing and config until settings say (protocol section 6). */
  std::uint8_t send_rate_ = 0;
  std::uint8_t site_channel_ = 0;
  bool settings_held_ = false;
  device::Instant output_until_ = device::Instant::never();
  bool lora_waiting_ = false;
  bool wifi_up_ = false;
  ScriptLogger logger_;
  std::array<std::uint8_t, protocol::kMaxLinkPacketSize> log_packet_{};
  std::size_t lora_size_ = 0;
  std::array<std::uint8_t, 64> lora_packet_{};
  std::array<std::uint8_t, 64> wifi_packet_{};
  std::array<std::uint8_t, 4> state_{};
};

static_assert(device::is_complete_role<ScriptSiren>, "a role must override every Role method");

}  // namespace hsn::test
