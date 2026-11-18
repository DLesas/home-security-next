// The gateway's write gate and its busy bound (m3-updates-design.md section 5, "A site so busy that
// a transmission is always waiting"), the forced fetch of action 6 (protocol section 6, the update
// offer), and Device telling the service of every USB and network link's up and down.

#include <algorithm>

#include "update_bench.hpp"

namespace hsn::test::update {
namespace {

using device::UpdatePacketKind;
using device::UpdatePath;
using protocol::UpdateAction;
using protocol::UpdateReason;
using protocol::UpdateStage;

constexpr std::uint32_t kHeader = 128;
constexpr std::uint32_t kSector = 4096;

/** A gateway pulling over its network link, the hub serving it. */
struct Gateway {
  explicit Gateway(std::size_t size = 140000)
      : bench(options()),
        file(make_file(make_image({1, 1, 0}, size))),
        hub(bench, LinkKind::network, file.file()) {
    bench.boot();
    bench.network.is_up = true;
  }

  static BenchOptions options() {
    BenchOptions o;
    o.role = protocol::Role::gateway;
    return o;
  }

  void offer(std::uint8_t action) {
    bench.update().offer(make_offer(action, file), UpdatePath::network, bench.now);
  }

  std::size_t count(FlashOp::Kind kind) const {
    return static_cast<std::size_t>(
        std::count_if(bench.power.ops.begin(), bench.power.ops.end(),
                      [&](const FlashOp& op) { return op.kind == kind; }));
  }

  bool run_until_writes(std::size_t writes) {
    return run(bench, hub, [&] { return count(FlashOp::Kind::slot_write) >= writes; });
  }

  bool run_to(std::uint8_t stage) {
    return run(
        bench, hub, [&] { return has_stage(packets, stage); },
        [&](const device::UpdatePacket& p) { packets.push_back(p); });
  }

  std::uint32_t highest_asked() const {
    std::uint32_t highest = 0;
    for (const auto& get : hub.gets) {
      highest = std::max<std::uint32_t>(highest, get.offset + get.length);
    }
    return highest;
  }

