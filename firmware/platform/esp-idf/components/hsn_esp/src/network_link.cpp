#include "hsn/esp/network_link.hpp"

#include <algorithm>
#include <cstdio>
#include <cstring>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_websocket_client.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "mdns.h"

namespace hsn::esp {
namespace {

constexpr const char* kTag = "hsn.network";
constexpr EventBits_t kGotAddress = BIT0;
constexpr EventBits_t kJoinFailed = BIT1;
/** How long a Wi-Fi join may take ‡ (no design names one; the core's back-off follows a failure).
 */
constexpr std::uint32_t kJoinMs = 15000;
/** How long the mDNS lookup listens ‡. */
constexpr std::uint32_t kLookupMs = 3000;
constexpr std::size_t kLookupResults = 8;
/** The client's buffer: a 1,024-byte packet in one piece (larger messages come in pieces). */
constexpr int kClientBuffer = 1100;
constexpr int kNetworkTimeoutMs = 10000;
constexpr std::uint32_t kTaskStack = 4096;
constexpr UBaseType_t kTaskPriority = 4;
constexpr std::uint32_t kOrders = 4;

/** The ping period and the silence that ends the link (link.hpp: 15 s each). */
constexpr int kPingSeconds = static_cast<int>(device::kLinkPingInterval.us / 1000000);
constexpr int kDeadSeconds = static_cast<int>(device::kLinkDeadAfter.us / 1000000);

bool same_identity(const char* text, std::size_t length, const protocol::HubIdentity& hub) {
  constexpr char kHex[] = "0123456789abcdef";
  if (length != hub.size() * 2) {
    return false;
  }
  for (std::size_t i = 0; i < hub.size(); ++i) {
    for (std::size_t half = 0; half < 2; ++half) {
      const std::uint8_t nibble =
          static_cast<std::uint8_t>(half == 0 ? hub[i] >> 4 : hub[i] & 0x0F);
      char c = text[i * 2 + half];
      if (c >= 'A' && c <= 'F') {
        c = static_cast<char>(c - 'A' + 'a');
      }
      if (c != kHex[nibble]) {
        return false;
      }
    }
  }
  return true;
}

}  // namespace

bool NetworkLink::begin() {
  orders_ = xQueueCreate(kOrders, sizeof(Order));
  wifi_events_ = xEventGroupCreate();
  client_lock_ = xSemaphoreCreateMutex();
  done_ = xSemaphoreCreateBinary();
  if (orders_ == nullptr || wifi_events_ == nullptr || client_lock_ == nullptr ||
      done_ == nullptr || !outgoing_.begin()) {
    return false;
  }
  return xTaskCreate(&NetworkLink::worker, "hsn_net", kTaskStack, this, kTaskPriority, nullptr) ==
             pdPASS &&
         xTaskCreate(&NetworkLink::sender, "hsn_net_tx", kTaskStack, this, kTaskPriority,
                     nullptr) == pdPASS;
}

device::HalError NetworkLink::connect(const device::LinkTarget& target) {
  Order order;
  order.command = Command::connect;
  order.generation = generation_.fetch_add(1) + 1;
  order.hub = target.hub;
  order.wifi_name_size =
      static_cast<std::uint8_t>(std::min(target.wifi_name.size(), order.wifi_name.size()));
  std::copy_n(target.wifi_name.begin(), order.wifi_name_size, order.wifi_name.begin());
  order.wifi_password_size =
      static_cast<std::uint8_t>(std::min(target.wifi_password.size(), order.wifi_password.size()));
  std::copy_n(target.wifi_password.begin(), order.wifi_password_size, order.wifi_password.begin());
  up_ = false;
  if (order.wifi_name_size == 0) {
    return device::HalError::invalid;
  }
  if (xQueueSend(static_cast<QueueHandle_t>(orders_), &order, 0) != pdTRUE) {
    return device::HalError::busy;
  }
  active_.store(true);
  return device::HalError::none;
}

void NetworkLink::disconnect() {
  generation_.fetch_add(1);
  up_ = false;
  active_.store(false);
  Order order;
  order.command = Command::disconnect;
  order.generation = generation_.load();
  static_cast<void>(xQueueSend(static_cast<QueueHandle_t>(orders_), &order, 0));
}

device::HalError NetworkLink::send(protocol::ByteView packet) {
  if (packet.size() > protocol::kMaxFrameDataSize) {
    return device::HalError::invalid;
  }
  if (!up_) {
    return device::HalError::io;
  }
  return outgoing_.put(packet) ? device::HalError::none : device::HalError::busy;
}

std::int8_t NetworkLink::signal_dbm() const {
  int rssi = 0;
  if (!wifi_started_ || esp_wifi_sta_get_rssi(&rssi) != ESP_OK) {
    return 0;
  }
  return static_cast<std::int8_t>(std::clamp(rssi, -128, 127));
}

void NetworkLink::shut_down(std::uint32_t wait_ms) {
  generation_.fetch_add(1);
  up_ = false;
  active_.store(false);
  Order order;
  order.command = Command::shut_down;
  order.generation = generation_.load();
  if (xQueueSend(static_cast<QueueHandle_t>(orders_), &order, 0) == pdTRUE) {
    static_cast<void>(
        xSemaphoreTake(static_cast<SemaphoreHandle_t>(done_), pdMS_TO_TICKS(wait_ms)));
  }
}

void NetworkLink::flush(std::uint32_t wait_ms) {
  const std::int64_t deadline = esp_timer_get_time() + static_cast<std::int64_t>(wait_ms) * 1000;
  while (!outgoing_.empty() && esp_timer_get_time() < deadline) {
    vTaskDelay(pdMS_TO_TICKS(5));
  }
}

void NetworkLink::post_state(bool up_now, std::uint32_t generation) {
  Message message;
  message.kind = up_now ? MessageKind::link_up : MessageKind::link_down;
  message.index = static_cast<std::uint8_t>(device::LinkKind::network);
  message.generation = generation;
  static_cast<void>(queue_.post(message));
}

void NetworkLink::worker(void* self) {
  NetworkLink& link = *static_cast<NetworkLink*>(self);
  for (;;) {
    Order order;
    if (xQueueReceive(static_cast<QueueHandle_t>(link.orders_), &order, portMAX_DELAY) != pdTRUE) {
      continue;
    }
    link.close_client();
    switch (order.command) {
      case Command::connect:
        if (link.current(order.generation)) {
          link.attempt(order);
        }
        break;
      case Command::disconnect:
        break;
      case Command::shut_down:
        if (link.wifi_started_) {
          static_cast<void>(esp_wifi_stop());
          link.wifi_started_ = false;
        }
        xSemaphoreGive(static_cast<SemaphoreHandle_t>(link.done_));
        break;
    }
  }
}

void NetworkLink::sender(void* self) {
  NetworkLink& link = *static_cast<NetworkLink*>(self);
  for (;;) {
    std::size_t size = 0;
    if (!link.outgoing_.take(link.sending_, size, UINT32_MAX)) {
      continue;
    }
    xSemaphoreTake(static_cast<SemaphoreHandle_t>(link.client_lock_), portMAX_DELAY);
    auto client = static_cast<esp_websocket_client_handle_t>(link.client_);
    if (client != nullptr && esp_websocket_client_is_connected(client)) {
      // A send that fails is a link about to report down; the core learns it from that.
      static_cast<void>(
          esp_websocket_client_send_bin(client, reinterpret_cast<const char*>(link.sending_.data()),
                                        static_cast<int>(size), pdMS_TO_TICKS(kNetworkTimeoutMs)));
    }
    xSemaphoreGive(static_cast<SemaphoreHandle_t>(link.client_lock_));
    link.outgoing_.sent();
  }
}

bool NetworkLink::start_wifi() {
  static bool initialised = false;
  if (!initialised) {
    esp_err_t result = esp_netif_init();
    if (result == ESP_OK) {
      result = esp_event_loop_create_default();
      if (result == ESP_ERR_INVALID_STATE) {
        result = ESP_OK;  // already made
      }
    }
    if (result == ESP_OK && esp_netif_create_default_wifi_sta() == nullptr) {
      result = ESP_FAIL;
    }
    wifi_init_config_t config = WIFI_INIT_CONFIG_DEFAULT();
    result = result == ESP_OK ? esp_wifi_init(&config) : result;
    result = result == ESP_OK ? esp_wifi_set_storage(WIFI_STORAGE_RAM) : result;
    result = result == ESP_OK ? esp_wifi_set_mode(WIFI_MODE_STA) : result;
    result = result == ESP_OK ? esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID,
                                                           &NetworkLink::on_wifi, this)
                              : result;
    result = result == ESP_OK ? esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP,
                                                           &NetworkLink::on_wifi, this)
                              : result;
    result = result == ESP_OK ? mdns_init() : result;
    if (result != ESP_OK) {
      ESP_LOGE(kTag, "Wi-Fi not initialised: %s", esp_err_to_name(result));
      return false;
    }
    initialised = true;
  }
  if (!wifi_started_) {
    if (esp_wifi_start() != ESP_OK) {
      return false;
    }
    wifi_started_ = true;
  }
  return true;
}

