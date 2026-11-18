#pragma once

#include <array>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "hsn/device/device.hpp"
#include "hsn/device/events.hpp"
#include "hsn/device/hal/waiter.hpp"
#include "hsn/device/runner.hpp"
#include "hsn/device/services.hpp"
#include "hsn/device/time.hpp"
#include "hsn/host/drift_clock.hpp"
#include "hsn/host/host_board.hpp"
#include "hsn/host/link_wire.hpp"
#include "hsn/host/medium.hpp"
#include "hsn/host/radio_bridge.hpp"
#include "hsn/host/role_box.hpp"
#include "hsn/host/scheduler.hpp"
#include "hsn/host/simulation_error.hpp"
#include "hsn/host/timeline.hpp"

namespace hsn::host {

/**
 * What a board runs when it boots an image of one version (m3-updates-design.md section 8): a test
 * maps versions to roles, so an update can bring a good role, one that never confirms, one that
 * cannot open packets, or one that hangs.
 */
struct ImageRole {
  protocol::FirmwareVersion version;
  /** Built on every boot of that image; empty for none (setup-only mode). */
  RoleFactory role;
  /**
   * The image hangs: the first event this long or more after its boot never returns from
   * handle(), so the task watchdog resets the chip (SimDevice::hang). Empty: it does not hang.
   */
  std::optional<device::Duration> hangs_after;
};

/** One device in a Simulation. */
struct DeviceSpec {
  /** Unique in the simulation; names it on the timeline. */
  std::string name;
  /** Builds the role on every boot; empty for a board with no role (setup-only mode). */
  RoleFactory role;
  /** How fast this board's RTC runs, in parts per million (positive: fast). */
  std::int32_t drift_ppm = 0;
  /** True instant the board first gets power. */
  device::Instant power_on;
  /** From power, reset or deep-sleep wake to the boot event (the worked example's 0.05 s). */
  device::Duration boot_time = device::milliseconds(50);
  /**
   * The role per booted image's version; an image whose version is not listed runs `role`. With
   * none listed, every image runs `role`.
   */
  std::vector<ImageRole> images;
  /** How long the board stays off after a power cut the PowerCut made, before power returns. */
  device::Duration off_after_cut = device::seconds(1);
};

/** What the Simulation shares with its devices. */
struct SimContext {
  Scheduler& scheduler;
  Timeline& timeline;
  const PacketLabels& labels;
  Medium& medium;
  /** Hardware calls allowed per handle() (design section 6). */
  std::uint32_t call_budget;
  /** Keep the fakes' own call records; off for long runs, which then rely on the timeline. */
  bool keep_fake_records;
};

/** Where a simulated device is in its life. */
enum class PowerState : std::uint8_t {
  /** No power. */
  off,
  /** Power, a reset or a wake came; the boot event follows after the boot time. */
  booting,
  /** Booted: waiting awake or in light sleep, taking events. */
  running,
  /** In deep sleep: RAM gone; the timer or a wake input boots it again. */
  deep_sleep,
};

/**
 * One simulated board and the device objects of its current boot (design section 8, "one board,
 * many boots"). The board (flash, retained memory, fakes) lives as long as the simulation; the
 * Services, role, Device and Runner live for one boot and are rebuilt on every reset and deep-sleep
 * wake, so RAM is lost and the retained block and flash are kept. The board's clock runs at its
 * own drift; before every call into the core the Simulation sets the FakeClock to the board's
 * reading of true time.
 *
 * The Simulation drives it: every Runner::plan() becomes a future wake on the scheduler, an
 * event is delivered at the earliest of that wake and the board's hardware events, and every
 * handle() is held to the hardware-call budget. Tests script its inputs and power here.
 */
class SimDevice {
public:
  /** A board seeded with `seed`, powered on at spec.power_on. Built by Simulation::add_device. */
  SimDevice(const SimContext& context, DeviceSpec spec, std::uint64_t seed);
  SimDevice(const SimDevice&) = delete;
  SimDevice& operator=(const SimDevice&) = delete;
  ~SimDevice();

  /** The device's name, unique in its simulation. */
  const std::string& name() const {
    return spec_.name;
  }

  /** What the device was added with. */
  const DeviceSpec& spec() const {
    return spec_;
  }

  /** This device on the timeline. */
  ActorId actor() const {
    return actor_;
  }

  /** The board: fakes, flash and retained memory, for test setup and inspection. */
  HostBoard& board() {
    return board_;
  }

  /** The board's RTC against true time. */
  const DriftClock& clock() const {
    return clock_;
  }

  /** The board's RTC reading now. */
  device::Instant local_now() const;

  /** Where the device is in its life. */
  PowerState state() const {
    return state_;
  }

  /** True while booted and not in deep sleep. */
  bool running() const {
    return state_ == PowerState::running;
  }

  /** Boot events delivered so far. */
  std::uint32_t boots() const {
    return boots_;
  }

  /** The last wait the Runner planned. */
  const device::WaitRequest& last_wait() const {
    return last_wait_;
  }

  /** This boot's services, or null when not running. */
  device::Services* services();

  /** This boot's Device, or null when not running. */
  device::Device* core_device();

