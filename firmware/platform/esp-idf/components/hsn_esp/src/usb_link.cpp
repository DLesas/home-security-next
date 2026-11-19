#include "hsn/esp/usb_link.hpp"

#include <algorithm>

#include "driver/usb_serial_jtag.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

namespace hsn::esp {
namespace {

constexpr const char* kTag = "hsn.usb";
/** Room for two whole frames each way in the driver's ring buffers. */
constexpr std::uint32_t kDriverBuffer = 2 * (protocol::kMaxEncodedFrameSize + 1);
/** A write waits at most this for room; a host that reads nothing loses the frame. */
constexpr std::uint32_t kWriteWaitMs = 100;
constexpr std::uint32_t kTaskStack = 3072;
/** Above the main task (1), so bytes are taken off the port promptly. */
constexpr UBaseType_t kTaskPriority = 5;

}  // namespace

bool UsbLink::begin() {
  if (!outgoing_.begin()) {
    return false;
  }
  usb_serial_jtag_driver_config_t config{};
  config.tx_buffer_size = kDriverBuffer;
  config.rx_buffer_size = kDriverBuffer;
  if (usb_serial_jtag_driver_install(&config) != ESP_OK) {
    ESP_LOGE(kTag, "USB serial driver not installed");
    return false;
  }
  return xTaskCreate(&UsbLink::reader, "hsn_usb_rx", kTaskStack, this, kTaskPriority, nullptr) ==
             pdPASS &&
         xTaskCreate(&UsbLink::writer, "hsn_usb_tx", kTaskStack, this, kTaskPriority, nullptr) ==
             pdPASS;
}

void UsbLink::reader(void* self) {
  UsbLink& link = *static_cast<UsbLink*>(self);
  protocol::FrameDecoder decoder{protocol::MutableByteView(link.decoded_)};
  std::array<std::uint8_t, 64> bytes{};
  for (;;) {
    const int count = usb_serial_jtag_read_bytes(bytes.data(), bytes.size(), portMAX_DELAY);
    for (int i = 0; i < count; ++i) {
      const protocol::FrameEvent event = decoder.push(bytes[static_cast<std::size_t>(i)]);
      if (event.status != protocol::FrameStatus::frame) {
        continue;
      }
      const int slot = link.slots_.claim();
      if (slot < 0) {
        continue;  // counted by the slots; the waiter logs it
      }
      std::copy(event.data.begin(), event.data.end(), link.slots_.data(slot));
      link.slots_.set_size(slot, event.data.size());
      Message message;
      message.kind = MessageKind::link_packet;
      message.index = static_cast<std::uint8_t>(device::LinkKind::usb);
      message.slot = static_cast<std::uint8_t>(slot);
      if (!link.queue_.post(message)) {
        link.slots_.release(slot);
      }
    }
  }
}

void UsbLink::writer(void* self) {
  UsbLink& link = *static_cast<UsbLink*>(self);
  for (;;) {
    std::size_t size = 0;
    if (!link.outgoing_.take(link.sending_, size, UINT32_MAX)) {
      continue;
    }
    const auto encoded = protocol::encode_frame(protocol::ByteView(link.sending_.data(), size),
                                                protocol::MutableByteView(link.frame_));
    if (encoded.ok()) {
      const std::size_t length = encoded.value();
      const int written =
          usb_serial_jtag_write_bytes(link.frame_.data(), length, pdMS_TO_TICKS(kWriteWaitMs));
      if (written > 0 && static_cast<std::size_t>(written) < length) {
        // A frame cut short: end it, so the host's decoder loses only this one.
        const std::uint8_t zero = 0;
        static_cast<void>(usb_serial_jtag_write_bytes(&zero, 1, pdMS_TO_TICKS(kWriteWaitMs)));
      }
    }
    link.outgoing_.sent();
  }
}

void UsbLink::post_state(bool up_now) {
  Message message;
  message.kind = up_now ? MessageKind::link_up : MessageKind::link_down;
  message.index = static_cast<std::uint8_t>(device::LinkKind::usb);
  message.generation = generation_.load();
  static_cast<void>(queue_.post(message));
}

device::HalError UsbLink::connect(const device::LinkTarget& target) {
  static_cast<void>(target);
  generation_.fetch_add(1);
  down_posted_ = false;
  post_state(usb_serial_jtag_is_connected());
  return device::HalError::none;
}

void UsbLink::disconnect() {
  // No down event follows: a message of the old generation is dropped by the waiter.
  generation_.fetch_add(1);
  up_ = false;
}

device::HalError UsbLink::send(protocol::ByteView packet) {
  if (packet.size() > protocol::kMaxFrameDataSize) {
    return device::HalError::invalid;
  }
  return outgoing_.put(packet) ? device::HalError::none : device::HalError::busy;
}

bool UsbLink::up() const {
  return up_;
}

void UsbLink::poll() {
  if (up_ && !down_posted_ && !usb_serial_jtag_is_connected()) {
    down_posted_ = true;
    post_state(false);
  }
}

void UsbLink::flush(std::uint32_t wait_ms) {
  const std::int64_t deadline = esp_timer_get_time() + static_cast<std::int64_t>(wait_ms) * 1000;
  while (!outgoing_.empty() && esp_timer_get_time() < deadline) {
    vTaskDelay(pdMS_TO_TICKS(5));
  }
  const std::int64_t left = deadline - esp_timer_get_time();
  if (left > 0) {
    static_cast<void>(usb_serial_jtag_wait_tx_done(pdMS_TO_TICKS(left / 1000 + 1)));
  }
}

}  // namespace hsn::esp
