#include "hsn/esp/bluetooth.hpp"

#include <algorithm>
#include <cstdio>
#include <cstdlib>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "hsn/protocol/transfer.hpp"

// ESP-IDF's inline os_mbuf tail-space calculation narrows its pointer difference.
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wconversion"
#include "host/ble_att.h"
#include "host/ble_gap.h"
#include "host/ble_gatt.h"
#include "host/ble_hs.h"
#include "host/ble_hs_mbuf.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "os/os_mbuf.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"
#pragma GCC diagnostic pop
#include "pairing_srp.hpp"
#include "protocomm_ble.h"
#include "protocomm_security2.h"

namespace {
std::atomic<bool> advertising_blocked{false};
std::atomic<std::int64_t> pairing_advert_end{0};
}  // namespace

extern "C" int __real_ble_gap_adv_start(std::uint8_t own_addr_type, const ble_addr_t* peer,
                                        std::int32_t duration, const ble_gap_adv_params* params,
                                        ble_gap_event_fn* callback, void* arg);

/** Lets stock protocomm advertise only inside our pairing window, including on disconnect. */
extern "C" int __wrap_ble_gap_adv_start(std::uint8_t own_addr_type, const ble_addr_t* peer,
                                        std::int32_t duration, const ble_gap_adv_params* params,
                                        ble_gap_event_fn* callback, void* arg) {
  const auto end = pairing_advert_end.load();
  if (advertising_blocked.load() || (end != 0 && esp_timer_get_time() >= end)) {
    return BLE_HS_EDISABLED;
  }
  return __real_ble_gap_adv_start(own_addr_type, peer, duration, params, callback, arg);
}

namespace hsn::esp {
namespace {

constexpr const char* kTag = "hsn.bluetooth";
constexpr auto kNone = BLE_HS_CONN_HANDLE_NONE;
constexpr auto kLink = static_cast<std::uint8_t>(device::LinkKind::bluetooth);
constexpr auto kDoneGrace = device::milliseconds(200);  // ‡ Allow the Done notification out.
constexpr auto kReplyGrace = device::seconds(10);       // ‡ Allow the Provision response read.
constexpr auto kProofGrace =
    device::milliseconds(500);  // ‡ Bench check fifth ATT error precedes disconnect.
constexpr std::uint16_t kPreferredMtu = 517;
constexpr std::size_t kPairReply = 32;
constexpr std::int32_t kProofBarrier = 1;
constexpr const char* kVersionName = "proto-ver";
constexpr const char* kSessionName = "prov-session";
constexpr const char* kSetupName = "hsn-setup";
Bluetooth* owner = nullptr;

ESP_EVENT_DEFINE_BASE(HSN_BLUETOOTH_EVENT);

/** Turns an LE UUID array into NimBLE's GATT representation. */
constexpr ble_uuid128_t uuid_of(const Uuid& bytes) {
  ble_uuid128_t uuid{};
  uuid.u.type = BLE_UUID_TYPE_128;
  for (std::size_t i = 0; i < bytes.size(); ++i) {
    uuid.value[i] = bytes[i];
  }
  return uuid;
}

constexpr auto kService = uuid_of(kUpdateUuid);
constexpr auto kRx = uuid_of({0x4f, 0xda, 0xce, 0x88, 0xd0, 0x38, 0x04, 0xb6, 0x7e, 0x4f, 0xc5,
                              0x78, 0x59, 0x8f, 0x84, 0x9e});
constexpr auto kTx = uuid_of({0x40, 0xd8, 0xbc, 0x87, 0x38, 0xe1, 0x80, 0x95, 0xfe, 0x4c, 0xb9,
                              0xe0, 0x6e, 0x8c, 0x21, 0x0a});

/** Runs NimBLE until the main task drains and stops the port. */
void run_host(void*) {
  nimble_port_run();
  nimble_port_freertos_deinit();
}

/** Logs only aggregate internal heap, for measurements with each service active. */
void heap_at(const char* stage) {
  ESP_LOGI(kTag, "%s: free internal heap %u bytes, minimum %u", stage,
           static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)),
           static_cast<unsigned>(
               heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)));
}

}  // namespace

Bluetooth::Bluetooth(EventQueue& queue, device::Storage& storage, device::RetainedMemory& retained,
                     const device::BuildInfo& build)
    : queue_(queue), storage_(storage), retained_(retained), build_(build) {}

