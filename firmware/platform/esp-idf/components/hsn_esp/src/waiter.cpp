#include "hsn/esp/waiter.hpp"

#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_sleep.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "hsn/device/runner.hpp"
#include "hsn/esp/board.hpp"

namespace hsn::esp {
namespace {

constexpr const char* kTag = "hsn.waiter";
/** The most the links may take to finish sending before a restart (design section 3). */
constexpr std::uint32_t kRestartGraceMs = 200;
/** Closing the WebSocket and stopping Wi-Fi before a deep sleep ‡. */
constexpr std::uint32_t kShutDownMs = 500;

void on_alarm(void* queue) {
  Message message;
  message.kind = MessageKind::deadline;
  static_cast<void>(static_cast<EventQueue*>(queue)->post(message));
}

gpio_num_t dio1() {
  return static_cast<gpio_num_t>(kBoard.radio_dio1);
}

/**
 * The console's view of each event, for the bench: link and input changes at info (they are
 * rare), radio events and packets at debug, which the default build compiles out
 * (CONFIG_LOG_MAXIMUM_LEVEL; docs/spikes/M1b-platform-layer.md says how to turn it on). Never a
 * packet's bytes: only sizes, times and levels.
 */
void describe(const device::Event& event) {
  static constexpr const char* kRadio[] = {"tx_done",     "rx_done",  "rx_timeout", "rx_crc_error",
                                           "header_seen", "cad_done", "fault"};
  static constexpr const char* kLinks[] = {"usb", "network", "bluetooth"};
  static constexpr const char* kInputs[] = {"door", "cover", "button", "external_power"};
  switch (event.kind) {
    case device::EventKind::radio: {
      const device::RadioEvent& radio = event.radio;
      const auto kind = static_cast<std::size_t>(radio.kind);
      ESP_LOGD(kTag, "radio %s at %llu us, %u bytes, rssi %d dBm, snr %d/4 dB, busy %d",
               kind < 7 ? kRadio[kind] : "?", static_cast<unsigned long long>(radio.at.us),
               static_cast<unsigned>(radio.packet.size()), radio.rssi_dbm, radio.snr_quarter_db,
               radio.busy ? 1 : 0);
      break;
    }
    case device::EventKind::link: {
      const auto link = static_cast<std::size_t>(event.link.link);
      const char* name = link < 3 ? kLinks[link] : "?";
      if (event.link.kind == device::LinkEventKind::packet) {
        ESP_LOGD(kTag, "%s packet, %u bytes", name,
                 static_cast<unsigned>(event.link.packet.size()));
      } else {
        ESP_LOGI(kTag, "%s link %s", name,
                 event.link.kind == device::LinkEventKind::up ? "up" : "down");
      }
      break;
    }
    case device::EventKind::input: {
      const auto input = static_cast<std::size_t>(event.input.input);
      ESP_LOGI(kTag, "%s %s", input < 4 ? kInputs[input] : "?",
               event.input.active ? "active" : "inactive");
      break;
    }
    default:
      break;
  }
}

}  // namespace

bool EspWaiter::begin() {
  esp_timer_create_args_t args{};
  args.callback = &on_alarm;
  args.arg = &queue_;
  args.dispatch_method = ESP_TIMER_TASK;
  args.name = "hsn_deadline";
  esp_timer_handle_t alarm = nullptr;
  if (esp_timer_create(&args, &alarm) != ESP_OK) {
    return false;
  }
  alarm_ = alarm;
  return true;
}

void EspWaiter::start_button(const device::BootInfo& boot, std::uint8_t role, bool unpaired) {
  unpaired_ = unpaired;
  paired_sensor_ = !unpaired && role == protocol::Role::sensor;
  const auto now = clock_.now();
  const bool down = inputs_.active(device::Input::button);
  if (unpaired_ && down && boot.kind != device::BootKind::other_reset) {
    button_.down(now);
  } else if (unpaired_ && !down && boot.woke_by.has(device::Input::button)) {
    // A short press can wake deep sleep and end before the GPIO input is configured.
    ESP_LOGI(kTag, "setup-only short button press");
  }
  if (paired_sensor_ && down) {
    paired_press_ = now;
  }
}

void EspWaiter::setup_button(const device::InputEvent& event) {
  if (event.input != device::Input::button) {
    return;
  }
  if (event.active) {
    button_.down(event.at);
  } else if (button_.up(event.at) == HoldAction::short_press) {
    ESP_LOGI(kTag, "setup-only short button press");
  }
}

void EspWaiter::service_setup(device::Instant now) {
  display_.poll(now);
  if (unpaired_ && inputs_.active(device::Input::button) && now >= button_.due()) {
    switch (button_.tick(now)) {
      case HoldAction::pair:
        if (const auto* code = display_.code(); code != nullptr) {
          static_cast<void>(bluetooth_.pair(now, *code));
        }
        break;
      case HoldAction::reset:
        if (bluetooth_.reset_unpaired()) {
          restart();
        }
        ESP_LOGW(kTag, "setup-only factory reset refused");
        break;
      default:
        break;
    }
  }
  if (log_ != nullptr && bluetooth_.poll(now, *log_)) {
    restart();
  }
  const bool pairing = bluetooth_.pairing();
  if (pairing != pairing_led_) {
    pairing_led_ = pairing;
    indicators_.blink(pairing ? device::Blink::pairing : device::Blink::off, now);
  }
}

device::Instant EspWaiter::setup_due() const {
  // On a raw release, let the debouncer settle before considering the old hold deadline.
  const auto hold =
      unpaired_ && inputs_.active(device::Input::button) ? button_.due() : device::Instant::never();
  return device::earliest(hold, device::earliest(bluetooth_.due(), display_.due()));
}

LinkSlots* EspWaiter::slots_of(std::uint8_t link) {
  if (link == static_cast<std::uint8_t>(device::LinkKind::usb)) {
    return &usb_.slots();
  }
  if (link == static_cast<std::uint8_t>(device::LinkKind::network) && network_ != nullptr) {
    return &network_->slots();
  }
  if (link == static_cast<std::uint8_t>(device::LinkKind::bluetooth)) {
    return &bluetooth_.slots();
  }
  return nullptr;
}

bool EspWaiter::push(const device::Event& event, std::uint8_t link, std::uint8_t slot,
                     std::uint32_t generation) {
  if (count_ == pending_.size()) {
    return false;
  }
  Pending& entry = pending_[(head_ + count_) % pending_.size()];
  entry.event = event;
  entry.link = link;
  entry.slot = slot;
  entry.generation = generation;
  count_ += 1;
  return true;
}

bool EspWaiter::pop(Pending& out) {
  if (count_ == 0) {
    return false;
  }
  out = pending_[head_];
  head_ = (head_ + 1) % pending_.size();
  count_ -= 1;
  return true;
}

bool EspWaiter::radio_event_pending() const {
  for (std::size_t i = 0; i < count_; ++i) {
    if (pending_[(head_ + i) % pending_.size()].event.kind == device::EventKind::radio) {
      return true;
    }
  }
  return false;
}

void EspWaiter::service_radio(device::Instant at) {
  // One radio event at a time: a received packet is in the radio's own buffer, which the next
  // service would overwrite. A rise meanwhile waits; DIO1 stays high until its IRQ is cleared.
  if (radio_event_pending() || count_ + 2 > pending_.size()) {
    if (!radio_deferred_) {
      radio_deferred_ = true;
      radio_deferred_at_ = at;
    }
    return;
  }
  radio_deferred_ = false;
  std::array<device::RadioEvent, 2> events{};
  const std::size_t made = radio_.service(at, events);
  for (std::size_t i = 0; i < made; ++i) {
    static_cast<void>(push(device::Event::from_radio(at, events[i])));
  }
}

void EspWaiter::absorb(const Message& message) {
  switch (message.kind) {
    case MessageKind::radio_irq:
      service_radio(message.at);
      break;
    case MessageKind::input_edge:
      inputs_.edge(static_cast<device::Input>(message.index), message.at);
      break;
    case MessageKind::link_packet: {
      LinkSlots* slots = slots_of(message.index);
      if (slots == nullptr) {
        break;
      }
      device::LinkEvent link;
      link.link = static_cast<device::LinkKind>(message.index);
      link.kind = device::LinkEventKind::packet;
      link.packet = slots->packet(message.slot);
      if (!push(device::Event::from_link(clock_.now(), link), message.index, message.slot,
                message.generation)) {
        slots->release(message.slot);
      }
      break;
    }
    case MessageKind::link_up:
    case MessageKind::link_down: {
      const bool up = message.kind == MessageKind::link_up;
      const auto kind = static_cast<device::LinkKind>(message.index);
      if (kind == device::LinkKind::usb) {
        if (!usb_.current(message.generation)) {
          break;
        }
        usb_.delivered_up(up);
      } else if (kind == device::LinkKind::network && network_ != nullptr) {
        if (!network_->current(message.generation)) {
          break;
        }
        network_->delivered_up(up);
      } else if (kind != device::LinkKind::bluetooth || !bluetooth_.current(message.generation)) {
        break;
      }
      device::LinkEvent link;
      link.link = kind;
      link.kind = up ? device::LinkEventKind::up : device::LinkEventKind::down;
      static_cast<void>(
          push(device::Event::from_link(clock_.now(), link), 0xFF, 0, message.generation));
      break;
    }
    case MessageKind::deadline:
      break;
  }
}

void EspWaiter::drain() {
  Message message;
  // Leave room for a radio service's two events; what stays in the queue is taken next time.
  while (count_ + 2 <= pending_.size() && queue_.take(message, 0)) {
    absorb(message);
  }
}

void EspWaiter::settle_inputs(device::Instant now) {
  std::array<device::InputEvent, 4> changes{};
  // Settling moves each input's reported level on, so there must be room for every change it
  // could make; otherwise it waits for the next turn, the edges still pending.
  if (count_ + changes.size() > pending_.size()) {
    return;
  }
  const std::size_t made = inputs_.settle(now, changes);
  for (std::size_t i = 0; i < made; ++i) {
    if (unpaired_) {
      setup_button(changes[i]);
    }
    static_cast<void>(push(device::Event::from_input(now, changes[i])));
  }
}

void EspWaiter::release_delivered() {
  if (delivered_link_ != 0xFF) {
    LinkSlots* slots = slots_of(delivered_link_);
    if (slots != nullptr) {
      slots->release(delivered_slot_);
    }
    delivered_link_ = 0xFF;
  }
}

void EspWaiter::log_losses(device::Instant now) {
  if (log_ == nullptr) {
    return;
  }
  const std::uint32_t usb = usb_.slots().dropped();
  const std::uint32_t network = network_ != nullptr ? network_->slots().dropped() : 0;
  const auto bluetooth = bluetooth_.slots().dropped();
  const std::uint32_t queue = queue_.dropped();
  if (usb != usb_dropped_ || network != network_dropped_ || bluetooth != bluetooth_dropped_) {
    log_->add(now, device::LogLevel::warning, platform_log::link_overflow, "link rx dropped",
              static_cast<std::int32_t>(usb + network + bluetooth));
    usb_dropped_ = usb;
    network_dropped_ = network;
    bluetooth_dropped_ = bluetooth;
  }
  if (queue != queue_dropped_) {
    log_->add(now, device::LogLevel::warning, platform_log::queue_overflow, "queue full",
              static_cast<std::int32_t>(queue));
    queue_dropped_ = queue;
  }
}

bool EspWaiter::light_sleep_allowed() const {
  return !power_.external_power() && (network_ == nullptr || !network_->active()) &&
         !indicators_.playing() && !bluetooth_.active();
}

void EspWaiter::block_until(device::Instant deadline) {
  auto alarm = static_cast<esp_timer_handle_t>(alarm_);
  const device::Instant now = clock_.now();
  bool armed = false;
  if (!deadline.is_never()) {
    const std::int64_t after = (deadline - now).us;
    armed =
        esp_timer_start_once(alarm, static_cast<std::uint64_t>(after > 0 ? after : 0)) == ESP_OK;
  }
  Message message;
  // With no deadline the Runner's slice still bounds the wait; never is only for the queue.
  if (queue_.take(message, armed || deadline.is_never() ? UINT32_MAX : 1)) {
    absorb(message);
  }
  if (armed) {
    static_cast<void>(esp_timer_stop(alarm));
  }
}

void EspWaiter::light_sleep(device::Instant deadline) {
  const device::Instant now = clock_.now();
  if (!deadline.is_never() && deadline <= now) {
    return;
  }
  static_cast<void>(esp_sleep_disable_wakeup_source(ESP_SLEEP_WAKEUP_ALL));
  if (!deadline.is_never()) {
    static_cast<void>(
        esp_sleep_enable_timer_wakeup(static_cast<std::uint64_t>((deadline - now).us)));
  }
  // DIO1's edge interrupt is off while its level wake is armed, so the level cannot interrupt in
  // a storm once the chip wakes; the inputs do the same (inputs.cpp).
  gpio_intr_disable(dio1());
  static_cast<void>(gpio_wakeup_enable(dio1(), GPIO_INTR_HIGH_LEVEL));
  inputs_.arm_light_sleep();
  static_cast<void>(esp_sleep_enable_gpio_wakeup());
  const esp_err_t slept = esp_light_sleep_start();
  const device::Instant woke = clock_.now();
  static_cast<void>(gpio_wakeup_disable(dio1()));
  static_cast<void>(gpio_set_intr_type(dio1(), GPIO_INTR_POSEDGE));
  static_cast<void>(gpio_intr_enable(dio1()));
  inputs_.disarm_light_sleep(woke);
  static_cast<void>(esp_sleep_disable_wakeup_source(ESP_SLEEP_WAKEUP_ALL));
  if (slept != ESP_OK) {
    ESP_LOGW(kTag, "light sleep refused: %s", esp_err_to_name(slept));
  }
  if (gpio_get_level(dio1()) != 0 && radio_.operation_under_way()) {
    service_radio(woke);
  }
  drain();
}

void EspWaiter::deep_sleep(const device::WaitRequest& request) {
  if (!bluetooth_.stop()) {
    restart();
  }
  const bool network_was_up = network_ != nullptr && network_->up();
  if (network_ != nullptr) {
    network_->shut_down(kShutDownMs);
  }
  radio_.prepare_deep_sleep();
  indicators_.off();
  static_cast<void>(esp_sleep_disable_wakeup_source(ESP_SLEEP_WAKEUP_ALL));
  if (!request.until.is_never()) {
    // Read again: closing the network link took time (at most kShutDownMs) since `now`.
    const std::int64_t left = (request.until - clock_.now()).us;
    static_cast<void>(
        esp_sleep_enable_timer_wakeup(static_cast<std::uint64_t>(left > 0 ? left : 1)));
  }
  if (!inputs_.arm_deep_sleep(request.deep_wake_inputs)) {
    ESP_LOGI(kTag, "deep sleep");
    esp_deep_sleep_start();  // never returns: the chip resets on wake
  }
  // An input changed since the core last heard of it: no sleep; the change goes to the core.
  ESP_LOGI(kTag, "deep sleep abandoned: an input changed");
  static_cast<void>(esp_sleep_disable_wakeup_source(ESP_SLEEP_WAKEUP_ALL));
  radio_.cancel_deep_sleep();
  inputs_.note_changes(clock_.now());
  if (network_was_up) {
    device::LinkEvent link;
    link.link = device::LinkKind::network;
    link.kind = device::LinkEventKind::down;
    static_cast<void>(push(device::Event::from_link(clock_.now(), link)));
  }
}

void EspWaiter::restart() {
  const std::int64_t start = esp_timer_get_time();
  usb_.flush(kRestartGraceMs);
  const std::int64_t spent_ms = (esp_timer_get_time() - start) / 1000;
  if (network_ != nullptr && spent_ms < kRestartGraceMs) {
    network_->flush(kRestartGraceMs - static_cast<std::uint32_t>(spent_ms));
  }
  esp_restart();
}

device::WaitResult EspWaiter::wait(const device::WaitRequest& request) {
  release_delivered();
  if (request.restart) {
    static_cast<void>(bluetooth_.stop());
    restart();
  }
  const auto feed_due = clock_.now() + device::kFeedSlice;
  if (clear_legacy_blink_) {
    indicators_.blink(device::Blink::off, clock_.now());
    clear_legacy_blink_ = false;
  }
  for (;;) {
    const device::Instant now = clock_.now();
    indicators_.step(now);
    usb_.poll();
    drain();
    if (radio_deferred_) {
      service_radio(radio_deferred_at_);
    }
    settle_inputs(now);
    service_setup(now);
    log_losses(now);
    Pending next;
    if (pop(next)) {
      if (next.event.kind == device::EventKind::link &&
          next.event.link.link == device::LinkKind::bluetooth &&
          !bluetooth_.current(next.generation)) {
        if (next.link != 0xFF) {
          bluetooth_.slots().release(next.slot);
        }
        continue;
      }
      if (paired_sensor_ && next.event.kind == device::EventKind::input &&
          next.event.input.input == device::Input::button) {
        const auto at = next.event.input.at;
        if (!next.event.input.active && !paired_press_.is_never()) {
          const auto held = at - paired_press_;
          // M1a's paired role still requests the old pairing LED on release. Its DS8 report
          // must still see the real edge and time; end the resulting legacy cue immediately.
          clear_legacy_blink_ = held >= device::seconds(5) && held < device::seconds(15);
        }
        paired_press_ = next.event.input.active ? at : device::Instant::never();
      }
      device::WaitResult result;
      result.has_event = true;
      result.event = next.event;
      result.event.now = clock_.now();
      delivered_link_ = next.link;
      delivered_slot_ = next.slot;
      describe(result.event);
      return result;
    }
    const auto platform_due = setup_due();
    const bool occupied = bluetooth_.active() || !platform_due.is_never();
    const auto until = occupied ? device::earliest(request.until, feed_due) : request.until;
    if (now >= until) {
      return device::WaitResult{};
    }
    // An input still settling is waited for awake, whatever the depth: it becomes an event.
    if (request.depth == device::SleepDepth::deep && !occupied &&
        inputs_.next_deadline().is_never() && !(unpaired_ && !button_.pressed.is_never())) {
      deep_sleep(request);
      continue;
    }
    const device::Instant deadline =
        device::earliest(device::earliest(until, platform_due),
                         device::earliest(inputs_.next_deadline(), indicators_.next_step()));
    if (request.depth == device::SleepDepth::light && light_sleep_allowed()) {
      light_sleep(deadline);
    } else {
      block_until(deadline);
    }
  }
}

}  // namespace hsn::esp
