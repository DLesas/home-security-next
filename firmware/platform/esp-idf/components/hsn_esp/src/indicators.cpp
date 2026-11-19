#include "hsn/esp/indicators.hpp"

#include "driver/gpio.h"
#include "driver/ledc.h"
#include "esp_log.h"
#include "hsn/esp/board.hpp"

namespace hsn::esp {
namespace {

constexpr const char* kTag = "hsn.indicators";
constexpr ledc_mode_t kMode = LEDC_LOW_SPEED_MODE;
constexpr ledc_timer_t kTimer = LEDC_TIMER_0;
constexpr ledc_channel_t kChannel = LEDC_CHANNEL_0;
constexpr ledc_timer_bit_t kResolution = LEDC_TIMER_10_BIT;
/** Half of 2^10: a square wave. */
constexpr std::uint32_t kHalfDuty = 512;

std::int64_t ms(std::int64_t value) {
  return value * 1000;
}

}  // namespace

bool Indicators::begin() {
  if (kBoard.buzzer != kNoPin) {
    ledc_timer_config_t timer{};
    timer.speed_mode = kMode;
    timer.duty_resolution = kResolution;
    timer.timer_num = kTimer;
    timer.freq_hz = kBoard.buzzer_hz;
    timer.clk_cfg = LEDC_AUTO_CLK;
    ledc_channel_config_t channel{};
    channel.gpio_num = kBoard.buzzer;
    channel.speed_mode = kMode;
    channel.channel = kChannel;
    channel.timer_sel = kTimer;
    channel.duty = 0;
    channel.hpoint = 0;
    buzzer_ready_ = ledc_timer_config(&timer) == ESP_OK && ledc_channel_config(&channel) == ESP_OK;
    if (!buzzer_ready_) {
      ESP_LOGE(kTag, "buzzer not configured");
    }
  }
  if (kBoard.led != kNoPin) {
    gpio_config_t config{};
    config.pin_bit_mask = 1ull << kBoard.led;
    config.mode = GPIO_MODE_OUTPUT;
    led_ready_ = gpio_config(&config) == ESP_OK;
    output(false, false);
  }
  return true;
}

Indicators::Pattern Indicators::pattern_of(device::Sound sound) {
  switch (sound) {
    case device::Sound::countdown:
      return Pattern{ms(100), ms(900), 0};
    case device::Sound::alarm:
      return Pattern{ms(400), ms(100), 0};
    case device::Sound::chirp:
      return Pattern{ms(50), 0, 1};
    case device::Sound::low_battery:
      return Pattern{ms(60), ms(120), 3};
    case device::Sound::reset_warning:
      return Pattern{ms(200), ms(300), 0};
    case device::Sound::off:
      break;
  }
  return Pattern{};
}

Indicators::Pattern Indicators::pattern_of(device::Blink blink) {
  switch (blink) {
    case device::Blink::short_once:
      return Pattern{ms(100), 0, 1};
    case device::Blink::pairing:
      return Pattern{ms(500), ms(500), 0};
    case device::Blink::fault:
      return Pattern{ms(100), ms(100), 0};
    case device::Blink::off:
      break;
  }
  return Pattern{};
}

void Indicators::output(bool buzzer, bool on) {
  if (buzzer) {
    if (buzzer_ready_) {
      static_cast<void>(ledc_set_duty(kMode, kChannel, on ? kHalfDuty : 0));
      static_cast<void>(ledc_update_duty(kMode, kChannel));
    }
    return;
  }
  if (led_ready_) {
    const std::uint32_t lit = kBoard.led_on_level;
    static_cast<void>(gpio_set_level(static_cast<gpio_num_t>(kBoard.led), on ? lit : 1u - lit));
  }
}

void Indicators::start(Player& player, const Pattern& pattern, device::Instant now, bool buzzer) {
  player.pattern = pattern;
  player.played = 0;
  player.playing = pattern.on_us > 0;
  player.on = player.playing;
  player.next =
      player.playing ? now + device::microseconds(pattern.on_us) : device::Instant::never();
  output(buzzer, player.on);
}

void Indicators::advance(Player& player, device::Instant now, bool buzzer) {
  // Bounded: each pass moves `next` on by a whole phase, and a late step skips at most a handful.
  for (int guard = 0; guard < 64 && player.playing && player.next <= now; ++guard) {
    if (player.on) {
      player.played = static_cast<std::uint8_t>(player.played + 1);
      const bool done = player.pattern.repeats != 0 && player.played >= player.pattern.repeats;
      if (done || player.pattern.off_us <= 0) {
        if (done) {
          player.playing = false;
          player.next = device::Instant::never();
          player.on = false;
          output(buzzer, false);
          return;
        }
        player.next = player.next + device::microseconds(player.pattern.on_us);
        continue;
      }
      player.on = false;
      player.next = player.next + device::microseconds(player.pattern.off_us);
    } else {
      player.on = true;
      player.next = player.next + device::microseconds(player.pattern.on_us);
    }
    output(buzzer, player.on);
  }
}

void Indicators::sound(device::Sound sound, device::Instant now) {
  start(buzzer_, pattern_of(sound), now, true);
}

void Indicators::blink(device::Blink blink, device::Instant now) {
  start(led_, pattern_of(blink), now, false);
}

void Indicators::step(device::Instant now) {
  advance(buzzer_, now, true);
  advance(led_, now, false);
}

device::Instant Indicators::next_step() const {
  return device::earliest(buzzer_.next, led_.next);
}

bool Indicators::playing() const {
  return buzzer_.playing || led_.playing;
}

void Indicators::off() {
  buzzer_ = Player{};
  led_ = Player{};
  output(true, false);
  output(false, false);
}

}  // namespace hsn::esp