/** Registers the event bases used by the stock protocomm transport and security layer. */
bool Bluetooth::begin() {
  exchanged_ = xSemaphoreCreateBinaryStatic(&exchange_storage_);
  barrier_ = xSemaphoreCreateBinaryStatic(&barrier_storage_);
  const esp_err_t loop = esp_event_loop_create_default();
  if (loop != ESP_OK && loop != ESP_ERR_INVALID_STATE) {
    return false;
  }
  // Protocomm's debug dumps contain secrets, including in an otherwise verbose bench image.
  esp_log_level_set("security2", ESP_LOG_INFO);
  esp_log_level_set("srp6a", ESP_LOG_INFO);
  owner = this;
  ready_ = esp_event_handler_register(PROTOCOMM_TRANSPORT_BLE_EVENT, ESP_EVENT_ANY_ID,
                                      &Bluetooth::on_pair_event, this) == ESP_OK &&
           esp_event_handler_register(PROTOCOMM_SECURITY_SESSION_EVENT, ESP_EVENT_ANY_ID,
                                      &Bluetooth::on_pair_event, this) == ESP_OK &&
           esp_event_handler_register(HSN_BLUETOOTH_EVENT, kProofBarrier, &Bluetooth::on_pair_event,
                                      this) == ESP_OK;
  return ready_;
}

/** Checks flash at the point of use so USB pairing and this adapter see the same state. */
bool Bluetooth::unpaired() {
  device::SetupService setup(storage_, build_);
  return setup.load() == device::HalError::none && !setup.paired();
}

bool Bluetooth::reset_unpaired() {
  device::SetupService setup(storage_, build_);
  if (setup.load() != device::HalError::none || setup.paired()) {
    return false;
  }
  const bool stopped = stop();
  if (setup.factory_reset() != device::HalError::none) {
    if (!stopped) {
      ESP_LOGW(kTag, "setup-only factory reset failed before Bluetooth recovery restart");
    }
    return !stopped;
  }
  auto bytes = retained_.block();
  std::fill_n(bytes.begin(), std::min(bytes.size(), std::size_t{4}), 0);
  return true;
}

/** Starts the stock transport with its legacy flags/UUID and Complete Local Name scan response. */
bool Bluetooth::pair(device::Instant now, const PairCode& code) {
  if (!ready_ || want_update_ || mode_ != Mode::off) {
    return false;
  }
  device::SetupService setup(storage_, build_);
  if (setup.load() != device::HalError::none || setup.paired() || setup.role() == 0 ||
      !make_credentials(code, credentials_)) {
    return false;
  }

  const auto chip = hex_of(build_.chip_id);
  const auto& v = build_.version;
  char version[100];
  std::snprintf(version, sizeof(version),
                R"({"v":"hsn-pair/1","role":%u,"chip":"%s","firmware":"%u.%u.%u","sec":2})",
                setup.role(), chip.data(), v.major, v.minor, v.patch);
  protocomm_ble_name_uuid_t endpoints[] = {
      {kVersionName, 0xff53}, {kSessionName, 0xff51}, {kSetupName, 0xff60}};
  protocomm_ble_config_t config{};
  const auto advert = pair_advert(build_.chip_id);
  std::copy_n(advert.name.begin(), advert.name_size + 1, config.device_name);
  std::copy(kPairUuid.begin(), kPairUuid.end(), config.service_uuid);
  config.nu_lookup_count = std::size(endpoints);
  config.nu_lookup = endpoints;

  pair_ = protocomm_new();
  security_ = protocomm_security2;
  security_.security_req_handler = &Bluetooth::authenticate;
  window_.open(now);
  pair_lockout_ = false;
  pair_connected_ = false;
  had_pair_connection_ = false;
  portENTER_CRITICAL(&exchange_lock_);
  accepting_ = true;
  portEXIT_CRITICAL(&exchange_lock_);

  advertising_blocked = false;
  pairing_advert_end = esp_timer_get_time() + device::seconds(120).us;
  if (pair_ == nullptr || protocomm_set_version(pair_, kVersionName, version) != ESP_OK ||
      protocomm_set_security(pair_, kSessionName, &security_, &credentials_) != ESP_OK ||
      protocomm_add_endpoint(pair_, kSetupName, &Bluetooth::pair_request, this) != ESP_OK ||
      protocomm_ble_start(pair_, &config) != ESP_OK) {
    static_cast<void>(take_exchange(true));
    if (pair_ != nullptr) {
      protocomm_delete(pair_);
      pair_ = nullptr;
    }
    pairing_advert_end = 0;
    free_credentials(credentials_);
    ESP_LOGW(kTag, "pairing did not start");
    return false;
  }
  mode_ = Mode::pairing;
  heap_at("pairing started");
  return true;
}

