#include "hsn/host/sim_device.hpp"

#include <utility>

#include "hsn/host/provisioning.hpp"
#include "hsn/host/sim_time.hpp"

namespace hsn::host {
namespace {

/** ESP-IDF reset reasons the platform reports in BootInfo (esp_reset_reason_t). */
constexpr std::uint8_t kResetPowerOn = 1;
constexpr std::uint8_t kResetSoftware = 3;
constexpr std::uint8_t kResetDeepSleep = 8;

std::uint32_t changed_bytes(const std::array<std::uint8_t, device::kRetainedBlockSize>& a,
                            const std::array<std::uint8_t, device::kRetainedBlockSize>& b) {
  std::uint32_t changed = 0;
  for (std::size_t i = 0; i < a.size(); ++i) {
    changed += a[i] != b[i] ? 1u : 0u;
  }
  return changed;
}

}  // namespace

SimDevice::Boot::Boot(HostBoard& board, const RoleFactory& factory)
    : services(board.hal()),
      role(factory ? factory(services, board) : nullptr),
      device(services, role != nullptr ? &role->role() : nullptr),
      runner(device, board.watchdog) {}

SimDevice::SimDevice(const SimContext& context, DeviceSpec spec, std::uint64_t seed)
    : context_(context),
      spec_(std::move(spec)),
      actor_(context.timeline.add_actor(spec_.name)),
      board_(seed),
      clock_(spec_.drift_ppm),
      radio_(board_.radio, context.medium, actor_,
             [this](const RadioBridge::Build& build) {
               deliver_hardware(
                   [&build](device::Instant local) {
                     return device::Event::from_radio(local, build(local));
                   },
                   "radio");
             }),
      usb_(context.scheduler, context.timeline, context.labels, actor_, board_.usb,
           [this](const LinkWire::Build& build) {
             return deliver_hardware(
                 [&build](device::Instant local) {
                   return device::Event::from_link(local, build());
                 },
                 "link");
           }),
      network_(context.scheduler, context.timeline, context.labels, actor_, board_.network,
               [this](const LinkWire::Build& build) {
                 return deliver_hardware(
                     [&build](device::Instant local) {
                       return device::Event::from_link(local, build());
                     },
                     "link");
               }) {
  const std::uint64_t epoch = epoch_;
  context_.scheduler.schedule(spec_.power_on, [this, epoch]() {
    if (epoch == epoch_) {
      power_up();
    }
  });
}

SimDevice::~SimDevice() = default;

device::Instant SimDevice::local_now() const {
  return clock_.local(context_.scheduler.now());
}

device::Services* SimDevice::services() {
  return running() && boot_ != nullptr ? &boot_->services : nullptr;
}

device::Device* SimDevice::core_device() {
  return running() && boot_ != nullptr ? &boot_->device : nullptr;
}

LinkWire& SimDevice::wire(device::LinkKind kind) {
  return kind == device::LinkKind::usb ? usb_ : network_;
}

Selection SimDevice::records() const {
  return context_.timeline.of(actor_);
}

Record SimDevice::record(RecordKind kind) const {
  Record entry;
  entry.at = context_.scheduler.now();
  entry.actor = actor_;
  entry.kind = kind;
  return entry;
}

void SimDevice::power_up() {
  clock_.start(context_.scheduler.now(), device::Instant{});
  context_.timeline.add(record(RecordKind::power_on));
  start_boot(device::BootKind::power_on, device::WakeMask(), kResetPowerOn);
}

void SimDevice::start_boot(device::BootKind kind, device::WakeMask woke_by,
                           std::uint8_t reset_cause) {
  state_ = PowerState::booting;
  epoch_ += 1;
  const std::uint64_t epoch = epoch_;
  device::BootInfo info;
  info.kind = kind;
  info.woke_by = woke_by;
  info.reset_cause = reset_cause;
  context_.scheduler.schedule(context_.scheduler.now() + spec_.boot_time, [this, epoch, info]() {
    if (epoch == epoch_) {
      boot(info);
    }
  });
}

void SimDevice::boot(device::BootInfo info) {
  state_ = PowerState::running;
  epoch_ += 1;
  boots_ += 1;
  waited_ = false;
  const device::Instant local = local_now();
  board_.clock.set(local);
  static_cast<void>(import_stored_key(board_));
  boot_ = std::make_unique<Boot>(board_, spec_.role);
  Record entry = record(RecordKind::boot);
  entry.value = static_cast<std::uint32_t>(info.kind);
  entry.flag = info.woke_by.has_timer();
  entry.rssi_dbm = info.reset_cause;
  context_.timeline.add(entry);
  metered("boot", [&]() { boot_->runner.start(device::Event::booted(local, info)); });
}

void SimDevice::go_down() {
  board_.clock.set(local_now());
  // Every path that stops the chip resets its pins: the sounder output goes low.
  if (board_.siren_io.drive_low_on_reset()) {
    Record entry = record(RecordKind::output);
    entry.flag = false;
    context_.timeline.add(entry);
  }
  radio_.quiesce();
  usb_.device_reset();
  network_.device_reset();
  boot_.reset();
  wake_generation_ += 1;
}

void SimDevice::enter_deep_sleep(const device::WaitRequest& request) {
  Record entry = record(RecordKind::deep_sleep);
  entry.until = clock_.true_time(request.until);
  entry.value = request.deep_wake_inputs.bits();
  context_.timeline.add(entry);
  go_down();
  state_ = PowerState::deep_sleep;
  epoch_ += 1;
  deep_wake_inputs_ = request.deep_wake_inputs;
  if (!request.until.is_never()) {
    const std::uint64_t epoch = epoch_;
    context_.scheduler.schedule(entry.until, [this, epoch]() {
      if (epoch == epoch_) {
        start_boot(device::BootKind::deep_sleep_wake, device::WakeMask::timer(), kResetDeepSleep);
      }
    });
  }
}

void SimDevice::plan() {
  if (state_ != PowerState::running || boot_ == nullptr) {
    return;
  }
  const device::Instant local = local_now();
  board_.clock.set(local);
  const Seen before = snapshot();
  const device::WaitRequest request = boot_->runner.plan(local);
  // plan() may store a fatal error (a busy loop): that flash write belongs on the timeline too.
  transcribe(before);
  const bool depth_changed = !waited_ || last_wait_.depth != request.depth;
  last_wait_ = request;
  if (request.restart) {
    context_.timeline.add(record(RecordKind::restart));
    go_down();
    start_boot(device::BootKind::other_reset, device::WakeMask(), kResetSoftware);
    return;
  }
  if (request.depth == device::SleepDepth::deep) {
    enter_deep_sleep(request);
    return;
  }
  if (depth_changed) {
    Record entry = record(RecordKind::wait);
    entry.value = static_cast<std::uint32_t>(request.depth);
    context_.timeline.add(entry);
  }
  waited_ = true;
  wake_generation_ += 1;
  const std::uint64_t generation = wake_generation_;
  context_.scheduler.schedule(clock_.true_time(request.until),
                              [this, generation]() { timer(generation); });
}

void SimDevice::timer(std::uint64_t generation) {
  if (generation != wake_generation_ || state_ != PowerState::running) {
    return;
  }
  const device::Instant local = local_now();
  board_.clock.set(local);
  metered("timer", [&]() { boot_->runner.timed_out(local); });
}

void SimDevice::deliver(const device::Event& event, const char* what) {
  metered(what, [&]() { boot_->runner.deliver(event); });
}

bool SimDevice::deliver_hardware(const std::function<device::Event(device::Instant)>& build,
                                 const char* what) {
  if (state_ != PowerState::running || boot_ == nullptr) {
    return false;
  }
  const device::Instant local = local_now();
  board_.clock.set(local);
  deliver(build(local), what);
  return true;
}

template <typename Call>
void SimDevice::metered(const char* what, Call call) {
  board_.calls.reset();
  const Seen before = snapshot();
  call();
  const std::uint64_t calls = board_.calls.calls();
  transcribe(before);
  if (calls > context_.call_budget) {
    throw SimulationError(spec_.name + ": " + std::to_string(calls) +
                          " hardware calls in one handle() of a " + what + " event at " +
                          format_instant(context_.scheduler.now()) + " s; the budget is " +
                          std::to_string(context_.call_budget) + " (design section 6)");
  }
  if (!context_.keep_fake_records) {
    trim_fake_records();
  }
  plan();
}

SimDevice::Seen SimDevice::snapshot() const {
  Seen seen;
  seen.storage = board_.storage.operations.size();
  seen.sounds = board_.sensor_io.sounds.size();
  seen.sensor_blinks = board_.sensor_io.blinks.size();
  seen.outputs = board_.siren_io.outputs.size();
  seen.siren_blinks = board_.siren_io.blinks.size();
  seen.gateway_blinks = board_.gateway_io.blinks.size();
  seen.retained = board_.retained.contents();
  return seen;
}

void SimDevice::transcribe(const Seen& before) {
  for (std::size_t i = before.storage; i < board_.storage.operations.size(); ++i) {
    const FakeStorage::Operation& operation = board_.storage.operations[i];
    Record entry =
        record(operation.kind == FakeStorage::Operation::Kind::write ? RecordKind::flash_write
                                                                     : RecordKind::flash_erase);
    entry.value = operation.kind == FakeStorage::Operation::Kind::erase_all_but_role
                      ? 0xFFu
                      : static_cast<std::uint32_t>(operation.key);
    entry.length = static_cast<std::uint16_t>(operation.value.size());
    entry.flag = operation.failed;
    context_.timeline.add(entry);
  }
  for (std::size_t i = before.sounds; i < board_.sensor_io.sounds.size(); ++i) {
    Record entry = record(RecordKind::buzzer);
    entry.value = static_cast<std::uint32_t>(board_.sensor_io.sounds[i].value);
    context_.timeline.add(entry);
  }
  const auto blinks = [&](const std::vector<Change<device::Blink>>& changes, std::size_t from) {
    for (std::size_t i = from; i < changes.size(); ++i) {
      Record entry = record(RecordKind::led);
      entry.value = static_cast<std::uint32_t>(changes[i].value);
      context_.timeline.add(entry);
    }
  };
  blinks(board_.sensor_io.blinks, before.sensor_blinks);
  blinks(board_.siren_io.blinks, before.siren_blinks);
  blinks(board_.gateway_io.blinks, before.gateway_blinks);
  for (std::size_t i = before.outputs; i < board_.siren_io.outputs.size(); ++i) {
    Record entry = record(RecordKind::output);
    entry.flag = board_.siren_io.outputs[i].value;
    context_.timeline.add(entry);
  }
  const std::uint32_t changed = changed_bytes(before.retained, board_.retained.contents());
  if (changed > 0) {
    Record entry = record(RecordKind::retained_write);
    entry.value = changed;
    context_.timeline.add(entry);
  }
}

void SimDevice::trim_fake_records() {
  board_.radio.calls.clear();
  board_.storage.operations.clear();
  board_.usb.sent.clear();
  board_.network.sent.clear();
  board_.sensor_io.sounds.clear();
  board_.sensor_io.blinks.clear();
  board_.siren_io.outputs.clear();
  board_.siren_io.blinks.clear();
  board_.gateway_io.blinks.clear();
  board_.watchdog.feeds.clear();
}

void SimDevice::apply_input(device::Input input, bool active) {
  switch (input) {
    case device::Input::door:
      board_.sensor_io.door = active;
      break;
    case device::Input::cover:
      board_.sensor_io.cover = active;
      board_.siren_io.cover = active;
      break;
    case device::Input::button:
      board_.sensor_io.button = active;
      break;
    case device::Input::external_power:
      board_.power.external = active;
      break;
  }
  Record entry = record(RecordKind::input);
  entry.value = static_cast<std::uint32_t>(input);
  entry.flag = active;
  context_.timeline.add(entry);
  if (state_ == PowerState::running) {
    deliver_hardware(
        [input, active](device::Instant local) {
          device::InputEvent changed;
          changed.input = input;
          changed.active = active;
          changed.at = local;
          return device::Event::from_input(local, changed);
        },
        "input");
  } else if (state_ == PowerState::deep_sleep && deep_wake_inputs_.has(input)) {
    start_boot(device::BootKind::deep_sleep_wake, device::WakeMask::of(input), kResetDeepSleep);
  }
}

void SimDevice::set_input(device::Input input, bool active, device::Instant when) {
  context_.scheduler.schedule(when, [this, input, active]() { apply_input(input, active); });
}

void SimDevice::hold_button(device::Instant from, device::Instant to) {
  set_input(device::Input::button, true, from);
  set_input(device::Input::button, false, to);
}

void SimDevice::power_loss(device::Instant when, device::Duration off_for) {
  context_.scheduler.schedule(when, [this, off_for]() {
    if (state_ == PowerState::off) {
      return;
    }
    context_.timeline.add(record(RecordKind::power_loss));
    go_down();
    state_ = PowerState::off;
    epoch_ += 1;
    power_losses_ += 1;
    board_.power_loss(0x9E3779B9u + power_losses_);
    const std::uint64_t epoch = epoch_;
    context_.scheduler.schedule(context_.scheduler.now() + off_for, [this, epoch]() {
      if (epoch == epoch_) {
        power_up();
      }
    });
  });
}

void SimDevice::restart(device::Instant when) {
  context_.scheduler.schedule(when, [this]() {
    if (state_ == PowerState::off) {
      return;
    }
    context_.timeline.add(record(RecordKind::restart));
    go_down();
    start_boot(device::BootKind::other_reset, device::WakeMask(), kResetSoftware);
  });
}

}  // namespace hsn::host
