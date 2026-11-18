#include "hsn/host/script_phone.hpp"

#include <algorithm>
#include <type_traits>
#include <utility>

#include "hsn/protocol/checksum.hpp"

namespace hsn::host {
namespace {

template <typename Frame>
Bytes encode(const Frame& frame) {
  Bytes bytes(protocol::kTransferDataHeaderSize + protocol::kMaxTransferData);
  const auto size =
      protocol::encode_transfer(frame, protocol::MutableByteView(bytes.data(), bytes.size()));
  if (!size.ok()) {
    throw SimulationError("the scripted phone could not encode a frame");
  }
  bytes.resize(size.value());
  return bytes;
}

}  // namespace

ScriptPhone::ScriptPhone(Scheduler& scheduler, LinkWire& wire, BluetoothSession session,
                         ScriptPhoneOptions options)
    : scheduler_(scheduler), wire_(wire), session_(std::move(session)), options_(options) {
  scheduler_.schedule(std::max(options_.arrives, scheduler_.now()), [this]() {
    attached_ = true;
    wire_.attach(*this, options_.latency);
  });
}

ScriptPhone::ScriptPhone(Simulation& sim, SimDevice& device, BluetoothSession session,
                         ScriptPhoneOptions options)
    : ScriptPhone(sim.scheduler(), device.wire(device::LinkKind::bluetooth), std::move(session),
                  options) {}

ScriptPhone::~ScriptPhone() {
  if (attached_) {
    wire_.detach();
  }
}

void ScriptPhone::send(const Bytes& frame) {
  if (frame.size() + 3 > options_.mtu) {
    oversize += 1;
  }
  wire_.send_to_device(frame);
}

void ScriptPhone::reconnect_later() {
  scheduler_.schedule(scheduler_.now() + options_.reconnect_after,
                      [this]() { static_cast<void>(wire_.peer_connect()); });
}

void ScriptPhone::link_up(LinkWire&) {
  connections += 1;
}

void ScriptPhone::link_down(LinkWire&) {
  disconnections += 1;
  // The board closed the connection but still advertises: connect again, as the app does.
  if (wire_.advertising() && !done.has_value()) {
    reconnect_later();
  }
}

void ScriptPhone::on_get(const protocol::transfer::Get& get) {
  const Bytes& file = session_.file;
  if (get.image_id != session_.image || get.offset >= file.size()) {
    protocol::transfer::Gone gone;
    gone.image_id = get.image_id;
    gone.reason = get.image_id != session_.image ? protocol::GoneReason::not_available
                                                 : protocol::GoneReason::out_of_range;
    gone_frames += 1;
    send(encode(gone));
    return;
  }
  const std::size_t length = std::min<std::size_t>(get.length, file.size() - get.offset);
  const protocol::ByteView data(file.data() + get.offset, length);
  protocol::transfer::Data answer;
  answer.image_id = get.image_id;
  answer.offset = get.offset;
  answer.crc32 = protocol::crc32(data);
  answer.data.bytes = data;
  data_frames += 1;
  if (options_.corrupt_data != 0 && data_frames == options_.corrupt_data) {
    answer.crc32 ^= 1u;
  }
  served_to = std::max(served_to, static_cast<std::uint32_t>(get.offset + length));
  send(encode(answer));
  if (options_.drop_after_data != 0 && data_frames == options_.drop_after_data && !dropped_once_) {
    // The connection goes once that frame has reached the board; nothing more is answered.
    dropped_once_ = true;
    dropping_ = true;
    scheduler_.schedule(scheduler_.now() + options_.latency + device::microseconds(1), [this]() {
      dropping_ = false;
      wire_.drop();
    });
  }
}

void ScriptPhone::link_packet(LinkWire&, const Bytes& packet) {
  if (packet.size() + 3 > options_.mtu) {
    oversize += 1;
  }
  const protocol::Error error = protocol::decode_transfer(
      protocol::ByteView(packet.data(), packet.size()), [&](const auto& frame) {
        using Frame = std::decay_t<decltype(frame)>;
        if constexpr (std::is_same_v<Frame, protocol::transfer::Hello>) {
          hellos.push_back(frame);
          protocol::transfer::Open open;
          // The address is the one the hub named, not the one the board claims.
          open.tag =
              open_tag(session_.session_key, session_.address, frame.device_random, frame.image_id);
          opens += 1;
          if (wrong_opens < options_.wrong_tags) {
            wrong_opens += 1;
            open.tag[0] ^= 0x80;
          }
          send(encode(open));
        } else if constexpr (std::is_same_v<Frame, protocol::transfer::Get>) {
          if (!dropping_) {
            on_get(frame);
          }
        } else if constexpr (std::is_same_v<Frame, protocol::transfer::Done>) {
          done = frame;
        } else {
          unexpected += 1;
        }
      });
  if (error != protocol::Error::none) {
    unexpected += 1;
  }
}

}  // namespace hsn::host
