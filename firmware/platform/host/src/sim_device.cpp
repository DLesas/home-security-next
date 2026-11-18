#include "hsn/host/sim_device.hpp"

#include <utility>

#include "hsn/host/provisioning.hpp"
#include "hsn/host/sim_time.hpp"

namespace hsn::host {
namespace {

/** ESP-IDF reset reasons the platform reports in BootInfo (esp_reset_reason_t). */
constexpr std::uint8_t kResetPowerOn = 1;
constexpr std::uint8_t kResetSoftware = 3;
constexpr std::uint8_t kResetTaskWatchdog = 6;
constexpr std::uint8_t kResetDeepSleep = 8;

/** The task watchdog's timeout when the core has not started it (design section 6, W). */
constexpr device::Duration kWatchdogTimeout = device::seconds(5);

bool same_version(const protocol::FirmwareVersion& a, const protocol::FirmwareVersion& b) {
  return a.major == b.major && a.minor == b.minor && a.patch == b.patch;
}

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
               }),
      bluetooth_(context.scheduler, context.timeline, context.labels, actor_, board_.bluetooth,
                 [this](const LinkWire::Build& build) {
                   return deliver_hardware(
                       [&build](device::Instant local) {
                         return device::Event::from_link(local, build());
                       },
                       "link");
                 }) {
  board_.power_cut.on_cut = [this]() {
    cut_pending_ = true;
    cut_seen_ = snapshot();
  };
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
  switch (kind) {
    case device::LinkKind::usb:
      return usb_;
    case device::LinkKind::network:
      return network_;
    case device::LinkKind::bluetooth:
      return bluetooth_;
  }
  throw SimulationError(spec_.name + ": no such link");
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
  board_.power_cut.restore();
  clock_.start(context_.scheduler.now(), device::Instant{});
  context_.timeline.add(record(RecordKind::power_on));
  start_boot(device::BootKind::power_on, device::WakeMask(), kResetPowerOn);
}

void SimDevice::start_boot(device::BootKind kind, device::WakeMask woke_by,
                           std::uint8_t reset_cause, bool watchdog) {
  state_ = PowerState::booting;
  epoch_ += 1;
  const std::uint64_t epoch = epoch_;
  device::BootInfo info;
  info.kind = kind;
  info.woke_by = woke_by;
  info.reset_cause = reset_cause;
  info.watchdog_reset = watchdog;
  context_.scheduler.schedule(context_.scheduler.now() + spec_.boot_time, [this, epoch, info]() {
    if (epoch == epoch_) {
      boot(info);
    }
  });
}

const RoleFactory& SimDevice::role_for(const protocol::FirmwareVersion& version) const {
  for (const ImageRole& image : spec_.images) {
    if (same_version(image.version, version)) {
      return image.role;
    }
  }
  return spec_.role;
}

void SimDevice::boot(device::BootInfo info) {
  const device::Instant local = local_now();
  board_.clock.set(local);
  // Every reset goes through the bootloader (m3-updates-design.md section 2), which chooses the
  // slot and may write otadata: a power cut can fall there too.
  const Seen before = snapshot();
  boot_choice_ = board_.run_bootloader();
  transcribe(before);
  if (take_cut()) {
    return;
  }
  if (!boot_choice_.bootable) {
    throw SimulationError(spec_.name + ": neither slot holds an image that passes its check, at " +
                          format_instant(context_.scheduler.now()) + " s");
  }
  state_ = PowerState::running;
  epoch_ += 1;
  boots_ += 1;
  waited_ = false;
  hung_ = false;
  hang_at_ = device::Instant::never();
  last_fed_ = context_.scheduler.now();
  for (const ImageRole& image : spec_.images) {
    if (same_version(image.version, boot_choice_.image.version) && image.hangs_after) {
      hang_at_ = context_.scheduler.now() + *image.hangs_after;
    }
  }
  static_cast<void>(import_stored_key(board_));
  boot_ = std::make_unique<Boot>(board_, role_for(boot_choice_.image.version));
  Record entry = record(RecordKind::boot);
  entry.value = static_cast<std::uint32_t>(info.kind);
  entry.flag = info.woke_by.has_timer();
  entry.rssi_dbm = info.reset_cause;
  context_.timeline.add(entry);
  metered("boot", [&]() { boot_->runner.start(device::Event::booted(local, info)); });
}