/** Orders Security 2's failure event before the host can process another proof. */
esp_err_t Bluetooth::authenticate(protocomm_security_handle_t handle, const void* params,
                                  std::uint32_t conn, const std::uint8_t* input, ssize_t size,
                                  std::uint8_t** output, ssize_t* written, void* arg) {
  // The security handler's private argument is pc; our params are owned by the sole peripheral.
  auto& self = *owner;
  if (self.pair_lockout_.load()) {
    return ESP_ERR_INVALID_STATE;
  }
  const esp_err_t result = protocomm_security2.security_req_handler(handle, params, conn, input,
                                                                    size, output, written, arg);
  if (result != ESP_OK) {
    // The ESP event loop delivers CredentialsMismatch before this later marker. Keep the
    // callback on the host until the count is current, so pipelined writes cannot race it.
    if (esp_event_post(HSN_BLUETOOTH_EVENT, kProofBarrier, nullptr, 0, pdMS_TO_TICKS(100)) !=
            ESP_OK ||
        xSemaphoreTake(self.barrier_, pdMS_TO_TICKS(100)) != pdTRUE) {
      advertising_blocked = true;
      self.pair_lockout_ = true;
    }
  }
  return result;
}

/** Observes protocomm transport changes and counts only Security 2 credential mismatches. */
void Bluetooth::on_pair_event(void* arg, esp_event_base_t base, std::int32_t id, void*) {
  auto& self = *static_cast<Bluetooth*>(arg);
  if (base == HSN_BLUETOOTH_EVENT) {
    xSemaphoreGive(self.barrier_);
    return;
  }
  if (base == PROTOCOMM_TRANSPORT_BLE_EVENT) {
    self.pair_connected_ = id == PROTOCOMM_TRANSPORT_BLE_CONNECTED;
  } else if (id == PROTOCOMM_SECURITY_SESSION_CREDENTIALS_MISMATCH) {
    if (self.window_.mismatch()) {
      advertising_blocked = true;
      self.pair_lockout_ = true;
    }
  }
  self.wake();
}

/** Publishes a single already-authenticated request for the main task's SetupService. */
esp_err_t Bluetooth::pair_request(std::uint32_t, const std::uint8_t* input, ssize_t size,
                                  std::uint8_t** output, ssize_t* written, void* arg) {
  auto& self = *static_cast<Bluetooth*>(arg);
  if (size <= 0 || size > 496) {
    return ESP_ERR_INVALID_SIZE;
  }
  auto* reply = static_cast<std::uint8_t*>(std::malloc(kPairReply));
  if (reply == nullptr) {
    return ESP_ERR_NO_MEM;
  }
  Exchange exchange{protocol::ByteView(input, static_cast<std::size_t>(size)),
                    protocol::MutableByteView(reply, kPairReply)};
  portENTER_CRITICAL(&self.exchange_lock_);
  const bool accepted = self.accepting_ && !self.pair_lockout_.load();
  if (accepted) {
    self.exchange_ = &exchange;
  }
  portEXIT_CRITICAL(&self.exchange_lock_);
  if (accepted) {
    self.wake();
    xSemaphoreTake(self.exchanged_, portMAX_DELAY);
  }
  if (exchange.written == 0) {
    std::free(reply);
    return ESP_ERR_INVALID_STATE;
  }
  *output = reply;
  *written = static_cast<ssize_t>(exchange.written);
  return ESP_OK;
}

/** Drains the mailbox under the same lock used to publish a request and close the gate. */
Bluetooth::Exchange* Bluetooth::take_exchange(bool close) {
  portENTER_CRITICAL(&exchange_lock_);
  if (close) {
    accepting_ = false;
  }
  Exchange* exchange = exchange_;
  exchange_ = nullptr;
  portEXIT_CRITICAL(&exchange_lock_);
  return exchange;
}