  Bench bench;
  ImageFile file;
  Source hub;
  Packets packets;
};

TEST_CASE("held: no sector is written, and no more is asked than the two buffers hold") {
  Gateway g;
  g.offer(UpdateAction::fetch);
  REQUIRE(g.run_until_writes(3));
  g.bench.update().hold_writes(true, g.bench.now);
  g.hub.serve_all();
  const std::size_t erases = g.count(FlashOp::Kind::slot_erase);
  const std::size_t writes = g.count(FlashOp::Kind::slot_write);
  CHECK(writes == 3);
  CHECK(erases == 3);
  // Sectors 3 and 4 fill the buffers, and nothing past them is asked for.
  CHECK(g.highest_asked() == kHeader + 5 * kSector);
  // Nothing is out, so a quiet source is no lost link: five minutes pass without a word, even
  // with the role's events coming meanwhile.
  const std::size_t gets = g.hub.gets.size();
  const Instant held = g.bench.now;
  for (int minute = 1; minute <= 5; ++minute) {
    g.bench.now = held + device::seconds(60 * minute);
    g.bench.instance->runner.deliver(device::Event::timer_at(g.bench.now));
  }
  g.hub.serve_all();
  CHECK(g.hub.gets.size() == gets);
  CHECK_FALSE(g.bench.take_packet().has_value());
  CHECK(g.count(FlashOp::Kind::slot_write) == 3);
  CHECK(g.bench.update().active());
  // Released: both waiting sectors are written at once, and the pull goes on to the end.
  g.bench.update().hold_writes(false, g.bench.now);
  CHECK(g.count(FlashOp::Kind::slot_write) == 5);
  CHECK(g.count(FlashOp::Kind::slot_erase) == 5);
  REQUIRE(g.run_to(UpdateStage::verified));
  const Bytes& slot = g.bench.slots.bytes[static_cast<std::size_t>(g.bench.slots.other_slot())];
  CHECK(Bytes(slot.begin(), slot.begin() + 140000) == g.file.image);
}

TEST_CASE("a hold that keeps every write back for 10 minutes ends the fetch as radioBusy") {
  Gateway g;
  g.offer(UpdateAction::fetch);
  REQUIRE(g.run_until_writes(17));  // the checkpoint at 64 KB is written after the 16th
  const Instant written = g.bench.now;
  g.bench.update().hold_writes(true, written);
  g.hub.serve_all();
  const std::size_t ops = g.bench.power.ops.size();
  CHECK(g.bench.update().next_wake().at == written + device::seconds(600));
  g.bench.advance_to(written + device::seconds(600) + device::microseconds(-1));
  CHECK_FALSE(g.bench.take_packet().has_value());
  g.bench.advance_to(written + device::seconds(600));
  const auto packet = g.bench.take_packet();
  REQUIRE(packet.has_value());
  CHECK(packet->status.stage == UpdateStage::refused);
  CHECK(packet->status.reason == UpdateReason::radio_busy);
  CHECK(packet->status.image_id == g.file.id);
  CHECK(packet->status.bytes_written == kHeader + 65536);
  CHECK(g.bench.log_value(device::log_code::update_refused) == UpdateReason::radio_busy);
  // The part and its checkpoint stay; nothing was written after the hold began.
  CHECK(g.bench.power.ops.size() == ops);
  CHECK(g.bench.storage.has(device::StoreKey::update));
  CHECK_FALSE(g.bench.update().active());
  // The next offer, once the gate opens, resumes where the slot was written (in this boot,
  // past the checkpoint), with no header again.
  g.bench.update().hold_writes(false, g.bench.now);
  g.hub.gets.clear();
  g.bench.network.handled = g.bench.network.sent.size();
  g.offer(UpdateAction::fetch);
  g.hub.serve();
  REQUIRE_FALSE(g.hub.gets.empty());
  CHECK(g.hub.gets.front().offset == kHeader + 17 * kSector);
}

TEST_CASE("the bound counts from the last sector written, not from when the hold began") {
  Gateway g;
  g.offer(UpdateAction::fetch);
  REQUIRE(g.run_until_writes(2));
  const Instant first = g.bench.now;
  g.bench.update().hold_writes(true, first);
  g.hub.serve_all();
  // Five minutes in, the gate opens long enough for the waiting sectors, then holds again.
  g.bench.advance_to(first + device::seconds(300));
  g.bench.update().hold_writes(false, g.bench.now);
  g.bench.update().hold_writes(true, g.bench.now);
  CHECK(g.count(FlashOp::Kind::slot_write) == 4);
  const Instant last_write = g.bench.now;
  g.hub.serve_all();
  g.bench.advance_to(first + device::seconds(600));
  CHECK_FALSE(g.bench.take_packet().has_value());
  g.bench.advance_to(last_write + device::seconds(600) + device::microseconds(-1));
  CHECK_FALSE(g.bench.take_packet().has_value());
  g.bench.advance_to(last_write + device::seconds(600));
  CHECK(g.bench.take_packet()->status.reason == UpdateReason::radio_busy);
}

TEST_CASE("a release that writes nothing does not restart the bound") {
  Gateway g;
  // The last piece of sector 2 is lost once, so that sector is not whole when the gate opens.
  g.hub.rules.ignore_once = {kHeader + 2 * kSector + 4000};
  g.offer(UpdateAction::fetch);
  REQUIRE(g.run_until_writes(2));
  const Instant last_write = g.bench.now;
  g.bench.update().hold_writes(true, last_write);
  g.hub.serve_all();
  REQUIRE(g.hub.rules.ignore_once.empty());
  g.bench.now = last_write + device::seconds(1);
  g.bench.update().hold_writes(false, g.bench.now);
  g.bench.update().hold_writes(true, g.bench.now);
  CHECK(g.count(FlashOp::Kind::slot_write) == 2);
  // The lost piece comes when it is asked again; the buffers are whole and held.
  g.bench.advance_to(last_write + device::seconds(2));
  g.hub.serve_all();
  CHECK(g.count(FlashOp::Kind::slot_write) == 2);
  g.bench.advance_to(last_write + device::seconds(600) + device::microseconds(-1));
  CHECK_FALSE(g.bench.take_packet().has_value());
  g.bench.advance_to(last_write + device::seconds(600));
  const auto packet = g.bench.take_packet();
  REQUIRE(packet.has_value());
  CHECK(packet->status.reason == UpdateReason::radio_busy);
}

TEST_CASE("a gate held from the start: the header and record go, no sector, then radioBusy") {
  Gateway g;
  g.bench.update().hold_writes(true, g.bench.now);
  const Instant start = g.bench.now;
  g.offer(UpdateAction::fetch);
  g.hub.serve_all();
  CHECK(g.bench.storage.has(device::StoreKey::update));
  CHECK(g.count(FlashOp::Kind::slot_erase) == 0);
  CHECK(g.highest_asked() == kHeader + 2 * kSector);
  g.bench.advance_to(start + device::seconds(600));
  const auto packet = g.bench.take_packet();
  REQUIRE(packet.has_value());
  CHECK(packet->status.reason == UpdateReason::radio_busy);
  CHECK(packet->status.bytes_written == kHeader);
}

TEST_CASE("action 6, forced: the gate does not hold that image's writes") {
  Gateway g;
  g.bench.update().hold_writes(true, g.bench.now);
  g.offer(UpdateAction::forced_fetch);
  REQUIRE(g.run_to(UpdateStage::verified));
  CHECK(g.count(FlashOp::Kind::slot_write) == 35);
  CHECK_FALSE(std::any_of(g.packets.begin(), g.packets.end(), [](const auto& p) {
    return p.status.reason == UpdateReason::radio_busy;
  }));
}

TEST_CASE("action 6 given while the gate holds a pull writes the waiting sectors at once") {
  Gateway g;
  g.offer(UpdateAction::fetch);
  REQUIRE(g.run_until_writes(3));
  g.bench.update().hold_writes(true, g.bench.now);
  g.hub.serve_all();
  REQUIRE(g.count(FlashOp::Kind::slot_write) == 3);
  g.offer(UpdateAction::forced_fetch);
  CHECK(g.count(FlashOp::Kind::slot_write) == 5);
  // Action 1 for the same image again does not take the force back.
  g.offer(UpdateAction::fetch);
  REQUIRE(g.run_to(UpdateStage::verified));
}

TEST_CASE("the force belongs to its image: another image offered with action 1 is held") {
  Gateway g;
  g.bench.update().hold_writes(true, g.bench.now);
  g.offer(UpdateAction::forced_fetch);
  REQUIRE(g.run_until_writes(2));
  const ImageFile other = make_file(make_image({2, 0, 0}, 60000, 4));
  Source hub(g.bench, LinkKind::network, other.file());
  g.bench.network.handled = g.bench.network.sent.size();
  const std::size_t writes = g.count(FlashOp::Kind::slot_write);
  g.bench.update().offer(make_offer(UpdateAction::fetch, other), UpdatePath::network, g.bench.now);
  hub.serve_all();
  CHECK(g.count(FlashOp::Kind::slot_write) == writes);
}

TEST_CASE("cancelled, the force goes: the image offered again with action 1 is held") {
  Gateway g;
  g.bench.update().hold_writes(true, g.bench.now);
  g.offer(UpdateAction::forced_fetch);
  REQUIRE(g.run_until_writes(2));
  const std::size_t writes = g.count(FlashOp::Kind::slot_write);
  g.offer(UpdateAction::nothing);
  g.bench.network.handled = g.bench.network.sent.size();
  g.offer(UpdateAction::fetch);
  g.hub.serve_all();
  CHECK(g.count(FlashOp::Kind::slot_write) == writes);
}

TEST_CASE("the force is the forced image's alone: a Bluetooth pull of another is held") {
  Gateway g;
  g.bench.update().hold_writes(true, g.bench.now);
  g.offer(UpdateAction::forced_fetch);
  REQUIRE(g.run_until_writes(2));
  // Another image over Bluetooth (no fetch offer comes between): its writes stay held.
  const ImageFile other = make_file(make_image({2, 0, 0}, 60000, 4));
  Source phone(g.bench, LinkKind::bluetooth, other.file());
  protocol::UpdateOffer offer = make_offer(UpdateAction::open_bluetooth, other);
  offer.bluetooth_nonce = {1, 2, 3, 4, 5, 6, 7, 8};
  g.bench.update().offer(offer, UpdatePath::radio, g.bench.now);
  g.bench.bluetooth.is_up = true;
  g.bench.deliver_link(LinkKind::bluetooth, device::LinkEventKind::up);
  protocol::transfer::Hello hello;
  REQUIRE(protocol::decode_transfer(protocol::ByteView(g.bench.bluetooth.sent.back().data(),
                                                       g.bench.bluetooth.sent.back().size()),
                                    [&](const auto& frame) {
                                      if constexpr (std::is_same_v<std::decay_t<decltype(frame)>,
                                                                   protocol::transfer::Hello>) {
                                        hello = frame;
                                      }
                                    }) == protocol::Error::none);
  protocol::transfer::Open open;
  open.tag = open_tag(session_key(kKey, Bytes{1, 2, 3, 4, 5, 6, 7, 8}, kAddress), kAddress,
                      hello.device_random, hello.image_id);
  Bytes frame(32);
  const auto size =
      protocol::encode_transfer(open, protocol::MutableByteView(frame.data(), frame.size()));
  REQUIRE(size.ok());
  frame.resize(size.value());
  g.bench.bluetooth.handled = g.bench.bluetooth.sent.size();
  g.bench.deliver_link(LinkKind::bluetooth, device::LinkEventKind::packet, frame);
  const std::size_t writes = g.count(FlashOp::Kind::slot_write);
  phone.serve_all();
  CHECK(g.bench.storage.has(device::StoreKey::update));
  CHECK(g.count(FlashOp::Kind::slot_write) == writes);
  CHECK_FALSE(phone.gets.empty());
}

TEST_CASE("action 6 is refused on trial and ignored over LoRa, as action 1 is") {
  Gateway g;
  g.offer(UpdateAction::forced_fetch);
  REQUIRE(g.run_to(UpdateStage::verified));
  install_and_restart(g.bench, g.hub, g.file, g.packets);
  REQUIRE(g.bench.update().on_trial());
  const ImageFile other = make_file(make_image({2, 0, 0}, 60000, 4));
  g.bench.update().offer(make_offer(UpdateAction::forced_fetch, other), UpdatePath::network,
                         g.bench.now);
  const auto packet = g.bench.take_packet();
  REQUIRE(packet.has_value());
  CHECK(packet->status.reason == UpdateReason::on_trial);

  Gateway h;
  h.bench.update().offer(make_offer(UpdateAction::forced_fetch, h.file), UpdatePath::radio,
                         h.bench.now);
  CHECK(h.bench.network.sent.empty());
}

TEST_CASE("Device tells the service of a network link's up and down; the role still sees them") {
  // A sensor that joins Wi-Fi for an update: the link's events come through Device alone.
  Bench bench;
  bench.boot();
  const ImageFile file = make_file(make_image({1, 1, 0}, 140000));
  Source hub(bench, LinkKind::network, file.file());
  bench.update().offer(make_offer(UpdateAction::join_wifi_and_fetch, file), UpdatePath::radio,
                       bench.now);
  REQUIRE(bench.network.connects == 1);
  const std::size_t seen = bench.instance->role.seen.size();
  bench.network.is_up = true;
  bench.deliver_link(LinkKind::network, device::LinkEventKind::up);
  CHECK(bench.instance->role.seen.size() == seen + 1);
  const auto query = bench.take_packet();
  REQUIRE(query.has_value());
  CHECK(query->kind == UpdatePacketKind::query);
  bench.update().offer(make_offer(UpdateAction::fetch, file), UpdatePath::network, bench.now);
  REQUIRE(run(bench, hub, [&] {
    return std::count_if(bench.power.ops.begin(), bench.power.ops.end(), [](const FlashOp& op) {
             return op.kind == FlashOp::Kind::slot_write;
           }) >= 5;
  }));
  // Down through Device: the service waits, and joins again on its back-off.
  bench.network.is_up = false;
  const Instant down = bench.now;
  bench.deliver_link(LinkKind::network, device::LinkEventKind::down);
  CHECK(bench.instance->role.seen.size() == seen + 2);
  CHECK(bench.update().next_wake().at == down + device::seconds(1));
  bench.advance_to(down + device::seconds(1));
  CHECK(bench.network.connects == 2);
  // Up again through Device: asked on it, and resumed.
  bench.network.is_up = true;
  bench.deliver_link(LinkKind::network, device::LinkEventKind::up);
  REQUIRE(bench.take_packet()->kind == UpdatePacketKind::query);
  // USB too.
  bench.update().offer(make_offer(UpdateAction::wait, file), UpdatePath::network, bench.now);
  bench.deliver_link(LinkKind::usb, device::LinkEventKind::up);
  const auto again = bench.take_packet();
  REQUIRE(again.has_value());
  CHECK(again->query.held == protocol::UpdateHeld::part);
}

}  // namespace
}  // namespace hsn::test::update
