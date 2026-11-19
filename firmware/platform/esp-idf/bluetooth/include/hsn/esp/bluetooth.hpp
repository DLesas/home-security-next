#pragma once

#include <atomic>

#include "esp_event.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "hsn/device/hal/retained.hpp"
#include "hsn/device/services/setup.hpp"
#include "hsn/esp/event_queue.hpp"
#include "hsn/esp/link_slots.hpp"
#include "hsn/esp/pairing_logic.hpp"
#include "protocomm.h"

struct ble_gap_event;
struct ble_gatt_access_ctxt;

namespace hsn::esp {

/** Owns the single NimBLE peripheral. Startup, shutdown and flash run on the main task. */
class Bluetooth final : public device::Link {
public:
  Bluetooth(EventQueue& queue, device::Storage& storage, device::RetainedMemory& retained,
            const device::BuildInfo& build);

  /** Creates the protocomm event handlers and callback mailbox. */
  bool begin();
  /** Opens pairing for an unpaired, configured board. */
  bool pair(device::Instant now, const PairCode& code);
  /** Services deadlines and one authenticated setup request; true when a restart is due. */
  bool poll(device::Instant now, device::LogBuffer& log);
  /** Returns the next platform deadline, or never. */
  device::Instant due() const;
  /** Closes whichever service owns NimBLE. Main task only. False requires a board restart. */
  bool stop();
  /** True while a service or pending update start blocks sleep. */
  bool active() const;
  /** True until the LED should stop indicating a pairing window. */
  bool pairing() const;
  /** Checks paired state in flash, including changes made by the USB setup path. */
  bool unpaired();
  /** Resets an unpaired board. True asks the caller to restart after reset or a stop failure. */
  bool reset_unpaired();
  /** Supplies the receive slots to the waiter. */
  LinkSlots& slots() {
    return slots_;
  }
  /** Rejects messages dating from before a local disconnect or service switch. */
  bool current(std::uint32_t generation) const {
    return generation == generation_.load();
  }

  device::LinkKind kind() const override {
    return device::LinkKind::bluetooth;
  }
  device::HalError connect(const device::LinkTarget& target) override;
  void disconnect() override;
  device::HalError send(protocol::ByteView packet) override;
  bool up() const override {
    return largest_packet() != 0;
  }
  std::int8_t signal_dbm() const override {
    return 0;
  }
  std::uint16_t largest_packet() const override {
    return update_online_.load() ? payload_.load() : 0;
  }

private:
  enum class Mode { off, pairing, update };
  struct Exchange {
    protocol::ByteView input;
    protocol::MutableByteView output;
    std::size_t written = 0;
  };

  static int update_gap(ble_gap_event* event, void* arg);
  static int update_write(std::uint16_t conn, std::uint16_t attr, ble_gatt_access_ctxt* access,
                          void* arg);
  static void update_sync();
  static void on_pair_event(void* arg, esp_event_base_t base, std::int32_t id, void* data);
  static esp_err_t pair_request(std::uint32_t conn, const std::uint8_t* input, ssize_t size,
                                std::uint8_t** output, ssize_t* written, void* arg);
  static esp_err_t authenticate(protocomm_security_handle_t handle, const void* params,
                                std::uint32_t conn, const std::uint8_t* input, ssize_t size,
                                std::uint8_t** output, ssize_t* written, void* arg);
  /** Registers and starts the custom update GATT server. */
  bool start_update();
  /** Advertises the update service after host synchronization. */
  void advertise_update();
  void update_subscription(std::uint16_t mtu);
  void update_lost();
  void finish_setup(device::Instant now, device::LogBuffer& log);
  Exchange* take_exchange(bool close);
  bool post(MessageKind kind, std::uint32_t generation, std::uint8_t slot = 0);
  void wake();

  EventQueue& queue_;
  device::Storage& storage_;
  device::RetainedMemory& retained_;
  const device::BuildInfo& build_;
  LinkSlots slots_;
  Mode mode_ = Mode::off;
  bool ready_ = false;
  bool want_update_ = false;
  bool provision_restart_ = false;
  bool had_pair_connection_ = false;
  device::Instant close_due_ = device::Instant::never();
  device::Instant proof_close_due_ = device::Instant::never();
  PairWindow window_{};
  Advert advert_{};
  protocomm_t* pair_ = nullptr;
  protocomm_security_t security_{};
  protocomm_security2_params_t credentials_{};
  StaticSemaphore_t exchange_storage_{};
  StaticSemaphore_t barrier_storage_{};
  SemaphoreHandle_t exchanged_ = nullptr;
  SemaphoreHandle_t barrier_ = nullptr;
  portMUX_TYPE exchange_lock_ = portMUX_INITIALIZER_UNLOCKED;
  Exchange* exchange_ = nullptr;
  bool accepting_ = false;
  std::atomic<bool> pair_connected_{false};
  std::atomic<bool> pair_lockout_{false};
  std::atomic<bool> update_online_{false};
  std::atomic<bool> update_failed_{false};
  std::atomic<std::uint16_t> conn_{0xffff};
  std::atomic<std::uint16_t> payload_{0};
  std::atomic<std::uint32_t> generation_{0};
  std::uint32_t update_generation_ = 0;
  std::uint16_t tx_attr_ = 0;
  bool subscribed_ = false;  // NimBLE host task only
};

/** Supplies the update link to Hal. */
inline device::Link* bluetooth_link(Bluetooth& bluetooth) {
  return &bluetooth;
}

}  // namespace hsn::esp
