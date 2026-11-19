#include "hsn/esp/inputs.hpp"

#include "driver/gpio.h"
#include "driver/rtc_io.h"
#include "esp_attr.h"
#include "esp_log.h"
#include "esp_sleep.h"
#include "freertos/FreeRTOS.h"

namespace hsn::esp {
namespace {

constexpr const char* kTag = "hsn.inputs";

gpio_num_t gpio(Pin pin) {
  return static_cast<gpio_num_t>(pin);
}

std::size_t index_of(device::Input input) {
  return static_cast<std::size_t>(input);
}

}  // namespace

InputSet InputSet::for_role(std::uint8_t role) {
  InputSet set;
  set.door = role == 1;
  set.cover = role == 1 || role == 2;
  return set;
}

IRAM_ATTR void Inputs::on_edge(void* context) {
  const IsrContext& isr = *static_cast<const IsrContext*>(context);
  Inputs& inputs = *isr.inputs;
  // A bounce while the last edge's message waits adds nothing: the first edge dates the change.
  if (inputs.posted_[isr.index]) {
    return;
  }
  Message message;
  message.kind = MessageKind::input_edge;
  message.index = isr.index;
  message.at = inputs.clock_.now_from_isr();
  int woken = 0;
  inputs.posted_[isr.index] = inputs.queue_.post_from_isr(message, &woken);
  if (woken != 0) {
    portYIELD_FROM_ISR();
  }
}

bool Inputs::begin(InputSet set) {
  auto wire = [this](device::Input input, Pin pin, std::uint8_t active_level, bool wired) {
    Line& line = lines_[index_of(input)];
    line = Line{};
    line.pin = pin;
    line.active_level = active_level;
    line.wired = wired;
  };
  wire(device::Input::door, kBoard.door, kBoard.door_open_level, set.door);
  wire(device::Input::cover, kBoard.cover, kBoard.cover_open_level, set.cover);
  wire(device::Input::button, kBoard.button, kBoard.button_pressed_level, set.button);
  wire(device::Input::external_power, kBoard.external_power, kBoard.external_power_level,
       set.external_power);
  for (std::size_t i = 0; i < lines_.size(); ++i) {
    Line& line = lines_[i];
    if (line.pin == kNoPin) {
      line.wired = false;
    }
    if (!line.wired) {
      continue;
    }
    // A deep-sleep wake leaves an RTC pad in the RTC domain (hardware notes (a) 28).
    if (rtc_gpio_is_valid_gpio(gpio(line.pin))) {
      static_cast<void>(rtc_gpio_deinit(gpio(line.pin)));
    }
    gpio_config_t config{};
    config.pin_bit_mask = 1ull << line.pin;
    config.mode = GPIO_MODE_INPUT;
    // The bench's switches have their own pull-ups and the power sense its divider (board.hpp).
    config.pull_up_en = GPIO_PULLUP_DISABLE;
    config.pull_down_en = GPIO_PULLDOWN_DISABLE;
    config.intr_type = GPIO_INTR_ANYEDGE;
    contexts_[i] = IsrContext{this, static_cast<std::uint8_t>(i)};
    if (gpio_config(&config) != ESP_OK ||
        gpio_isr_handler_add(gpio(line.pin), &Inputs::on_edge, &contexts_[i]) != ESP_OK) {
      ESP_LOGE(kTag, "input on GPIO%d not configured", line.pin);
      return false;
    }
    line.reported = level(line);
  }
  return true;
}

std::uint8_t Inputs::level(const Line& line) const {
  return static_cast<std::uint8_t>(gpio_get_level(gpio(line.pin)) != 0 ? 1 : 0);
}

bool Inputs::active(device::Input input) const {
  const Line& line = lines_[index_of(input)];
  return line.wired && level(line) == line.active_level;
}

void Inputs::edge(device::Input input, device::Instant at) {
  posted_[index_of(input)] = false;
  Line& line = lines_[index_of(input)];
  if (!line.wired) {
    return;
  }
  // The first edge of a burst dates the change; later bounces only push the settling on.
  if (!line.pending) {
    line.pending = true;
    line.first_edge = at;
  }
}

device::Instant Inputs::next_deadline() const {
  device::Instant earliest = device::Instant::never();
  for (const Line& line : lines_) {
    if (line.pending) {
      earliest = device::earliest(earliest, line.first_edge + device::microseconds(kDebounceUs));
    }
  }
  return earliest;
}

std::size_t Inputs::settle(device::Instant now, std::array<device::InputEvent, 4>& out) {
  std::size_t count = 0;
  for (std::size_t i = 0; i < lines_.size(); ++i) {
    Line& line = lines_[i];
    if (!line.pending || now < line.first_edge + device::microseconds(kDebounceUs)) {
      continue;
    }
    line.pending = false;
    const std::uint8_t now_level = level(line);
    if (now_level == line.reported) {
      continue;
    }
    line.reported = now_level;
    device::InputEvent& event = out[count];
    event.input = static_cast<device::Input>(i);
    event.active = now_level == line.active_level;
    event.at = line.first_edge;
    count += 1;
  }
  return count;
}

void Inputs::arm_light_sleep() {
  for (Line& line : lines_) {
    if (!line.wired) {
      continue;
    }
    gpio_intr_disable(gpio(line.pin));
    const gpio_int_type_t wake = level(line) != 0 ? GPIO_INTR_LOW_LEVEL : GPIO_INTR_HIGH_LEVEL;
    static_cast<void>(gpio_wakeup_enable(gpio(line.pin), wake));
  }
}

void Inputs::disarm_light_sleep(device::Instant now) {
  for (std::size_t i = 0; i < lines_.size(); ++i) {
    Line& line = lines_[i];
    if (!line.wired) {
      continue;
    }
    static_cast<void>(gpio_wakeup_disable(gpio(line.pin)));
    static_cast<void>(gpio_set_intr_type(gpio(line.pin), GPIO_INTR_ANYEDGE));
    static_cast<void>(gpio_intr_enable(gpio(line.pin)));
  }
  // An edge during the sleep woke the chip with its interrupt disabled: noted here, dated at the
  // wake (the sleep hid the moment itself; the wake latency is unmeasured ‡).
  note_changes(now);
}

void Inputs::note_changes(device::Instant now) {
  for (std::size_t i = 0; i < lines_.size(); ++i) {
    const Line& line = lines_[i];
    if (line.wired && level(line) != line.reported) {
      edge(static_cast<device::Input>(i), now);
    }
  }
}

bool Inputs::arm_deep_sleep(device::WakeMask mask) {
  std::array<std::uint8_t, 4> armed{};
  for (std::size_t i = 0; i < lines_.size(); ++i) {
    const Line& line = lines_[i];
    if (!line.wired || !mask.has(static_cast<device::Input>(i)) ||
        !deep_sleep_wake_capable(line.pin)) {
      continue;
    }
    armed[i] = level(line);
    const esp_sleep_gpio_wake_up_mode_t mode =
        armed[i] != 0 ? ESP_GPIO_WAKEUP_GPIO_LOW : ESP_GPIO_WAKEUP_GPIO_HIGH;
    if (esp_sleep_enable_gpio_wakeup_on_hp_periph_powerdown(1ull << line.pin, mode) != ESP_OK) {
      ESP_LOGE(kTag, "deep-sleep wake on GPIO%d not armed", line.pin);
    }
  }
  // Read again after arming, to close the race (hardware notes (a) 27). A change that came after
  // the level last reported but before the arming was armed against: it would never wake the
  // chip and never be reported, so it shows as a level other than the one reported. A change
  // after the arming meets its own wake level and wakes the chip at once.
  bool changed = false;
  for (std::size_t i = 0; i < lines_.size(); ++i) {
    const Line& line = lines_[i];
    if (line.wired && mask.has(static_cast<device::Input>(i)) &&
        deep_sleep_wake_capable(line.pin) && level(line) != armed[i]) {
      changed = true;
    }
    if (line.wired && level(line) != line.reported) {
      changed = true;
    }
  }
  return changed;
}

}  // namespace hsn::esp
