// The test hub's update rules (m3-updates-design.md sections 4 and 5): images it signs, offers,
// serving Gets on granted links, update queries and statuses, the go-ahead, Started's image
// fields, a rollout's order, and Bluetooth sessions for a phone.

#include <algorithm>

#include "hsn/device/services/radio_plan.hpp"
#include "hsn/host/fake_update.hpp"
#include "hsn/host/provisioning.hpp"
#include "hsn/host/test_hub.hpp"
#include "hsn/protocol/checksum.hpp"

namespace hsn::host {
namespace {

bool same_version(const protocol::FirmwareVersion& a, const protocol::FirmwareVersion& b) {
  return a.major == b.major && a.minor == b.minor && a.patch == b.patch;
}

/** A version as the hub's decisions give it: major × 65,536 + minor × 256 + patch. */
std::int64_t version_value(const protocol::FirmwareVersion& version) {
  return std::int64_t{version.major} * 65536 + version.minor * 256 + version.patch;
}

bool in_progress(UpdateState state) {
  return state == UpdateState::offered || state == UpdateState::fetching ||
         state == UpdateState::verified || state == UpdateState::installing ||
         state == UpdateState::on_trial;
}

/** A refusal that is a hold, not a fault of the image or the store: no pause (section 4). */
bool is_hold(std::uint8_t reason) {
  return reason == protocol::UpdateReason::battery || reason == protocol::UpdateReason::armed ||
         reason == protocol::UpdateReason::no_wifi ||
         reason == protocol::UpdateReason::hub_not_found ||
         reason == protocol::UpdateReason::radio_busy || reason == protocol::UpdateReason::on_trial;
}

template <typename Frame>
Bytes encode_frame(const Frame& frame) {
  Bytes bytes(protocol::kTransferDataHeaderSize + protocol::kMaxTransferData);
  const auto size =
      protocol::encode_transfer(frame, protocol::MutableByteView(bytes.data(), bytes.size()));
  if (!size.ok()) {
    throw SimulationError("the test hub could not encode a transfer frame");
  }
  bytes.resize(size.value());
  return bytes;
}

}  // namespace

const char* update_state_name(UpdateState state) {
  switch (state) {
    case UpdateState::none:
      return "none";
    case UpdateState::planned:
      return "planned";
    case UpdateState::offered:
      return "offered";
    case UpdateState::fetching:
      return "fetching";
    case UpdateState::verified:
      return "verified";
    case UpdateState::installing:
      return "installing";
    case UpdateState::on_trial:
      return "on_trial";
    case UpdateState::confirmed:
      return "confirmed";
    case UpdateState::rolled_back:
      return "rolled_back";
    case UpdateState::refused:
      return "refused";
  }
  return "?";
}

const HubImage& TestHub::add_image(const Bytes& image_bytes, bool own_build) {
  const protocol::ByteView view(image_bytes.data(), image_bytes.size());
  HubImage held;
  held.header = signing_key_.header_for(view, own_build);
  // The identity the boards were paired with (Provisioning's), which a board checks the header's
  // against; the signature is then made again over it.
  held.header.hub_identity = Provisioning{}.hub_identity;
  signing_key_.sign(held.header);
  held.id = protocol::image_id_of(held.header);
  held.file = image_file(held.header, view);
  images_.push_back(std::move(held));
  return images_.back();
}

const HubImage* TestHub::image(const protocol::ImageId& id) const {
  for (const HubImage& held : images_) {
    if (held.id == id) {
      return &held;
    }
  }
  return nullptr;
}

const DeviceUpdate& TestHub::update_of(const std::string& name) const {
  return known(name).update;
}

void TestHub::offer_update(const std::string& name, const protocol::ImageId& id,
                           UpdateMethod method) {
  if (image(id) == nullptr) {
    throw SimulationError("the test hub holds no such image");
  }
  Known& device = known(name);
  const bool same = device.update.image == id && device.update.state != UpdateState::none;
  if (!same) {
    device.update = DeviceUpdate{};
    device.update.image = id;
  }
  device.update.method = method;
  device.update.state = UpdateState::planned;
  push_offer(static_cast<std::size_t>(&device - known_.data()));
}

BluetoothSession TestHub::open_bluetooth(const std::string& name, const protocol::ImageId& id) {
  const HubImage* held = image(id);
  if (held == nullptr) {
    throw SimulationError("the test hub holds no such image");
  }
  Known& device = known(name);
  BluetoothSession session;
  session.address = device.address;
  protocol::RandomValue nonce{};
  random_bytes(nonce);
  std::copy(nonce.begin(), nonce.end(), session.nonce.begin());
  session.session_key = derive_session_key(
      device.key, protocol::ByteView(session.nonce.data(), session.nonce.size()), device.address);
  session.window_units = options_.bluetooth_window_units;
  session.image = id;
  session.file = held->file;
  device.bluetooth = session;
  if (device.update.image != id || device.update.state == UpdateState::none) {
    device.update = DeviceUpdate{};
    device.update.image = id;
  }
  device.update.method = UpdateMethod::bluetooth;
  device.update.state = UpdateState::planned;
  return session;
}

void TestHub::go_ahead(const std::string& name) {
  known(name).update.allowed = true;
  push_go_aheads();
}

protocol::UpdateOffer TestHub::offer_for(const Known& device, std::uint8_t action) const {
  protocol::UpdateOffer offer;
  offer.action = action;
  const HubImage* held = image(device.update.image);
  if (held != nullptr && action != protocol::UpdateAction::nothing) {
    offer.image_id = held->id;
    offer.file_bytes = static_cast<std::uint32_t>(held->file.size());
    offer.version = held->header.version;
  }
  if (action == protocol::UpdateAction::open_bluetooth && device.bluetooth.has_value()) {
    offer.bluetooth_nonce = device.bluetooth->nonce;
    offer.bluetooth_window_units = device.bluetooth->window_units;
  }
  return offer;
}

bool TestHub::offer_waiting(std::size_t index) const {
  const Known& device = known_[index];
  const UpdateState state = device.update.state;
  return state == UpdateState::planned ||
         (state == UpdateState::verified && !device.update.go_ahead && may_install(index));
}

void TestHub::answer_sensor(std::size_t index, const Arrival& arrival, const Bytes& packet,
                            std::uint8_t type) {
  Known& sensor = known_[index];
  if (arrival.wire != nullptr) {
    send_link(sensor, *arrival.wire, packet, type);
    return;
  }
  const std::uint8_t data_rate =
      reply_rate(sensor, sensor.replied_version, arrival.data_rate, sensor.listening_at_send_rate);
  Downlink downlink;
  downlink.packet = packet;
  downlink.type = type;
  downlink.counter = sensor.next_counter - 1;
  downlink.to = index;
  downlink.data_rate = data_rate;
  downlink.ended_at = arrival.ended_at;
  downlink.gateway_time = arrival.gateway_time;
  downlink.gateway = arrival.gateway;
  const auto airtime = device::time_on_air(data_rate, packet.size());
  downlink.limited = true;
  downlink.offset = event_listen_time(arrival.data_rate) - airtime.value_or(device::Duration{});
  send_radio(downlink);
}

void TestHub::send_offer(std::size_t index, std::uint8_t action, const Arrival* answering,
                         std::uint32_t answered, LinkWire* wire) {
  Known& device = known_[index];
  const protocol::UpdateOffer offer = offer_for(device, action);
  LinkWire* used = nullptr;
  if (device.role == protocol::Role::sensor) {
    if (answering == nullptr) {
      return;  // a sensor is only ever answered (protocol section 4)
    }
    const Bytes packet = seal(device, offer, protocol::Binding::sensor_packet(answered),
                              protocol::PacketLimit::radio);
    answer_sensor(index, *answering, packet, protocol::message_type::update_offer);
    used = answering->wire;
  } else if (device.role == protocol::Role::siren) {
    LinkWire& network = device.device->wire(device::LinkKind::network);
    used = wire != nullptr ? wire : (network.connected() ? &network : nullptr);
    const Bytes packet =
        seal(device, offer, protocol::Binding::none(), protocol::PacketLimit::radio);
    if (used != nullptr) {
      send_link(device, *used, packet, protocol::message_type::update_offer);
    } else {
      Downlink downlink;
      downlink.packet = packet;
      downlink.type = protocol::message_type::update_offer;
      downlink.counter = device.next_counter - 1;
      downlink.to = index;
      downlink.data_rate = command_rate(device);
      downlink.gateway = device.best_gateway;
      send_radio(downlink);
    }
  } else {
    const Session& session = device.session;
    if (!session.open || session.wire == nullptr) {
      return;
    }
    used = session.wire;
    send_link(
        device, *used,
        seal(device, offer, protocol::Binding::session(session.gateway_random, session.hub_random),
             protocol::PacketLimit::link),
        protocol::message_type::update_offer);
  }
  decide(HubAction::firmware_offer, device.name, action);
  if (action == protocol::UpdateAction::fetch && used != nullptr) {
    grants_[used] = device.update.image;
  }
  if (action == protocol::UpdateAction::install_now) {
    device.update.go_ahead = true;
    decide(HubAction::firmware_installing, device.name, version_value(offer.version));
  }
  if (action == protocol::UpdateAction::open_bluetooth) {
    device.bluetooth.reset();
  }
  if ((action == protocol::UpdateAction::fetch ||
       action == protocol::UpdateAction::join_wifi_and_fetch ||
       action == protocol::UpdateAction::open_bluetooth) &&
      device.update.state == UpdateState::planned) {
    set_update_state(index, UpdateState::offered);
  }
}

void TestHub::push_offer(std::size_t index) {
  Known& device = known_[index];
  if (device.role == protocol::Role::sensor || device.update.state != UpdateState::planned ||
      device.update.method == UpdateMethod::bluetooth || device.rekey) {
    return;
  }
  if (device.role == protocol::Role::siren) {
    if (device.device->wire(device::LinkKind::network).connected()) {
      send_offer(index, protocol::UpdateAction::fetch, nullptr, 0, nullptr);
    }
    return;
  }
  if (device.session.open) {
    send_offer(index, protocol::UpdateAction::fetch, nullptr, 0, device.session.wire);
  }
}

bool TestHub::may_install(std::size_t index) const {
  const Known& device = known_[index];
  if (device.update.state != UpdateState::verified || device.rekey ||
      (!options_.auto_install && !device.update.allowed) || (rollout_.active && rollout_.paused)) {
    return false;
  }
  if (alarm_running()) {
    return false;
  }
  for (const Known& other : known_) {
    if (other.role == protocol::Role::sensor && other.countdown.active) {
      return false;
    }
  }
  if (device.role == protocol::Role::sensor) {
    return !device.armed;
  }
  for (const Known& other : known_) {
    if (&other == &device) {
      continue;
    }
    const bool installing = other.update.state == UpdateState::installing ||
                            other.update.state == UpdateState::on_trial;
    if (installing && other.role != protocol::Role::sensor) {
      return false;  // one siren or gateway at a time (D91)
    }
    if (installing && other.role == protocol::Role::sensor &&
        device.role == protocol::Role::gateway) {
      return false;  // the trials keep their path to the hub
    }
  }
  return true;
}

void TestHub::push_go_aheads() {
  for (std::size_t index = 0; index < known_.size(); ++index) {
    Known& device = known_[index];
    if (device.role != protocol::Role::sensor && !device.update.go_ahead && may_install(index)) {
      send_offer(index, protocol::UpdateAction::install_now, nullptr, 0, nullptr);
    }
  }
}

void TestHub::set_update_state(std::size_t index, UpdateState state) {
  Known& device = known_[index];
  if (device.update.state == state) {
    return;
  }
  device.update.state = state;
  if (state == UpdateState::confirmed) {
    const HubImage* held = image(device.update.image);
    decide(HubAction::firmware_confirmed, device.name,
           held == nullptr ? 0 : version_value(held->header.version));
  }
  advance_rollout();
  push_go_aheads();
}

bool TestHub::on_update_packet(std::size_t index, const Opened& opened, const Arrival& arrival,
                               LinkWire* wire) {
  Known& device = known_[index];
  const protocol::ByteView body(opened.body.data(), opened.body.size());
  const bool sensor = device.role == protocol::Role::sensor;
  DeviceUpdate& update = device.update;
  if (opened.type == protocol::message_type::update_query) {
    protocol::UpdateQuery query;
    static_cast<void>(protocol::decode_body(body, query));
    decide(HubAction::firmware_query, device.name, query.held);
    const bool planned = update.state != UpdateState::none && image(update.image) != nullptr;
    std::uint8_t action = protocol::UpdateAction::nothing;
    if (device.bluetooth.has_value()) {
      action = protocol::UpdateAction::open_bluetooth;
    } else if (!planned) {
      action = protocol::UpdateAction::nothing;
    } else if (query.held == protocol::UpdateHeld::verified && query.image_id == update.image) {
      // It holds the image verified and does not run it: whatever was said before, the install
      // is still to come (a go-ahead lost, or a restart that did not reach the new image).
      update.go_ahead = false;
      set_update_state(index, UpdateState::verified);
      action =
          may_install(index) ? protocol::UpdateAction::install_now : protocol::UpdateAction::wait;
    } else if (sensor && device.armed &&
               (update.state == UpdateState::planned || update.state == UpdateState::offered)) {
      action = protocol::UpdateAction::wait;  // held: armed (D91)
    } else if (wire != nullptr || !sensor) {
      action = protocol::UpdateAction::fetch;
    } else {
      action = protocol::UpdateAction::join_wifi_and_fetch;
    }
    send_offer(index, action, &arrival, opened.counter, wire);
    return true;
  }
  if (opened.type != protocol::message_type::update_status) {
    return false;
  }
  protocol::UpdateStatus status;
  static_cast<void>(protocol::decode_body(body, status));
  decide(HubAction::firmware_status, device.name, std::int64_t{status.stage} * 256 + status.reason);
  update.reason = status.reason;
  const bool ours = status.image_id == update.image && update.state != UpdateState::none;
  bool answered = false;
  switch (status.stage) {
    case protocol::UpdateStage::fetching:
      if (ours && (update.state == UpdateState::planned || update.state == UpdateState::offered)) {
        set_update_state(index, UpdateState::fetching);
      }
      break;
    case protocol::UpdateStage::verified:
      if (ours) {
        set_update_state(index, UpdateState::verified);
        if (sensor) {
          // Always answered: "install now" when the rules allow, else "wait" (section 5).
          send_offer(index,
                     may_install(index) ? protocol::UpdateAction::install_now
                                        : protocol::UpdateAction::wait,
                     &arrival, opened.counter, wire);
          answered = true;
        }
      }
      break;
    case protocol::UpdateStage::refused:
      decide(HubAction::firmware_refused, device.name, status.reason);
      if (ours) {
        set_update_state(index, UpdateState::refused);
        if (rollout_.active && !is_hold(status.reason) && !rollout_.paused) {
          rollout_.paused = true;
          rollout_.paused_reason = status.reason;
          decide(HubAction::rollout_paused, device.name, rollout_.id);
        }
      }
      break;
    case protocol::UpdateStage::installing:
      if (ours) {
        set_update_state(index, UpdateState::installing);
      }
      break;
    case protocol::UpdateStage::confirmed:
      if (ours) {
        set_update_state(index, UpdateState::confirmed);
      }
      break;
    case protocol::UpdateStage::cancelled:
      if (ours) {
        set_update_state(index, UpdateState::none);
      }
      break;
    default:
      break;
  }
  if (sensor && !answered) {
    // A sensor's status is always answered (section 5): a plain reply.
    reply_to_sensor(index, arrival, device.replied_version, opened.counter, false,
                    device.listening_at_send_rate);
  }
  return true;
}

void TestHub::on_update_started(std::size_t index, const protocol::Started& started) {
  Known& device = known_[index];
  DeviceUpdate& update = device.update;
  const HubImage* held = image(update.image);
  const bool flags = started.image.present;
  const bool on_trial = flags && started.image.fields.flags.on_trial;
  const bool rolled_back = flags && started.image.fields.flags.rolled_back;
  // After the go-ahead: the "installing" status may be lost in the restart it announces.
  const bool waiting = update.state == UpdateState::installing ||
                       update.state == UpdateState::on_trial ||
                       (update.state == UpdateState::verified && update.go_ahead);
  // A siren or gateway is offered its update when it connects, before its Started: only a
  // download under way is offered again. A sensor is offered only in answer to a query.
  const bool restarted_download =
      update.state == UpdateState::fetching ||
      (update.state == UpdateState::offered && device.role == protocol::Role::sensor);
  if (held != nullptr && !on_trial && !rolled_back && restarted_download) {
    // It started again in the middle of a download: the offer is made again (design section 4,
    // "After a hub restart"; the device resumes from its checkpoint or starts over).
    update.state = UpdateState::planned;
    push_offer(index);
    return;
  }
  if (held == nullptr || !waiting) {
    return;
  }
  if (rolled_back && !same_version(started.firmware_version, held->header.version)) {
    update.failed = started.image.fields.failed_version;
    decide(HubAction::firmware_rolled_back, device.name, version_value(update.failed));
    if (rollout_.active && !rollout_.paused) {
      rollout_.paused = true;
      rollout_.paused_reason = kRolledBackReason;
      decide(HubAction::rollout_paused, device.name, rollout_.id);
    }
    set_update_state(index, UpdateState::rolled_back);
    return;
  }
  if (!same_version(started.firmware_version, held->header.version)) {
    // Still the old image, and no rollback: the restart never reached the new one (a torn
    // otadata write). It holds the image verified: the go-ahead is to be given again.
    update.go_ahead = false;
    set_update_state(index, UpdateState::verified);
    return;
  }
  if (on_trial) {
    if (update.state != UpdateState::on_trial) {
      decide(HubAction::firmware_on_trial, device.name, version_value(held->header.version));
      set_update_state(index, UpdateState::on_trial);
    }
    if (device.role == protocol::Role::siren) {
      // A siren on trial is told to report now, on both paths (section 2).
      command_siren(device.name, protocol::SirenAction::report_now, 0);
    }
    return;
  }
  set_update_state(index, UpdateState::confirmed);
}

void TestHub::on_transfer_frame(std::size_t index, LinkWire& wire, const Bytes& frame) {
  const protocol::ByteView view(frame.data(), frame.size());
  static_cast<void>(protocol::decode_transfer(view, [&](const auto& decoded) {
    using Frame = std::decay_t<decltype(decoded)>;
    if constexpr (std::is_same_v<Frame, protocol::transfer::Get>) {
      answer_get(index, wire, decoded);
    }
  }));
}

void TestHub::send_frame(std::size_t index, LinkWire& wire, const Bytes& frame) {
  static_cast<void>(index);
  wire.send_to_device(frame);
}

void TestHub::answer_get(std::size_t index, LinkWire& wire, const protocol::transfer::Get& get) {
  Known& device = known_[index];
  HubTransfer served;
  served.at = sim_.now();
  served.device = device.name;
  served.offset = get.offset;
  served.length = get.length;
  const auto grant = grants_.find(&wire);
  const HubImage* held = image(get.image_id);
  std::uint8_t gone = 0xFF;
  if (held == nullptr) {
    gone = protocol::GoneReason::not_available;
  } else if (grant == grants_.end() || grant->second != get.image_id) {
    gone = protocol::GoneReason::not_granted;
  } else if (alarm_running() || std::any_of(known_.begin(), known_.end(), [](const Known& other) {
               return other.countdown.active;
             })) {
    gone = protocol::GoneReason::paused;  // every transfer pauses (section 4, R12)
  } else if (get.offset >= held->file.size()) {
    gone = protocol::GoneReason::out_of_range;
  }
  if (gone != 0xFF) {
    protocol::transfer::Gone answer;
    answer.image_id = get.image_id;
    answer.reason = gone;
    served.answer = protocol::transfer_kind::gone;
    served.gone_reason = gone;
    served.frame = encode_frame(answer);
    transfers_.push_back(served);
    send_frame(index, wire, served.frame);
    return;
  }
  const std::size_t length =
      std::min<std::size_t>(get.length, held->file.size() - static_cast<std::size_t>(get.offset));
  const protocol::ByteView data(held->file.data() + get.offset, length);
  protocol::transfer::Data answer;
  answer.image_id = get.image_id;
  answer.offset = get.offset;
  answer.crc32 = protocol::crc32(data);
  answer.data.bytes = data;
  served.answer = protocol::transfer_kind::data;
  served.frame = encode_frame(answer);
  transfers_.push_back(served);
  device.update.bytes_served += length;
  if (device.update.image == get.image_id && (device.update.state == UpdateState::offered ||
                                              device.update.state == UpdateState::planned)) {
    set_update_state(index, UpdateState::fetching);
  }
  send_frame(index, wire, served.frame);
}

void TestHub::rollout(const protocol::ImageId& id, const std::vector<std::string>& order,
                      const RolloutRules& rules) {
  if (image(id) == nullptr) {
    throw SimulationError("the test hub holds no such image");
  }
  for (const std::string& name : order) {
    static_cast<void>(known(name));
  }
  rollout_ = Rollout{};
  rollout_.id = next_rollout_++;
  rollout_.active = true;
  rollout_.image = id;
  rollout_.order = order;
  rollout_.rules = rules;
  rollout_.offered.assign(order.size(), false);
  advance_rollout();
}

void TestHub::resume_rollout() {
  rollout_.paused = false;
  rollout_.paused_reason = 0;
  advance_rollout();
  push_go_aheads();
}

bool TestHub::rollout_done() const {
  if (!rollout_.active) {
    return false;
  }
  for (const std::string& name : rollout_.order) {
    if (known(name).update.state != UpdateState::confirmed) {
      return false;
    }
  }
  return true;
}

void TestHub::advance_rollout() {
  // Offering moves states, which comes back here: run again instead of nesting.
  if (rollout_.advancing) {
    rollout_.again = true;
    return;
  }
  rollout_.advancing = true;
  do {
    rollout_.again = false;
    advance_rollout_once();
  } while (rollout_.again);
  rollout_.advancing = false;
}

void TestHub::advance_rollout_once() {
  if (!rollout_.active || rollout_.paused) {
    return;
  }
  if (rollout_done()) {
    if (!rollout_.done_recorded) {
      rollout_.done_recorded = true;
      decide(HubAction::rollout_done, "", rollout_.id);
    }
    return;
  }
  const std::size_t pilots = std::min(rollout_.rules.pilots, rollout_.order.size());
  // Pilots one at a time, each after the one before is confirmed.
  for (std::size_t i = 0; i < pilots; ++i) {
    Known& device = known(rollout_.order[i]);
    if (!rollout_.offered[i]) {
      rollout_.offered[i] = true;
      offer_update(device.name, rollout_.image);
      return;
    }
    if (device.update.state != UpdateState::confirmed) {
      return;
    }
  }
  // Then the soak, counted from the last pilot's confirmation.
  if (pilots > 0 && rollout_.rules.soak.us > 0) {
    if (rollout_.soak_until.is_never()) {
      rollout_.soak_until = sim_.now() + rollout_.rules.soak;
      sim_.schedule(rollout_.soak_until, [this]() { advance_rollout(); });
      return;
    }
    if (sim_.now() < rollout_.soak_until) {
      return;
    }
  }
  std::size_t sensors = 0;
  std::size_t others = 0;
  for (std::size_t i = 0; i < rollout_.order.size(); ++i) {
    const Known& device = known(rollout_.order[i]);
    if (rollout_.offered[i] &&
        (device.update.state == UpdateState::planned || in_progress(device.update.state))) {
      (device.role == protocol::Role::sensor ? sensors : others) += 1;
    }
  }
  for (std::size_t i = pilots; i < rollout_.order.size(); ++i) {
    if (rollout_.offered[i]) {
      continue;
    }
    const Known& device = known(rollout_.order[i]);
    if (device.role == protocol::Role::sensor) {
      if (sensors >= rollout_.rules.sensors_at_once) {
        continue;
      }
      sensors += 1;
    } else {
      if (others >= 1) {
        continue;
      }
      others += 1;
    }
    rollout_.offered[i] = true;
    offer_update(device.name, rollout_.image);
  }
}

}  // namespace hsn::host