/** Handles decrypted setup on the main task, serialized with USB setup and role events. */
void Bluetooth::finish_setup(device::Instant now, device::LogBuffer& log) {
  Exchange* exchange = take_exchange(false);
  if (exchange == nullptr) {
    return;
  }
  device::SetupService setup(storage_, build_);
  if (setup.load() == device::HalError::none && !setup.paired() && !pair_lockout_.load()) {
    const auto result = setup.handle(kind(), exchange->input, exchange->output, log, now);
    exchange->written = result.reply_size;
    if (result.action == device::SetupAction::restart) {
      auto bytes = retained_.block();
      std::fill_n(bytes.begin(), std::min(bytes.size(), std::size_t{4}), 0);
      advertising_blocked = true;
      provision_restart_ = true;
      proof_close_due_ = now + kReplyGrace;
      static_cast<void>(take_exchange(true));
    }
  }
  xSemaphoreGive(exchanged_);
}

/** Advances main-task lifecycle deadlines and applies pending setup writes. */
bool Bluetooth::poll(device::Instant now, device::LogBuffer& log) {
  if (mode_ == Mode::pairing) {
    const bool connected = pair_connected_.load();
    had_pair_connection_ = had_pair_connection_ || connected;
    if (provision_restart_ && ((had_pair_connection_ && !connected) || now >= proof_close_due_)) {
      static_cast<void>(stop());
      return true;
    }
    if (pair_lockout_.load()) {
      if (proof_close_due_.is_never()) {
        proof_close_due_ = now + kProofGrace;
      }
      if (!connected || now >= proof_close_due_) {
        return !stop();
      }
    } else if (!provision_restart_ && window_.expired(now, connected)) {
      return !stop();
    } else {
      finish_setup(now, log);
    }
  }
  if (close_due_ == device::Instant{}) {
    close_due_ = now + kDoneGrace;
  }
  if (mode_ == Mode::update && (now >= close_due_ || update_failed_.load())) {
    const bool failed = update_failed_.load();
    const bool reopen = want_update_ && !failed;
    if (!stop()) {
      return true;
    }
    want_update_ = reopen;
    if (failed) {
      static_cast<void>(post(MessageKind::link_down, generation_.load()));
    }
  }
  if (mode_ == Mode::off && want_update_ && !start_update()) {
    want_update_ = false;
    static_cast<void>(post(MessageKind::link_down, generation_.load()));
  }
  return false;
}

/** Gives the waiter the next deadline instead of holding it in the BLE stack. */
device::Instant Bluetooth::due() const {
  if (mode_ == Mode::pairing) {
    if (!proof_close_due_.is_never()) {
      return proof_close_due_;
    }
    return pair_connected_.load() ? device::Instant::never() : window_.end;
  }
  return close_due_;
}

/** Tears down the host and controller without irrevocably releasing Bluetooth memory. */
bool Bluetooth::stop() {
  want_update_ = false;
  if (mode_ == Mode::off) {
    return true;
  }
  advertising_blocked = true;
  if (mode_ == Mode::pairing) {
    if (take_exchange(true) != nullptr) {
      xSemaphoreGive(exchanged_);
    }
    if (protocomm_ble_stop(pair_) != ESP_OK) {
      ESP_LOGE(kTag, "pairing stop failed");
      return false;
    }
    protocomm_delete(pair_);
    pair_ = nullptr;
    pairing_advert_end = 0;
    free_credentials(credentials_);
  } else if (mode_ == Mode::update) {
    update_online_ = false;
    if (nimble_port_stop() != 0 || nimble_port_deinit() != ESP_OK) {
      ESP_LOGE(kTag, "update Bluetooth stop failed");
      return false;
    }
  }
  advertising_blocked = false;
  payload_ = 0;
  conn_ = kNone;
  mode_ = Mode::off;
  close_due_ = proof_close_due_ = device::Instant::never();
  generation_.fetch_add(1);
  heap_at("Bluetooth stopped");
  return true;
}

/** True during stack start, advertising, transfer or shutdown. */
bool Bluetooth::active() const {
  return mode_ != Mode::off || want_update_;
}

/** Drives only the pairing-window LED, without using the panel. */
bool Bluetooth::pairing() const {
  return mode_ == Mode::pairing && !pair_lockout_.load() && !provision_restart_;
}