void NetworkLink::on_wifi(void* self, const char* base, std::int32_t id, void* data) {
  static_cast<void>(data);
  NetworkLink& link = *static_cast<NetworkLink*>(self);
  auto events = static_cast<EventGroupHandle_t>(link.wifi_events_);
  if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
    xEventGroupClearBits(events, kJoinFailed);
    xEventGroupSetBits(events, kGotAddress);
  } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
    xEventGroupClearBits(events, kGotAddress);
    xEventGroupSetBits(events, kJoinFailed);
    // A WebSocket over a lost association is down now, not at its next failed ping.
    if (link.client_ != nullptr && !link.down_posted_.exchange(true)) {
      link.post_state(false, link.client_generation_.load());
    }
  }
}

bool NetworkLink::join(const Order& order) {
  auto events = static_cast<EventGroupHandle_t>(wifi_events_);
  wifi_config_t config{};
  std::copy_n(order.wifi_name.begin(), order.wifi_name_size, config.sta.ssid);
  std::copy_n(order.wifi_password.begin(), order.wifi_password_size, config.sta.password);
  wifi_config_t current{};
  const bool same =
      esp_wifi_get_config(WIFI_IF_STA, &current) == ESP_OK &&
      std::memcmp(current.sta.ssid, config.sta.ssid, sizeof(config.sta.ssid)) == 0 &&
      std::memcmp(current.sta.password, config.sta.password, sizeof(config.sta.password)) == 0;
  if (same && (xEventGroupGetBits(events) & kGotAddress) != 0) {
    return true;  // still associated with an address
  }
  static_cast<void>(esp_wifi_disconnect());
  xEventGroupClearBits(events, kGotAddress | kJoinFailed);
  if (esp_wifi_set_config(WIFI_IF_STA, &config) != ESP_OK || esp_wifi_connect() != ESP_OK) {
    return false;
  }
  const EventBits_t bits = xEventGroupWaitBits(events, kGotAddress | kJoinFailed, pdFALSE, pdFALSE,
                                               pdMS_TO_TICKS(kJoinMs));
  if ((bits & kGotAddress) == 0) {
    static_cast<void>(esp_wifi_disconnect());
    ESP_LOGW(kTag, "Wi-Fi join failed");
    return false;
  }
  return true;
}

