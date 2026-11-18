// UpdateService, step 3 (m3-updates-design.md section 5, "Over Bluetooth from the phone"; protocol
// section 10, "The update service over Bluetooth"): the window opened only by the hub's offer,
// Hello, Open with its tag, five wrong tags, the pull over Bluetooth, Done, and the four stops:
// Done sent, the window's end with nobody connected, 30 s without progress, the session's life.

#include <algorithm>

#include "update_bench.hpp"

namespace hsn::test::update {
namespace {

using device::LinkEventKind;
using device::SleepDepth;
using device::UpdatePacketKind;
using device::UpdatePath;
using protocol::UpdateAction;
using protocol::UpdateReason;
using protocol::UpdateStage;

constexpr std::uint32_t kHeader = 128;
const protocol::FirmwareVersion kNew{1, 1, 0};
const Bytes kNonce{0x5a, 0x5b, 0x5c, 0x5d, 0x5e, 0x5f, 0x60, 0x61};

/** A sensor offered a Bluetooth session, and the phone holding the session key and the file. */
struct Session {
  explicit Session(std::size_t size = 70000, std::uint8_t window_units = 12,
                   const BenchOptions& options = BenchOptions(),
                   const std::function<void(protocol::ImageHeader&)>& adjust = nullptr)
      : bench(options),
        file(make_file(make_image(kNew, size), 0x0E, adjust)),
        phone(bench, LinkKind::bluetooth, file.file()),
        key(session_key(kKey, kNonce, kAddress)) {
    bench.boot();
    window = window_units;
  }

  /** The hub's offer, action 3, over LoRa. */
  void offer(const Bytes& nonce = kNonce) {
    protocol::UpdateOffer offer = make_offer(UpdateAction::open_bluetooth, file);
    std::copy(nonce.begin(), nonce.end(), offer.bluetooth_nonce.begin());
    offer.bluetooth_window_units = window;
    bench.update().offer(offer, UpdatePath::radio, bench.now);
    offered_at = bench.now;
  }

  void connect() {
    bench.bluetooth.is_up = true;
    bench.deliver_link(LinkKind::bluetooth, LinkEventKind::up);
  }

  void drop() {
    bench.bluetooth.is_up = false;
    bench.deliver_link(LinkKind::bluetooth, LinkEventKind::down);
  }

  /** The frames of one kind the device notified, decoded in order. */
  std::vector<protocol::transfer::Hello> hellos() const {
    std::vector<protocol::transfer::Hello> out;
    for (const Bytes& frame : bench.bluetooth.sent) {
      static_cast<void>(protocol::decode_transfer(
          protocol::ByteView(frame.data(), frame.size()), [&](const auto& value) {
            if constexpr (std::is_same_v<std::decay_t<decltype(value)>,
                                         protocol::transfer::Hello>) {
              out.push_back(value);
            }
          }));
    }
    return out;
  }

  std::vector<protocol::transfer::Done> dones() const {
    std::vector<protocol::transfer::Done> out;
    for (const Bytes& frame : bench.bluetooth.sent) {
      static_cast<void>(protocol::decode_transfer(
          protocol::ByteView(frame.data(), frame.size()), [&](const auto& value) {
            if constexpr (std::is_same_v<std::decay_t<decltype(value)>, protocol::transfer::Done>) {
              out.push_back(value);
            }
          }));
    }
    return out;
  }

  void send_open(const protocol::SessionTag& tag) {
    protocol::transfer::Open open;
    open.tag = tag;
    Bytes frame(32);
    const auto size =
        protocol::encode_transfer(open, protocol::MutableByteView(frame.data(), frame.size()));
    REQUIRE(size.ok());
    frame.resize(size.value());
    bench.deliver_link(LinkKind::bluetooth, LinkEventKind::packet, frame);
  }

  /** The tag the phone computes from the latest Hello. */
  protocol::SessionTag right_tag() const {
    const auto all = hellos();
    REQUIRE_FALSE(all.empty());
    return open_tag(key, all.back().address, all.back().device_random, all.back().image_id);
  }