/** Queues an update window for the address stored by setup. */
device::HalError Bluetooth::connect(const device::LinkTarget&) {
  if (!ready_ || mode_ == Mode::pairing) {
    return device::HalError::busy;
  }
  device::SetupService setup(storage_, build_);
  if (setup.load() != device::HalError::none || !setup.paired()) {
    return device::HalError::invalid;
  }
  // An existing host owns advert_ until its callbacks have stopped.
  if (mode_ == Mode::off) {
    advert_ = update_advert(setup.pairing().address);
  }
  want_update_ = true;
  return device::HalError::none;
}

/** Invalidates old receive events immediately; leaves time for a queued Done notification. */
void Bluetooth::disconnect() {
  want_update_ = false;
  if (mode_ != Mode::update || !close_due_.is_never()) {
    return;
  }
  update_online_ = false;
  payload_ = 0;
  generation_.fetch_add(1);
  // poll() starts this grace on the main task's monotonic clock.
  close_due_ = {};
}

/** Hands one complete notification to NimBLE, which owns its mbuf from then on. */
device::HalError Bluetooth::send(protocol::ByteView packet) {
  const auto conn = conn_.load();
  const auto max = largest_packet();
  if (conn == kNone || max == 0) {
    return device::HalError::io;
  }
  if (!update_packet_fits(max, packet.size()) || packet[0] != protocol::kTransferMarker) {
    return device::HalError::invalid;
  }
  auto* data = ble_hs_mbuf_from_flat(packet.data(), static_cast<std::uint16_t>(packet.size()));
  if (data == nullptr) {
    return device::HalError::busy;
  }
  const int result = ble_gatts_notify_custom(conn, tx_attr_, data);
  return result == 0 ? device::HalError::none : device::HalError::io;
}

/** Populates the single update GATT service, with separate write and notify characteristics. */
bool Bluetooth::start_update() {
  static ble_gatt_chr_def chars[3]{};
  static ble_gatt_svc_def services[2]{};
  if (nimble_port_init() != ESP_OK) {
    return false;
  }
  chars[0].uuid = &kRx.u;
  chars[0].flags = BLE_GATT_CHR_F_WRITE_NO_RSP;
  chars[0].access_cb = &Bluetooth::update_write;
  chars[0].arg = this;
  chars[1].uuid = &kTx.u;
  chars[1].flags = BLE_GATT_CHR_F_NOTIFY;
  chars[1].access_cb = &Bluetooth::update_write;
  chars[1].arg = this;
  chars[1].val_handle = &tx_attr_;
  services[0].type = BLE_GATT_SVC_TYPE_PRIMARY;
  services[0].uuid = &kService.u;
  services[0].characteristics = chars;
  ble_svc_gap_init();
  ble_svc_gatt_init();
  if (ble_svc_gap_device_name_set(advert_.name.data()) != 0 || ble_gatts_count_cfg(services) != 0 ||
      ble_gatts_add_svcs(services) != 0 || ble_att_set_preferred_mtu(kPreferredMtu) != 0) {
    static_cast<void>(nimble_port_deinit());
    return false;
  }
  update_generation_ = generation_.load();
  update_online_ = true;
  update_failed_ = false;
  subscribed_ = false;
  mode_ = Mode::update;
  ble_hs_cfg.sync_cb = &Bluetooth::update_sync;
  if (esp_nimble_enable(reinterpret_cast<void*>(&run_host)) != ESP_OK) {
    static_cast<void>(nimble_port_deinit());
    update_online_ = false;
    mode_ = Mode::off;
    return false;
  }
  heap_at("update started");
  return true;
}

/** Advertises only after NimBLE has synchronized with the controller. */
void Bluetooth::update_sync() {
  owner->advertise_update();
}

/** Sets the exact two legacy payloads and opens one connectable peripheral advertisement. */
void Bluetooth::advertise_update() {
  if (!update_online_.load()) {
    return;
  }
  std::uint8_t addr = 0;
  ble_gap_adv_params params{};
  params.conn_mode = BLE_GAP_CONN_MODE_UND;
  params.disc_mode = BLE_GAP_DISC_MODE_GEN;
  const auto response = advert_.response();
  if (ble_hs_id_infer_auto(0, &addr) != 0 ||
      ble_gap_adv_set_data(advert_.data.data(), static_cast<int>(advert_.data.size())) != 0 ||
      ble_gap_adv_rsp_set_data(response.data(), static_cast<int>(advert_.name_size + 2)) != 0 ||
      ble_gap_adv_start(addr, nullptr, BLE_HS_FOREVER, &params, &Bluetooth::update_gap, this) !=
          0) {
    update_failed_ = true;
    wake();
  }
}