bool NetworkLink::find_hub(const protocol::HubIdentity& hub, std::array<char, 64>& uri) {
  mdns_result_t* results = nullptr;
  if (mdns_query_ptr("_hsn-hub", "_tcp", kLookupMs, kLookupResults, &results) != ESP_OK) {
    return false;
  }
  bool found = false;
  for (const mdns_result_t* result = results; result != nullptr && !found; result = result->next) {
    bool ours = false;
    for (std::size_t i = 0; i < result->txt_count && !ours; ++i) {
      const mdns_txt_item_t& item = result->txt[i];
      const std::size_t length = result->txt_value_len != nullptr ? result->txt_value_len[i] : 0;
      ours = item.key != nullptr && std::strcmp(item.key, "id") == 0 && item.value != nullptr &&
             same_identity(item.value, length, hub);
    }
    if (!ours || result->port == 0) {
      continue;
    }
    esp_ip4_addr_t address{};
    bool have_address = false;
    for (const mdns_ip_addr_t* entry = result->addr; entry != nullptr && !have_address;
         entry = entry->next) {
      if (entry->addr.type == ESP_IPADDR_TYPE_V4) {
        address = entry->addr.u_addr.ip4;
        have_address = true;
      }
    }
    if (!have_address && result->hostname != nullptr) {
      have_address = mdns_query_a(result->hostname, kLookupMs, &address) == ESP_OK;
    }
    if (have_address) {
      std::snprintf(uri.data(), uri.size(), "ws://" IPSTR ":%u/device", IP2STR(&address),
                    static_cast<unsigned>(result->port));
      found = true;
    }
  }
  mdns_query_results_free(results);
  if (!found) {
    ESP_LOGW(kTag, "the paired hub was not found by mDNS");
  }
  return found;
}

