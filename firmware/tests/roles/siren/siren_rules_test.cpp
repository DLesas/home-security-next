// The core's rules as they apply to the siren (FW4, SR1, SR8, design sections 5 and 6): never
// deeper than awake, the watchdog fed across idle waits, the hardware-call budget at a busy
// moment, the state in the retained block, and pairing as every device is paired.

#include "siren_bench.hpp"
#include "siren_support.hpp"

namespace hsn::test::siren {
namespace {

using device::Input;
using device::SleepDepth;

TEST_CASE("FW4 SR1: the siren never sleeps deeper than awake, and the watchdog is fed") {
  SirenSite site;
  site.command_at(seconds(60), action::test, 10);
  site.run_until(seconds(15 * 60));
  CHECK(site.siren.records().kind(RecordKind::deep_sleep).empty());
  for (const host::Record& wait : site.siren.records().kind(RecordKind::wait).records()) {
    CHECK(wait.value == static_cast<std::uint32_t>(SleepDepth::awake));
  }
  CHECK(site.siren.last_wait().depth == SleepDepth::awake);
  // Fed at least every 2 s across 15 minutes of mostly idle waiting (design section 6).
  const host::FakeWatchdog& watchdog = site.siren.board().watchdog;
  CHECK(watchdog.longest_gap(site.siren.local_now()) <= seconds(2));
  CHECK_FALSE(watchdog.would_have_fired(site.siren.local_now()));
  CHECK(site.role().longest_awake() == device::Duration{});
}

TEST_CASE("design §6: the busiest moment stays inside 32 hardware calls") {
  host::SirenConfig config;
  config.wifi_report_interval_seconds = 15;
  config.lora_check_interval_units = 1;  // every 15 s, with the reports
  SirenSite site({}, config);
  // A command, a cover change and a mains change on top of a report and a check.
  site.command_at(seconds(60) + milliseconds(125), action::sound_alarm, 30);
  site.siren.set_input(Input::cover, true, at(seconds(60) + milliseconds(150)));
  site.siren.set_input(Input::external_power, true, at(seconds(60) + milliseconds(150)));
  site.siren.board().siren_io.cell = true;
  // The simulation throws out of run_until past 32 calls in one handle().
  CHECK_NOTHROW(site.run_until(seconds(120)));
}

TEST_CASE("design §5: the state fits the retained block and goes through it") {
  CHECK(sizeof(roles::siren::SirenState) <= device::kMaxRoleStateSize);
  Bench bench;
  bench.boot(BootKind::power_on, at_seconds(1));
  CHECK(bench.instance->role.state_layout() == roles::siren::kSirenStateLayout);
  CHECK(bench.instance->role.state_bytes().size() == sizeof(roles::siren::SirenState));
  bench.link_up(at_seconds(2));
  bench.wifi_packet(Bench::sound(60, 5), at_seconds(10));
  // state_id: the output in bits 0–1, the Wi-Fi path in bits 2–3.
  CHECK(bench.instance->role.state_id() ==
        (protocol::SirenState::sounding_alarm |
         (static_cast<unsigned>(roles::siren::WifiPath::up) << 2)));
  bench.boot(BootKind::other_reset, at_seconds(20));
  CHECK(bench.instance->device.retained_status() == device::RetainedStatus::intact);
  CHECK(bench.state().output_state == protocol::SirenState::sounding_alarm);
}

TEST_CASE("SR8 §4: a paired siren starts its counter one step in; an unpaired board does not run") {
  SirenSite site;
  site.run_until(seconds(1));
  const auto started = site.hub.received_from("siren", type::started);
  REQUIRE(started.size() == 1);
  CHECK(started[0].counter == 1024);
  // An unpaired board stays in setup-only mode and never touches the output.
  host::HostBoard board;
  host::HostInstance<SirenRole> instance(board, board.siren_io);
  instance.runner.start(board.boot_event(BootKind::power_on));
  CHECK(instance.device.setup_only());
  CHECK(board.siren_io.outputs.empty());
  CHECK(board.network.connects == 0);
}

}  // namespace
}  // namespace hsn::test::siren