  void open() {
    send_open(right_tag());
  }

  bool run_to(std::uint8_t stage) {
    return run(
        bench, phone, [&] { return has_stage(packets, stage); },
        [&](const device::UpdatePacket& p) { packets.push_back(p); });
  }

  std::optional<device::UpdatePacket> status() {
    for (auto it = packets.rbegin(); it != packets.rend(); ++it) {
      if (it->kind == UpdatePacketKind::status) {
        return *it;
      }
    }
    return bench.take_packet();
  }

  Bench bench;
  ImageFile file;
  Source phone;
  Bytes key;
  std::uint8_t window = 12;
  Instant offered_at;
  Packets packets;
};

TEST_CASE("no offer, no Bluetooth: a connection without a session gets nothing") {
  Session s;
  s.connect();
  CHECK(s.bench.bluetooth.sent.empty());
  CHECK(s.bench.bluetooth.connects == 0);
  CHECK(s.bench.update().next_wake().at.is_never());
  CHECK_FALSE(s.bench.update().active());
  s.send_open(protocol::SessionTag{});
  CHECK(s.bench.bluetooth.sent.empty());
  // Only action 3 opens it: a fetch on the Bluetooth path does not.
  s.bench.update().offer(make_offer(UpdateAction::fetch, s.file), UpdatePath::bluetooth,
                         s.bench.now);
  CHECK(s.bench.bluetooth.connects == 0);
}

TEST_CASE("the offer opens the window for its units of 10 s; nobody comes: windowEnded") {
  Session s(70000, 3);
  s.offer();
  CHECK(s.bench.bluetooth.connects == 1);
  CHECK(s.bench.bluetooth.connecting);
  CHECK(s.bench.crypto.session_keys == 1);
  CHECK(s.bench.update().active());
  const device::Wake wake = s.bench.update().next_wake();
  CHECK(wake.at == s.offered_at + device::seconds(30));
  CHECK(wake.deepest == SleepDepth::awake);
  s.bench.advance_to(s.offered_at + device::seconds(30) + device::microseconds(-1));
  CHECK(s.bench.bluetooth.connecting);
  CHECK_FALSE(s.bench.take_packet().has_value());
  s.bench.advance_to(s.offered_at + device::seconds(30));
  CHECK_FALSE(s.bench.bluetooth.connecting);
  CHECK(s.bench.bluetooth.disconnects == 1);
  const auto packet = s.bench.take_packet();
  REQUIRE(packet.has_value());
  CHECK(packet->status.stage == UpdateStage::refused);
  CHECK(packet->status.reason == UpdateReason::window_ended);
  CHECK(packet->status.image_id == s.file.id);
  CHECK(s.bench.log_value(device::log_code::update_refused) == UpdateReason::window_ended);
  CHECK_FALSE(s.bench.update().active());
  CHECK(s.bench.update().next_wake().at.is_never());
  CHECK(s.dones().empty());
}

TEST_CASE("an offer without a window gets the design's 120 s") {
  Session s(70000, 0);
  s.offer();
  CHECK(s.bench.update().next_wake().at == s.offered_at + device::seconds(120));
}

TEST_CASE("a phone that connects gets Hello: address, a fresh random, the image, bytes, piece") {
  Session s;
  s.offer();
  s.connect();
  auto hellos = s.hellos();
  REQUIRE(hellos.size() == 1);
  CHECK(hellos[0].address == kAddress);
  CHECK(hellos[0].image_id == s.file.id);
  CHECK(hellos[0].bytes_held == 0);
  CHECK(hellos[0].largest_data == 164);
  s.drop();
  s.connect();
  hellos = s.hellos();
  REQUIRE(hellos.size() == 2);
  CHECK(hellos[1].device_random != hellos[0].device_random);
}

TEST_CASE("the right tag opens the session: pieces of 164, 8 out, asked again after 3 s") {
  Session s;
  s.offer();
  s.connect();
  s.phone.rules.ignore_always = true;
  s.open();
  s.phone.serve();
  REQUIRE(s.phone.gets.size() == 1);
  CHECK(s.phone.gets[0].offset == 0);
  CHECK(s.phone.gets[0].length == 128);
  const Bytes file = s.file.file();
  s.bench.deliver_link(LinkKind::bluetooth, LinkEventKind::packet,
                       data_frame(s.file.id, file, 0, 128));
  s.phone.serve();
  REQUIRE(s.phone.gets.size() == 9);
  for (std::size_t i = 1; i < 9; ++i) {
    CHECK(s.phone.gets[i].offset == kHeader + 164 * (i - 1));
    CHECK(s.phone.gets[i].length == 164);
  }
  const Instant asked = s.bench.now;
  s.bench.now = asked + device::seconds(3) + device::microseconds(-1);
  s.bench.instance->runner.deliver(device::Event::timer_at(s.bench.now));
  s.phone.serve();
  CHECK(s.phone.gets.size() == 9);
  s.bench.advance_to(asked + device::seconds(3));
  s.phone.serve();
  CHECK(s.phone.gets.size() == 17);
  // The chip stays awake while Bluetooth runs.
  CHECK(s.bench.update().next_wake().deepest == SleepDepth::awake);
}

TEST_CASE("a whole file over Bluetooth: Done verified, Bluetooth stops, verified over LoRa") {
  Session s(20000);
  s.offer();
  s.connect();
  s.open();
  REQUIRE(s.run_to(UpdateStage::verified));
  const auto dones = s.dones();
  REQUIRE(dones.size() == 1);
  CHECK(dones[0].image_id == s.file.id);
  CHECK(dones[0].result == protocol::DoneResult::verified);
  CHECK(dones[0].reason == UpdateReason::none);
  // Done is the last thing notified, then the window closes.
  CHECK(s.bench.bluetooth.sent.back()[1] == protocol::transfer_kind::done);
  CHECK_FALSE(s.bench.bluetooth.connecting);
  const auto status = s.status();
  REQUIRE(status.has_value());
  CHECK(status->status.stage == UpdateStage::verified);
  CHECK(status->status.bytes_written == kHeader + 20000);
  CHECK_FALSE(status->links_only);
  // No progress statuses for a Bluetooth transfer: nothing but LoRa to send them on.
  CHECK(std::none_of(s.packets.begin(), s.packets.end(), [](const auto& p) {
    return p.kind == UpdatePacketKind::status && p.status.stage == UpdateStage::fetching;
  }));
  for (const auto& get : s.phone.gets) {
    CHECK(get.length <= 164);
  }
  const Bytes& slot = s.bench.slots.bytes[static_cast<std::size_t>(s.bench.slots.other_slot())];
  CHECK(Bytes(slot.begin(), slot.begin() + 20000) == s.file.image);
  CHECK(s.bench.update().next_wake().at.is_never());
}

TEST_CASE("over Bluetooth no progress status is made, however large the image") {
  BenchOptions large;
  large.capacity = 320 * 1024;
  Session s(300000, 12, large);
  s.offer();
  s.connect();
  s.open();
  REQUIRE(s.run_to(UpdateStage::verified));
  CHECK(std::none_of(s.packets.begin(), s.packets.end(), [](const auto& p) {
    return p.kind == UpdatePacketKind::status && p.status.stage == UpdateStage::fetching;
  }));
}

TEST_CASE("the piece follows the MTU the link reports: small, typical, largest, capped, unknown") {
  struct Size {
    std::uint16_t reported;
    std::uint16_t piece;
  };
  // MTU 23 (the least Bluetooth allows: 20 bytes a packet), 185, 517, one larger than any link
  // buffer, nothing said, and too little to carry a Data frame at all.
  for (const Size size : {Size{20, 2}, Size{182, 164}, Size{514, 496}, Size{1100, 1000},
                          Size{0, 164}, Size{18, 164}, Size{19, 1}}) {
    CAPTURE(size.reported);
    Session s(3000);
    s.bench.bluetooth.largest = size.reported;
    s.offer();
    s.connect();
    CHECK(s.hellos().back().largest_data == size.piece);
    s.open();
    if (size.piece < 100 || size.reported == 18 || size.reported == 1100) {
      // The whole transfer at the smallest pieces, and the first Gets of the others.
      s.phone.rules.ignore_always = size.piece >= 100;
    }
    if (size.reported == 20 || size.reported == 182 || size.reported == 514) {
      REQUIRE(s.run_to(UpdateStage::verified));
      for (const auto& get : s.phone.gets) {
        if (get.offset >= kHeader) {
          CHECK(get.length <= size.piece);
        }
      }
      // Every piece but each sector's (and the image's) last is exactly the piece size.
      CHECK(std::count_if(s.phone.gets.begin(), s.phone.gets.end(), [&](const auto& get) {
              return get.offset >= kHeader && get.length == size.piece;
            }) >= static_cast<std::ptrdiff_t>(3000 / size.piece) - 1);
      const Bytes& slot = s.bench.slots.bytes[static_cast<std::size_t>(s.bench.slots.other_slot())];
      CHECK(Bytes(slot.begin(), slot.begin() + 3000) == s.file.image);
    } else {
      // The header first, then pieces of the size Hello said.
      const Bytes file = s.file.file();
      s.phone.rules.ignore_always = true;
      s.phone.serve();
      s.bench.deliver_link(LinkKind::bluetooth, LinkEventKind::packet,
                           data_frame(s.file.id, file, 0, 128));
      s.phone.serve();
      REQUIRE(s.phone.gets.size() >= 2);
      CHECK(s.phone.gets[1].length == std::min<std::uint16_t>(size.piece, 3000));
    }
  }
}

TEST_CASE("a phone that connects again with another MTU gets pieces of the new size") {
  Session s(70000);
  s.bench.bluetooth.largest = 514;
  s.offer();
  s.connect();
  s.open();
  REQUIRE(run(s.bench, s.phone, [&] {
    return std::count_if(s.bench.power.ops.begin(), s.bench.power.ops.end(),
                         [](const auto& op) { return op.kind == FlashOp::Kind::slot_write; }) >= 3;
  }));
  s.drop();
  s.bench.bluetooth.handled = s.bench.bluetooth.sent.size();
  s.bench.bluetooth.largest = 182;
  s.connect();
  CHECK(s.hellos().back().largest_data == 164);
  const std::size_t before = s.phone.gets.size();
  s.open();
  REQUIRE(s.run_to(UpdateStage::verified));
  for (std::size_t i = before; i < s.phone.gets.size(); ++i) {
    CHECK(s.phone.gets[i].length <= 164);
  }
}

TEST_CASE("a wrong tag closes the connection and the window stays; the fifth ends it") {
  Session s;
  s.offer();
  for (std::uint8_t wrong = 1; wrong <= 4; ++wrong) {
    CAPTURE(static_cast<int>(wrong));
    s.connect();
    protocol::SessionTag tag = s.right_tag();
    tag[15] ^= 0x01;
    const std::uint32_t disconnects = s.bench.bluetooth.disconnects;
    s.send_open(tag);
    CHECK(s.bench.bluetooth.disconnects == disconnects + 1);
    CHECK(s.bench.bluetooth.connecting);  // advertising again
    CHECK(s.bench.log_value(device::log_code::session_refused) == wrong);
    CHECK_FALSE(s.bench.take_packet().has_value());
    s.bench.bluetooth.is_up = false;
  }
  s.connect();
  protocol::SessionTag tag = s.right_tag();
  tag[0] ^= 0x80;
  s.send_open(tag);
  CHECK_FALSE(s.bench.bluetooth.connecting);
  const auto packet = s.bench.take_packet();
  REQUIRE(packet.has_value());
  CHECK(packet->status.reason == UpdateReason::session_refused);
  CHECK(s.phone.gets.empty());
  CHECK(s.dones().empty());
  CHECK_FALSE(s.bench.update().active());
}

TEST_CASE("four wrong tags, then the right one: the session opens") {
  Session s(20000);
  s.offer();
  for (int wrong = 0; wrong < 4; ++wrong) {
    s.connect();
    s.send_open(protocol::SessionTag{});
    s.bench.bluetooth.is_up = false;
  }
  s.connect();
  s.open();
  REQUIRE(s.run_to(UpdateStage::verified));
}

TEST_CASE("the tag binds the session key, the device random and the image id") {
  Session s;
  s.offer();
  s.connect();
  const auto first = s.hellos().back();
  s.drop();
  s.connect();
  const auto second = s.hellos().back();
  // Last connection's random: wrong.
  s.send_open(open_tag(s.key, kAddress, first.device_random, second.image_id));
  CHECK(s.bench.log_value(device::log_code::session_refused) == 1);
  s.connect();
  const auto third = s.hellos().back();
  protocol::ImageId other_id = third.image_id;
  other_id[3] ^= 1;
  s.send_open(open_tag(s.key, kAddress, third.device_random, other_id));
  CHECK(s.bench.log_value(device::log_code::session_refused) == 2);
  s.connect();
  const auto fourth = s.hellos().back();
  s.send_open(open_tag(session_key(kKey, Bytes(8, 0), kAddress), kAddress, fourth.device_random,
                       fourth.image_id));
  CHECK(s.bench.log_value(device::log_code::session_refused) == 3);
  s.connect();
  const auto fifth = s.hellos().back();
  s.send_open(open_tag(s.key, kAddress + 1, fifth.device_random, fifth.image_id));
  CHECK(s.bench.log_value(device::log_code::session_refused) == 4);
  CHECK(s.phone.gets.empty());
}

TEST_CASE("Data before Open, Open twice, Open on another link are dropped") {
  Session s;
  s.offer();
  s.connect();
  const Bytes file = s.file.file();
  const std::size_t ops = s.bench.power.ops.size();
  s.bench.deliver_link(LinkKind::bluetooth, LinkEventKind::packet,
                       data_frame(s.file.id, file, 0, 128));
  CHECK(s.bench.power.ops.size() == ops);
  CHECK(s.bench.crypto.verifies == 0);
  CHECK_FALSE(s.bench.storage.has(device::StoreKey::update));
  // Open on the network link: not a session.
  protocol::transfer::Open open;
  open.tag = s.right_tag();
  Bytes frame(32);
  const auto size =
      protocol::encode_transfer(open, protocol::MutableByteView(frame.data(), frame.size()));
  REQUIRE(size.ok());
  frame.resize(size.value());
  s.bench.deliver_link(LinkKind::network, LinkEventKind::packet, frame);
  s.phone.serve();
  CHECK(s.phone.gets.empty());
  s.open();
  s.phone.rules.ignore_always = true;
  s.phone.serve();
  CHECK(s.phone.gets.size() == 1);
  s.open();  // again: dropped, no new pull
  s.phone.serve();
  CHECK(s.phone.gets.size() == 1);
  CHECK(s.bench.log_codes().back() == device::log_code::transfer_dropped);
}

TEST_CASE("a drop mid-transfer: the phone connects again, Hello says what is held, it resumes") {
  Session s(140000);
  s.offer();
  s.connect();
  s.open();
  REQUIRE(run(s.bench, s.phone, [&] {
    return std::count_if(s.bench.power.ops.begin(), s.bench.power.ops.end(),
                         [](const auto& op) { return op.kind == FlashOp::Kind::slot_write; }) >= 20;
  }));
  s.drop();
  s.bench.bluetooth.handled = s.bench.bluetooth.sent.size();
  s.bench.advance(device::seconds(10));
  CHECK(s.bench.bluetooth.connecting);  // still advertising for it
  s.connect();
  const auto hello = s.hellos().back();
  CHECK(hello.bytes_held == kHeader + 20 * 4096);
  const std::size_t before = s.phone.gets.size();
  s.open();
  s.phone.serve();
  REQUIRE(s.phone.gets.size() > before);
  CHECK(s.phone.gets[before].offset == kHeader + 20 * 4096);
  REQUIRE(s.run_to(UpdateStage::verified));
}

TEST_CASE("30 s without progress ends the session: linkLost, with Done when it was open") {
  Session s;
  s.offer();
  s.connect();
  s.open();
  s.phone.rules.ignore_always = true;
  s.phone.serve();
  const Instant opened = s.bench.now;
  CHECK(s.bench.update().next_wake().at == opened + device::seconds(3));
  s.bench.advance_to(opened + device::seconds(30) + device::microseconds(-1));
  s.phone.serve();
  CHECK(s.bench.bluetooth.connecting);
  s.bench.advance_to(opened + device::seconds(30));
  CHECK_FALSE(s.bench.bluetooth.connecting);
  const auto dones = s.dones();
  REQUIRE(dones.size() == 1);
  CHECK(dones[0].result == protocol::DoneResult::refused);
  CHECK(dones[0].reason == UpdateReason::link_lost);
  const auto packet = s.bench.take_packet();
  REQUIRE(packet.has_value());
  CHECK(packet->status.reason == UpdateReason::link_lost);

  // Connected but never opened: 30 s, no Done.
  Session t;
  t.offer();
  t.connect();
  t.bench.advance(device::seconds(30));
  CHECK_FALSE(t.bench.bluetooth.connecting);
  CHECK(t.dones().empty());
  CHECK(t.bench.take_packet()->status.reason == UpdateReason::link_lost);
}

TEST_CASE("after the window, a phone that opened may come back within 30 s; past it, no") {
  for (const bool late : {false, true}) {
    CAPTURE(late);
    Session s(140000, 3);  // a 30 s window
    s.offer();
    s.connect();
    s.open();
    // A slow phone: two sectors every 10 s, past the window's end.
    for (std::size_t step = 1; step <= 4; ++step) {
      s.bench.advance(device::seconds(10));
      REQUIRE(run(s.bench, s.phone, [&] {
        return static_cast<std::size_t>(std::count_if(s.bench.power.ops.begin(),
                                                      s.bench.power.ops.end(), [](const auto& op) {
                                                        return op.kind == FlashOp::Kind::slot_write;
                                                      })) >= 2 * step;
      }));
    }
    REQUIRE(s.bench.now > s.offered_at + device::seconds(30));
    REQUIRE(s.bench.bluetooth.connecting);
    s.drop();
    s.bench.bluetooth.handled = s.bench.bluetooth.sent.size();
    const Instant dropped = s.bench.now;
    if (late) {
      s.bench.advance_to(dropped + device::seconds(30));
      CHECK_FALSE(s.bench.bluetooth.connecting);
      CHECK(s.bench.take_packet()->status.reason == UpdateReason::link_lost);
      continue;
    }
    s.bench.advance_to(dropped + device::seconds(20));
    CHECK(s.bench.bluetooth.connecting);
    s.connect();
    s.open();
    REQUIRE(s.run_to(UpdateStage::verified));
  }
}

TEST_CASE("the session's life, 15 minutes, ends even a long window") {
  Session s(70000, 255);
  s.offer();
  CHECK(s.bench.update().next_wake().at == s.offered_at + device::seconds(900));
  s.bench.advance_to(s.offered_at + device::seconds(900));
  const auto packet = s.bench.take_packet();
  REQUIRE(packet.has_value());
  CHECK(packet->status.reason == UpdateReason::window_ended);
  CHECK_FALSE(s.bench.bluetooth.connecting);
}

TEST_CASE("the same offer again keeps the session; a new nonce replaces it") {
  Session s;
  s.offer();
  s.offer();
  CHECK(s.bench.bluetooth.connects == 1);
  CHECK(s.bench.crypto.session_keys == 1);
  const Bytes other{1, 2, 3, 4, 5, 6, 7, 8};
  s.offer(other);
  CHECK(s.bench.bluetooth.connects == 2);
  CHECK(s.bench.bluetooth.disconnects == 1);
  s.connect();
  s.open();  // the old session's key: refused
  CHECK(s.bench.log_value(device::log_code::session_refused) == 1);
  s.connect();
  const auto hello = s.hellos().back();
  s.send_open(
      open_tag(session_key(kKey, other, kAddress), kAddress, hello.device_random, hello.image_id));
  s.phone.serve();
  CHECK_FALSE(s.phone.gets.empty());
}

TEST_CASE("a header refused over Bluetooth: Done refused with the reason, then the status") {
  Session s(70000, 12, BenchOptions(),
            [](protocol::ImageHeader& header) { header.hub_identity[0] ^= 1; });
  s.offer();
  s.connect();
  s.open();
  REQUIRE(s.run_to(UpdateStage::refused));
  const auto dones = s.dones();
  REQUIRE(dones.size() == 1);
  CHECK(dones[0].result == protocol::DoneResult::refused);
  CHECK(dones[0].reason == UpdateReason::wrong_hub);
  CHECK(s.status()->status.reason == UpdateReason::wrong_hub);
  CHECK_FALSE(s.bench.bluetooth.connecting);
}

TEST_CASE("a verified image: Open gives Done verified at once") {
  Session s(20000);
  s.offer();
  s.connect();
  s.open();
  REQUIRE(s.run_to(UpdateStage::verified));
  s.packets.clear();
  s.bench.bluetooth.sent.clear();
  s.bench.bluetooth.handled = 0;
  s.offer(Bytes{9, 9, 9, 9, 9, 9, 9, 9});
  s.connect();
  const auto hello = s.hellos().back();
  CHECK(hello.bytes_held == kHeader + 20000);
  const std::size_t gets = s.phone.gets.size();
  s.send_open(open_tag(session_key(kKey, Bytes(8, 9), kAddress), kAddress, hello.device_random,
                       hello.image_id));
  s.phone.serve();
  CHECK(s.phone.gets.size() == gets);
  REQUIRE(s.dones().size() == 1);
  CHECK(s.dones()[0].result == protocol::DoneResult::verified);
  CHECK(s.bench.take_packet()->status.stage == UpdateStage::verified);
}

TEST_CASE("a phone's Gone ends the session as linkLost") {
  Session s;
  s.offer();
  s.connect();
  s.open();
  s.phone.rules.gone = protocol::GoneReason::out_of_range;
  s.phone.serve();
  CHECK_FALSE(s.bench.bluetooth.connecting);
  CHECK(s.bench.take_packet()->status.reason == UpdateReason::link_lost);
}

TEST_CASE("no session key, no window; no Bluetooth on the board, no window either") {
  Session s;
  s.bench.crypto.fail_session_key = true;
  s.offer();
  CHECK(s.bench.bluetooth.connects == 0);
  const auto packet = s.bench.take_packet();
  REQUIRE(packet.has_value());
  CHECK(packet->status.reason == UpdateReason::session_refused);
  CHECK_FALSE(s.bench.update().active());

  BenchOptions none;
  none.bluetooth = false;
  Session t(70000, 12, none);
  t.offer();
  CHECK(t.bench.bluetooth.connects == 0);
  CHECK_FALSE(t.bench.take_packet().has_value());
  CHECK_FALSE(t.bench.update().active());
}

TEST_CASE("a Bluetooth offer stops a pull on Wi-Fi, keeping its part") {
  Session s(140000);
  Source hub(s.bench, LinkKind::network, s.file.file());
  s.bench.update().offer(make_offer(UpdateAction::fetch, s.file), UpdatePath::network, s.bench.now);
  REQUIRE(run(s.bench, hub, [&] {
    return std::count_if(s.bench.power.ops.begin(), s.bench.power.ops.end(),
                         [](const auto& op) { return op.kind == FlashOp::Kind::slot_write; }) >= 18;
  }));
  s.offer();
  const std::size_t sent = s.bench.network.sent.size();
  s.bench.advance(device::seconds(5));
  CHECK(s.bench.network.sent.size() == sent);
  s.connect();
  CHECK(s.hellos().back().bytes_held == kHeader + 18 * 4096);
  s.open();
  s.phone.serve();
  CHECK(s.phone.gets.front().offset == kHeader + 18 * 4096);
}

}  // namespace
}  // namespace hsn::test::update