void NetworkLink::attempt(const Order& order) {
  const std::uint32_t generation = order.generation;
  if (!start_wifi() || !join(order)) {
    post_state(false, generation);
    return;
  }
  std::array<char, 64> uri{};
  if (!current(generation)) {
    return;
  }
  if (!find_hub(order.hub, uri)) {
    post_state(false, generation);
    return;
  }
  if (!current(generation)) {
    return;
  }
  esp_websocket_client_config_t config{};
  config.uri = uri.data();
  config.disable_auto_reconnect = true;
  config.buffer_size = kClientBuffer;
  config.ping_interval_sec = static_cast<std::size_t>(kPingSeconds);
  config.pingpong_timeout_sec = kDeadSeconds;
  config.network_timeout_ms = kNetworkTimeoutMs;
  config.task_stack = static_cast<int>(kTaskStack);
  config.task_prio = static_cast<int>(kTaskPriority);
  xSemaphoreTake(static_cast<SemaphoreHandle_t>(client_lock_), portMAX_DELAY);
  esp_websocket_client_handle_t client = esp_websocket_client_init(&config);
  bool started = false;
  if (client != nullptr) {
    client_generation_.store(generation);
    down_posted_.store(false);
    client_ = client;
    started = esp_websocket_register_events(client, WEBSOCKET_EVENT_ANY, &NetworkLink::on_websocket,
                                            this) == ESP_OK &&
              esp_websocket_client_start(client) == ESP_OK;
  }
  xSemaphoreGive(static_cast<SemaphoreHandle_t>(client_lock_));
  if (!started) {
    close_client();
    post_state(false, generation);
  }
}

void NetworkLink::close_client() {
  xSemaphoreTake(static_cast<SemaphoreHandle_t>(client_lock_), portMAX_DELAY);
  auto client = static_cast<esp_websocket_client_handle_t>(client_);
  if (client != nullptr) {
    // Stopped by us: no down follows (link.hpp, disconnect); the generation is already old.
    down_posted_.store(true);
    static_cast<void>(esp_websocket_client_stop(client));
    static_cast<void>(esp_websocket_client_destroy(client));
    client_ = nullptr;
  }
  xSemaphoreGive(static_cast<SemaphoreHandle_t>(client_lock_));
  if (assembling_ >= 0) {
    slots_.release(assembling_);
  }
  assembling_ = -1;
}

void NetworkLink::on_websocket(void* self, const char* base, std::int32_t id, void* data) {
  static_cast<void>(base);
  NetworkLink& link = *static_cast<NetworkLink*>(self);
  const auto* event = static_cast<const esp_websocket_event_data_t*>(data);
  const std::uint32_t generation = link.client_generation_.load();
  switch (id) {
    case WEBSOCKET_EVENT_CONNECTED:
      link.post_state(true, generation);
      break;
    case WEBSOCKET_EVENT_DATA:
      if (event != nullptr) {
        link.received(event->data_ptr, event->data_len, event->payload_offset, event->payload_len,
                      event->op_code);
      }
      break;
    case WEBSOCKET_EVENT_DISCONNECTED:
    case WEBSOCKET_EVENT_ERROR:
    case WEBSOCKET_EVENT_CLOSED:
      if (!link.down_posted_.exchange(true)) {
        link.post_state(false, generation);
      }
      break;
    default:
      break;
  }
}

void NetworkLink::received(const char* data, int length, int offset, int total,
                           std::uint8_t opcode) {
  // Binary messages only, and their continuations; pings, pongs, closes and text are not packets.
  if (opcode != WS_TRANSPORT_OPCODES_BINARY && opcode != WS_TRANSPORT_OPCODES_CONT) {
    return;
  }
  if (length < 0 || offset < 0 || total <= 0) {
    return;
  }
  if (offset == 0) {
    if (assembling_ >= 0) {
      slots_.release(assembling_);
    }
    // A message over 1,024 bytes is no packet: dropped, all its pieces with it.
    assembling_ = static_cast<std::size_t>(total) <= LinkSlots::kSlotSize ? slots_.claim() : -1;
  }
  const bool last = offset + length >= total;
  if (assembling_ < 0 || static_cast<std::size_t>(offset + length) > LinkSlots::kSlotSize) {
    if (last && assembling_ >= 0) {
      slots_.release(assembling_);
      assembling_ = -1;
    }
    return;
  }
  std::copy_n(reinterpret_cast<const std::uint8_t*>(data), length,
              slots_.data(assembling_) + offset);
  if (!last) {
    return;
  }
  slots_.set_size(assembling_, static_cast<std::size_t>(total));
  Message message;
  message.kind = MessageKind::link_packet;
  message.index = static_cast<std::uint8_t>(device::LinkKind::network);
  message.slot = static_cast<std::uint8_t>(assembling_);
  if (!queue_.post(message)) {
    slots_.release(assembling_);
  }
  assembling_ = -1;
}

}  // namespace hsn::esp