void SimDevice::go_down(bool finish_sending) {
  board_.clock.set(local_now());
  // Every path that stops the chip resets its pins: the sounder output goes low.
  if (board_.siren_io.drive_low_on_reset()) {
    Record entry = record(RecordKind::output);
    entry.flag = false;
    context_.timeline.add(entry);
  }
  radio_.quiesce();
  usb_.device_reset(finish_sending);
  network_.device_reset(finish_sending);
  bluetooth_.device_reset(finish_sending);
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
  if (cut_pending_) {
    trim_to(cut_seen_);
    transcribe(before, &cut_seen_);
    static_cast<void>(take_cut());
    return;
  }
  transcribe(before);
  const bool depth_changed = !waited_ || last_wait_.depth != request.depth;
  last_wait_ = request;
  if (request.restart) {
    // Asked for through the waiter: the links finish sending what they were given first.
    context_.timeline.add(record(RecordKind::restart));
    go_down(true);
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
  if (generation != wake_generation_ || state_ != PowerState::running || hang_now()) {
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
  if (state_ != PowerState::running || boot_ == nullptr || hang_now()) {
    return false;
  }
  const device::Instant local = local_now();
  board_.clock.set(local);
  deliver(build(local), what);
  return true;
}

bool SimDevice::hang_now() {
  if (hung_) {
    return true;
  }
  if (context_.scheduler.now() < hang_at_) {
    return false;
  }
  // This event's handle() never returns: nothing is fed, and the task watchdog fires its timeout
  // after the last feed (design section 6).
  hung_ = true;
  wake_generation_ += 1;
  const device::Duration timeout = board_.watchdog.timeout_ms > 0
                                       ? device::milliseconds(board_.watchdog.timeout_ms)
                                       : kWatchdogTimeout;
  const device::Instant fires = std::max(context_.scheduler.now(), last_fed_ + timeout);
  const std::uint64_t epoch = epoch_;
  context_.scheduler.schedule(fires, [this, epoch]() {
    if (epoch != epoch_) {
      return;
    }
    Record entry = record(RecordKind::restart);
    entry.flag = true;
    context_.timeline.add(entry);
    go_down();
    start_boot(device::BootKind::other_reset, device::WakeMask(), kResetTaskWatchdog, true);
  });
  return true;
}

template <typename Call>
void SimDevice::metered(const char* what, Call call) {
  board_.calls.reset();
  const Seen before = snapshot();
  call();
  const std::uint64_t calls = board_.calls.calls();
  last_fed_ = context_.scheduler.now();
  if (cut_pending_) {
    // The power went during this handle(): what it did after the cut never happened.
    trim_to(cut_seen_);
    transcribe(before, &cut_seen_);
    static_cast<void>(take_cut());
    return;
  }
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
  seen.slot_operations = board_.slots.operations.size();
  seen.sounds = board_.sensor_io.sounds.size();
  seen.sensor_blinks = board_.sensor_io.blinks.size();
  seen.outputs = board_.siren_io.outputs.size();
  seen.siren_blinks = board_.siren_io.blinks.size();
  seen.gateway_blinks = board_.gateway_io.blinks.size();
  seen.retained = board_.retained.contents();
  return seen;
}

bool SimDevice::take_cut() {
  if (!cut_pending_) {
    return false;
  }
  cut_pending_ = false;
  power_cut();
  return true;
}

void SimDevice::power_cut() {
  Record entry = record(RecordKind::power_loss);
  // A cut the PowerCut made: flag set, value the operation it fell on.
  entry.flag = true;
  entry.value = static_cast<std::uint32_t>(board_.power_cut.cut_at().number);
  context_.timeline.add(entry);
  go_down();
  state_ = PowerState::off;
  epoch_ += 1;
  power_losses_ += 1;
  power_cuts_ += 1;
  board_.power_loss(0x9E3779B9u + power_losses_);
  const std::uint64_t epoch = epoch_;
  context_.scheduler.schedule(context_.scheduler.now() + spec_.off_after_cut, [this, epoch]() {
    if (epoch == epoch_) {
      power_up();
    }
  });
}

void SimDevice::trim_to(const Seen& seen) {
  board_.sensor_io.sounds.resize(std::min(board_.sensor_io.sounds.size(), seen.sounds));
  board_.sensor_io.blinks.resize(std::min(board_.sensor_io.blinks.size(), seen.sensor_blinks));
  board_.siren_io.outputs.resize(std::min(board_.siren_io.outputs.size(), seen.outputs));
  board_.siren_io.blinks.resize(std::min(board_.siren_io.blinks.size(), seen.siren_blinks));
  board_.gateway_io.blinks.resize(std::min(board_.gateway_io.blinks.size(), seen.gateway_blinks));
}

void SimDevice::transcribe(const Seen& before, const Seen* until) {
  // After a cut, trim_to() has already dropped what the inputs and outputs recorded past it;
  // storage and the slots record nothing past it. The retained block is compared as it was then.
  for (std::size_t i = before.slot_operations; i < board_.slots.operations.size(); ++i) {
    const FakeFirmwareSlots::Operation& operation = board_.slots.operations[i];
    using Kind = FakeFirmwareSlots::Operation::Kind;
    if (operation.kind != Kind::erase && operation.kind != Kind::write && operation.length == 0) {
      continue;  // a select, confirm or reject that wrote nothing
    }
    Record entry = record(operation.kind == Kind::erase   ? RecordKind::slot_erase
                          : operation.kind == Kind::write ? RecordKind::slot_write
                                                          : RecordKind::otadata_write);
    entry.value = operation.kind == Kind::erase || operation.kind == Kind::write ? operation.offset
                                                                                 : operation.state;
    entry.length = static_cast<std::uint16_t>(
        operation.kind == Kind::erase || operation.kind == Kind::write ? operation.length
                                                                       : operation.offset);
    entry.flag = operation.result != device::HalError::none;
    context_.timeline.add(entry);
  }
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
  const std::uint32_t changed = changed_bytes(
      before.retained, until != nullptr ? until->retained : board_.retained.contents());
  if (changed > 0) {
    Record entry = record(RecordKind::retained_write);
    entry.value = changed;
    context_.timeline.add(entry);
  }
}

void SimDevice::trim_fake_records() {
  board_.radio.calls.clear();
  board_.storage.operations.clear();
  board_.slots.operations.clear();
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

void SimDevice::hang(device::Instant when) {
  context_.scheduler.schedule(when, [this]() {
    if (state_ == PowerState::running && !hung_) {
      hang_at_ = context_.scheduler.now();
    }
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