/** Publishes subscription state only after publishing the agreed ATT payload. */
void Bluetooth::update_subscription(std::uint16_t mtu) {
  const auto before = payload_.exchange(update_payload(mtu));
  if (before == 0 && !post(MessageKind::link_up, update_generation_)) {
    update_failed_ = true;
    wake();
  }
}

/** Posts a single down when a usable subscription goes away. */
void Bluetooth::update_lost() {
  subscribed_ = false;
  if (payload_.exchange(0) != 0 && !post(MessageKind::link_down, update_generation_)) {
    update_failed_ = true;
    wake();
  }
}

/** Tracks a single connection, its ATT MTU and the tx notification subscription. */
int Bluetooth::update_gap(ble_gap_event* event, void* arg) {
  auto& self = *static_cast<Bluetooth*>(arg);
  if (!self.update_online_.load()) {
    return 0;
  }
  switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
      if (event->connect.status == 0) {
        self.conn_ = event->connect.conn_handle;
      } else {
        self.advertise_update();
      }
      break;
    case BLE_GAP_EVENT_DISCONNECT:
      self.conn_ = kNone;
      self.update_lost();
      self.advertise_update();
      break;
    case BLE_GAP_EVENT_SUBSCRIBE:
      if (event->subscribe.attr_handle == self.tx_attr_) {
        if (event->subscribe.cur_notify != 0) {
          self.subscribed_ = true;
          self.update_subscription(ble_att_mtu(event->subscribe.conn_handle));
        } else {
          self.update_lost();
        }
      }
      break;
    case BLE_GAP_EVENT_MTU:
      if (self.subscribed_) {
        self.update_subscription(event->mtu.value);
      }
      break;
    case BLE_GAP_EVENT_ADV_COMPLETE:
      self.advertise_update();
      break;
    default:
      break;
  }
  return 0;
}

/** Flattens a single incoming ATT write into a receive slot, without retaining any mbuf. */
int Bluetooth::update_write(std::uint16_t conn, std::uint16_t attr, ble_gatt_access_ctxt* access,
                            void* arg) {
  auto& self = *static_cast<Bluetooth*>(arg);
  if (access->op != BLE_GATT_ACCESS_OP_WRITE_CHR || attr == self.tx_attr_ ||
      conn != self.conn_.load() || !self.update_online_.load()) {
    return BLE_ATT_ERR_WRITE_NOT_PERMITTED;
  }
  const auto max = self.largest_packet();
  const auto size = OS_MBUF_PKTLEN(access->om);
  if (!update_packet_fits(max, size)) {
    return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
  }
  const int slot = self.slots_.claim();
  if (slot < 0) {
    return BLE_ATT_ERR_INSUFFICIENT_RES;
  }
  std::uint16_t copied = 0;
  auto* bytes = self.slots_.data(slot);
  if (ble_hs_mbuf_to_flat(access->om, bytes, size, &copied) != 0 || copied != size ||
      bytes[0] != protocol::kTransferMarker) {
    self.slots_.release(slot);
    return BLE_ATT_ERR_INVALID_PDU;
  }
  self.slots_.set_size(slot, size);
  if (!self.post(MessageKind::link_packet, self.update_generation_,
                 static_cast<std::uint8_t>(slot))) {
    self.slots_.release(slot);
    return BLE_ATT_ERR_INSUFFICIENT_RES;
  }
  return 0;
}

/** Posts a link event through the platform queue, tagged with its update-window generation. */
bool Bluetooth::post(MessageKind kind, std::uint32_t generation, std::uint8_t slot) {
  Message message;
  message.kind = kind;
  message.index = kLink;
  message.slot = slot;
  message.generation = generation;
  return queue_.post(message);
}

/** Interrupts the waiter's queue sleep for work that has no core event. */
void Bluetooth::wake() {
  static_cast<void>(post(MessageKind::deadline, generation_.load()));
}

}  // namespace hsn::esp