  /**
   * This boot's role as its concrete type. Throws SimulationError when not running, when there
   * is no role, or when it is not an R.
   */
  template <typename R>
  R& role() {
    if (boot_ == nullptr || boot_->role == nullptr ||
        boot_->role->type_tag() != role_type_tag<R>()) {
      throw SimulationError(spec_.name + " has no running role of that type");
    }
    return static_cast<RoleBoxOf<R>&>(*boot_->role).get();
  }

  /** The wire of one of the board's links. */
  LinkWire& wire(device::LinkKind kind);

  /** The board's radio on the medium. */
  StationId station() const {
    return radio_.station();
  }

  /** This device's records on the timeline. */
  Selection records() const;

  /**
   * Sets an input's level at a true instant: the door (open is active), the cover, the button
   * (pressed) or external power (present). A running device gets an input event; one in deep
   * sleep wakes when the input is among its wake inputs; otherwise only the level changes.
   */
  void set_input(device::Input input, bool active, device::Instant when);

  /** Presses the button at `from` and releases it at `to`. */
  void hold_button(device::Instant from, device::Instant to);

  /** Cuts the power at `when` for `off_for`: RAM and retained memory are lost, flash kept. */
  void power_loss(device::Instant when, device::Duration off_for = device::seconds(1));

  /** Resets the chip at `when` (a software restart): RAM is lost, retained memory kept. */
  void restart(device::Instant when);

  /**
   * The running image hangs at `when`: the first event at or after it never returns from handle()
   * (nothing more is delivered or fed), and the task watchdog resets the chip its timeout after
   * the last feed, with BootInfo::watchdog_reset (reset cause 6, the task watchdog).
   */
  void hang(device::Instant when);

  /** Power cuts the board's PowerCut made so far (each one a power loss on the timeline). */
  std::uint32_t power_cuts() const {
    return power_cuts_;
  }

  /** What the fake bootloader chose at the latest boot. */
  const BootChoice& boot_choice() const {
    return boot_choice_;
  }

private:
  /** The device objects of one boot. */
  struct Boot {
    Boot(HostBoard& board, const RoleFactory& factory);
    device::Services services;
    std::unique_ptr<RoleBox> role;
    device::Device device;
    device::Runner runner;
  };

  /** What a handle() may have changed on the board, to put on the timeline afterwards. */
  struct Seen {
    std::size_t storage = 0;
    std::size_t slot_operations = 0;
    std::size_t sounds = 0;
    std::size_t sensor_blinks = 0;
    std::size_t outputs = 0;
    std::size_t siren_blinks = 0;
    std::size_t gateway_blinks = 0;
    std::array<std::uint8_t, device::kRetainedBlockSize> retained{};
  };

  void power_up();
  void start_boot(device::BootKind kind, device::WakeMask woke_by, std::uint8_t reset_cause,
                  bool watchdog = false);
  /** The board's PowerCut cut the power: the board goes off, and comes back after a while. */
  void power_cut();
  /** True (and the cut carried out) when the power was cut during the call just made. */
  bool take_cut();
  /** The role factory for the image this boot runs. */
  const RoleFactory& role_for(const protocol::FirmwareVersion& version) const;
  /** A hang begins instead of the event about to be delivered, when one is due. */
  bool hang_now();
  void boot(device::BootInfo info);
  void go_down(bool finish_sending = false);
  void enter_deep_sleep(const device::WaitRequest& request);
  void plan();
  void deliver(const device::Event& event, const char* what);
  void timer(std::uint64_t generation);
  bool deliver_hardware(const std::function<device::Event(device::Instant)>& build,
                        const char* what);
  void apply_input(device::Input input, bool active);
  template <typename Call>
  void metered(const char* what, Call call);
  Seen snapshot() const;
  void transcribe(const Seen& before, const Seen* until = nullptr);
  void trim_to(const Seen& seen);
  void trim_fake_records();
  Record record(RecordKind kind) const;

  SimContext context_;
  DeviceSpec spec_;
  ActorId actor_;
  HostBoard board_;
  DriftClock clock_;
  RadioBridge radio_;
  LinkWire usb_;
  LinkWire network_;
  LinkWire bluetooth_;
  std::unique_ptr<Boot> boot_;
  PowerState state_ = PowerState::off;
  /** Bumped on every change of state; scheduled actions of an older one do nothing. */
  std::uint64_t epoch_ = 0;
  /** Bumped on every plan; a wake of an older plan does nothing. */
  std::uint64_t wake_generation_ = 0;
  device::WaitRequest last_wait_;
  device::WakeMask deep_wake_inputs_;
  std::uint32_t boots_ = 0;
  std::uint32_t power_losses_ = 0;
  bool waited_ = false;
  /** A cut fell during the current call; what had happened by then. */
  bool cut_pending_ = false;
  Seen cut_seen_;
  std::uint32_t power_cuts_ = 0;
  BootChoice boot_choice_;
  /** A hang: when it is due, whether it has begun, and the last feed's true time. */
  device::Instant hang_at_ = device::Instant::never();
  bool hung_ = false;
  device::Instant last_fed_;
};

}  // namespace hsn::host
