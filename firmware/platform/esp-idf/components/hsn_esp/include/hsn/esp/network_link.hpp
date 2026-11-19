#pragma once

#include <array>
#include <atomic>
#include <cstdint>

#include "hsn/device/hal/link.hpp"
#include "hsn/esp/event_queue.hpp"
#include "hsn/esp/link_slots.hpp"
#include "hsn/protocol/setup.hpp"

namespace hsn::esp {

/**
 * The network link (protocol section 10, "Wi-Fi"): Wi-Fi as a station, the hub found by mDNS as
 * `_hsn-hub._tcp` whose TXT `id` is the paired hub identity (16 hex digits; any other hub is never
 * connected to, hardware notes (a) 47), then a WebSocket to ws://<address>:<port>/device carrying
 * one packet or transfer frame per binary message. No TLS (every packet is sealed already).
 *
 * The core times reconnects (design section 3), so the WebSocket client's own reconnect is off and
 * a failed attempt at any stage (Wi-Fi join, no hub found, WebSocket refused) is one `down`. The
 * client pings every 15 s and drops the connection after 15 s without a pong (kLinkPingInterval,
 * kLinkDeadAfter), which reports `down`: how a siren knows a Wi-Fi report failed (protocol
 * section 7). A message larger than the client's buffer arrives in pieces and is put together by
 * its offset (hardware notes (a) 46).
 *
 * Everything that waits (the join, the lookup, the WebSocket's handshake and sends) runs on the
 * link's own tasks, so connect(), disconnect() and send() return at once (design section 3, "a
 * call returns within 5 ms"). Wi-Fi starts on the first connect(): a sensor, which uses the
 * network only for updates, never starts it otherwise. Wi-Fi keeps its settings in RAM only
 * (WIFI_STORAGE_RAM), so joining never writes to NVS.
 */
class NetworkLink final : public device::Link {
public:
  explicit NetworkLink(EventQueue& queue) : queue_(queue) {}

  /** Creates the link's queues and tasks; Wi-Fi itself starts on the first connect(). */
  bool begin();

  device::LinkKind kind() const override {
    return device::LinkKind::network;
  }
  device::HalError connect(const device::LinkTarget& target) override;
  void disconnect() override;
  device::HalError send(protocol::ByteView packet) override;
  bool up() const override {
    return up_;
  }
  std::int8_t signal_dbm() const override;
  std::uint16_t largest_packet() const override {
    return 0;
  }

  bool current(std::uint32_t generation) const {
    return generation == generation_.load();
  }
  /** The waiter: a link_up or link_down message of the current generation was delivered. */
  void delivered_up(bool up_now) {
    up_ = up_now;
    if (!up_now) {
      active_.store(false);
    }
  }
  /** True from connect() until disconnect() or a down: Wi-Fi is in use (no light sleep). */
  bool active() const {
    return active_.load();
  }
  /** Before deep sleep or a restart: closes the WebSocket and stops Wi-Fi, waiting at most ms. */
  void shut_down(std::uint32_t wait_ms);
  /** Before a restart: waits at most `wait_ms` for queued packets to leave. */
  void flush(std::uint32_t wait_ms);

  LinkSlots& slots() {
    return slots_;
  }

private:
  enum class Command : std::uint8_t { connect, disconnect, shut_down };

  /** One command to the worker, the target copied in (a call copies what it is given). */
  struct Order {
    Command command = Command::disconnect;
    std::uint32_t generation = 0;
    protocol::HubIdentity hub{};
    std::array<std::uint8_t, 32> wifi_name{};
    std::uint8_t wifi_name_size = 0;
    std::array<std::uint8_t, 64> wifi_password{};
    std::uint8_t wifi_password_size = 0;
  };

  static void worker(void* self);
  static void sender(void* self);
  static void on_wifi(void* self, const char* base, std::int32_t id, void* data);
  static void on_websocket(void* self, const char* base, std::int32_t id, void* data);
  bool start_wifi();
  void attempt(const Order& order);
  bool join(const Order& order);
  bool find_hub(const protocol::HubIdentity& hub, std::array<char, 64>& uri);
  void close_client();
  void post_state(bool up_now, std::uint32_t generation);
  void received(const char* data, int length, int offset, int total, std::uint8_t opcode);

  EventQueue& queue_;
  LinkSlots slots_;
  SendSlots outgoing_;
  void* orders_ = nullptr;
  void* wifi_events_ = nullptr;
  void* client_lock_ = nullptr;
  void* done_ = nullptr;
  void* client_ = nullptr;
  bool wifi_started_ = false;
  std::atomic<bool> active_{false};
  std::atomic<std::uint32_t> generation_{0};
  /** The generation the open client belongs to: its events carry it. */
  std::atomic<std::uint32_t> client_generation_{0};
  std::atomic<bool> down_posted_{false};
  bool up_ = false;
  /** A message being put together from pieces: its slot, or -1. */
  int assembling_ = -1;
  std::array<std::uint8_t, protocol::kMaxFrameDataSize> sending_{};
};

}  // namespace hsn::esp
