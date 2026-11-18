// UpdateService, step 1 (m3-updates-design.md sections 3 and 5): answering an offer, the pull in
// windows, each Data's CRC, the header's checks in their order before any byte is written, the
// sectors erased and written in order, the checkpoints, resuming after a reset or a lost link,
// the read-back hash, "install now", and every refusal with its log entry.

#include <algorithm>
#include <set>

#include "update_bench.hpp"

namespace hsn::test::update {
namespace {

using device::SleepDepth;
using device::UpdatePacketKind;
using device::UpdatePath;
using protocol::UpdateAction;
using protocol::UpdateReason;
using protocol::UpdateStage;

constexpr std::uint32_t kHeader = 128;
constexpr std::uint32_t kSector = 4096;

const protocol::FirmwareVersion kNew{1, 1, 0};

using Rec = std::pair<std::uint8_t, std::uint32_t>;

/** A booted bench, a file of `size` image bytes, and the hub serving it on the network link. */
struct Fixture {
  explicit Fixture(std::size_t size = 70000, const BenchOptions& options = BenchOptions(),
                   const std::function<void(protocol::ImageHeader&)>& adjust = nullptr,
                   std::uint8_t roles = 0x0E)
      : bench(options),
        file(make_file(make_image(kNew, size), roles, adjust)),
        hub(bench, LinkKind::network, file.file()) {
    bench.boot();
    ops_at_start = bench.power.ops.size();
  }

  void offer(std::uint8_t action, UpdatePath path = UpdatePath::network) {
    bench.update().offer(make_offer(action, file), path, bench.now);
  }

  /** Runs until a status with `stage` is taken; every packet taken is kept. */
  bool run_to(std::uint8_t stage) {
    return run(
        bench, hub,
        [&] {
          return std::any_of(packets.begin(), packets.end(), [&](const device::UpdatePacket& p) {
            return p.kind == UpdatePacketKind::status && p.status.stage == stage;
          });
        },
        [&](const device::UpdatePacket& packet) { packets.push_back(packet); });
  }

  /** The flash operations of `kind` since the bench booted. */
  std::vector<FlashOp> ops(FlashOp::Kind kind) const {
    std::vector<FlashOp> out;
    for (std::size_t i = ops_at_start; i < bench.power.ops.size(); ++i) {
      if (bench.power.ops[i].kind == kind) {
        out.push_back(bench.power.ops[i]);
      }
    }
    return out;
  }

  /** Changes to flash (slot or records) since the bench booted. */
  std::size_t writes() const {
    std::size_t count = 0;
    for (std::size_t i = ops_at_start; i < bench.power.ops.size(); ++i) {
      count += bench.power.ops[i].kind != FlashOp::Kind::slot_read ? 1 : 0;
    }
    return count;
  }

  /** The update records written since the bench booted: (stage, bytes written). */
  std::vector<std::pair<std::uint8_t, std::uint32_t>> records() const {
    std::vector<std::pair<std::uint8_t, std::uint32_t>> out;
    for (const auto& entry : bench.storage.history) {
      if (entry.first == device::StoreKey::update) {
        const Bytes& value = entry.second;
        REQUIRE(value.size() == 134);
        CHECK(Bytes(value.begin() + 1, value.begin() + 129) == file.header_bytes);
        out.emplace_back(value[129],
                         static_cast<std::uint32_t>(value[130] | (value[131] << 8) |
                                                    (value[132] << 16) | (value[133] << 24)));
      }
    }
    return out;
  }

  std::optional<device::UpdatePacket> last_status() const {
    for (auto it = packets.rbegin(); it != packets.rend(); ++it) {
      if (it->kind == UpdatePacketKind::status) {
        return *it;
      }
    }
    return std::nullopt;
  }

  Bytes slot() const {
    const Bytes& bytes = bench.slots.bytes[static_cast<std::size_t>(bench.slots.other_slot())];
    return Bytes(bytes.begin(), bytes.begin() + static_cast<std::ptrdiff_t>(file.image.size()));
  }

  Bench bench;
  ImageFile file;
  Source hub;
  std::size_t ops_at_start = 0;
  std::vector<device::UpdatePacket> packets;
};

TEST_CASE("an offer to fetch asks for the header alone, on the link it came by") {
  Fixture f;
  f.hub.rules.ignore_always = true;
  f.offer(UpdateAction::fetch);
  f.hub.serve();
  REQUIRE(f.hub.gets.size() == 1);
  CHECK(f.hub.gets[0].offset == 0);
  CHECK(f.hub.gets[0].length == 128);
  CHECK(f.hub.gets[0].image_id == f.file.id);
  CHECK(f.bench.usb.sent.empty());
  CHECK(f.writes() == 0);
  CHECK(f.bench.update().active());
  // On USB for a gateway on the cable.
  Fixture g;
  g.offer(UpdateAction::fetch, UpdatePath::usb);
  CHECK(g.bench.network.sent.empty());
  REQUIRE(g.bench.usb.sent.size() == 1);
  CHECK(decode_get(g.bench.usb.sent[0]).offset == 0);
}

TEST_CASE("nothing is pulled over LoRa, nor on a link the board does not have") {
  Fixture f;
  f.offer(UpdateAction::fetch, UpdatePath::radio);
  f.offer(UpdateAction::fetch, UpdatePath::bluetooth);
  CHECK(f.bench.network.sent.empty());
  CHECK(f.bench.bluetooth.sent.empty());
  CHECK_FALSE(f.bench.update().active());
  const auto codes = f.bench.log_codes();
  // Two in a row: one entry, counted twice.
  CHECK(std::count(codes.begin(), codes.end(), device::log_code::transfer_dropped) == 1);
  CHECK_FALSE(f.bench.update().next_packet(f.bench.now).kind != UpdatePacketKind::none);
}

/** One header the device must refuse, and why. */
struct Refusal {
  const char* name;
  std::uint8_t reason;
  std::function<void(protocol::ImageHeader&)> adjust;
  std::function<void(Bytes&)> damage;
  BenchOptions options;
  std::uint8_t roles = 0x0E;
};

TEST_CASE("section 3: every header check refuses before anything is written, with its reason") {
  BenchOptions small;
  small.capacity = 69999;  // one byte short of the image
  BenchOptions other_key;
  other_key.signing_key = from_hex(
      "1111111111111111111111111111111111111111111111111111111111111111"
      "2222222222222222222222222222222222222222222222222222222222222222");
  BenchOptions siren;
  siren.role = protocol::Role::siren;
  const std::vector<Refusal> cases = {
      {"magic", UpdateReason::bad_header, nullptr, [](Bytes& h) { h[0] = 'X'; }, {}},
      {"format", UpdateReason::bad_header, nullptr, [](Bytes& h) { h[4] = 2; }, {}},
      {"byte 11", UpdateReason::bad_header, nullptr, [](Bytes& h) { h[11] = 1; }, {}},
      {"byte 56", UpdateReason::bad_header, nullptr, [](Bytes& h) { h[56] = 1; }, {}},
      {"target",
       UpdateReason::bad_header,
       [](protocol::ImageHeader& h) { h.target = 2; },
       nullptr,
       {}},
      {"hub",
       UpdateReason::wrong_hub,
       [](protocol::ImageHeader& h) { h.hub_identity[7] ^= 1; },
       nullptr,
       {}},
      {"role", UpdateReason::wrong_role, nullptr, nullptr, siren, 0x02},
      {"size", UpdateReason::too_large, nullptr, nullptr, small},
      {"signature", UpdateReason::bad_signature, nullptr, [](Bytes& h) { h[100] ^= 0x40; }, {}},
      {"signed bytes", UpdateReason::bad_signature, nullptr, [](Bytes& h) { h[10] ^= 1; }, {}},
      {"another key", UpdateReason::bad_signature, nullptr, nullptr, other_key},
  };
  for (const Refusal& c : cases) {
    const std::string name = c.name;
    CAPTURE(name);
    Bench bench(c.options);
    bench.boot();
    ImageFile file = make_file(make_image(kNew, 70000), c.roles, c.adjust);
    Bytes served = file.file();
    if (c.damage) {
      c.damage(served);
    }
    Source hub(bench, LinkKind::network, served);
    const std::size_t ops_before = bench.power.ops.size();
    bench.update().offer(make_offer(UpdateAction::fetch, file), UpdatePath::network, bench.now);
    hub.serve();
    const auto packet = bench.take_packet();
    REQUIRE(packet.has_value());
    CHECK(packet->kind == UpdatePacketKind::status);
    CHECK(packet->status.stage == UpdateStage::refused);
    CHECK(packet->status.reason == c.reason);
    CHECK(packet->status.image_id == file.id);
    CHECK_FALSE(packet->links_only);
    // Nothing written: no erase, no write, no record (section 3: before check 5, nothing).
    CHECK(bench.power.ops.size() == ops_before);
    CHECK_FALSE(bench.storage.has(device::StoreKey::update));
    // The signature is checked only once checks 1 to 4 pass.
    CHECK(bench.crypto.verifies == (c.reason == UpdateReason::bad_signature ? 1u : 0u));
    CHECK(bench.log_value(device::log_code::update_refused) == c.reason);
    // Only the header was asked for; the transfer is over.
    CHECK(hub.gets.size() == 1);
    CHECK_FALSE(bench.update().active());
    CHECK(bench.instance->device.next_wake().at.is_never());
  }
}

TEST_CASE("section 3: a header passes at its edges: exactly the slot's size, this role's bit") {
  BenchOptions exact;
  exact.capacity = 70000;
  Fixture f(70000, exact);
  f.offer(UpdateAction::fetch);
  f.hub.serve_all();
  CHECK(f.hub.gets.size() > 1);
  CHECK(f.bench.crypto.verifies == 1);
  // A sensor-only image on a sensor; a gateway's bit on a gateway.
  Fixture sensor(70000, BenchOptions(), nullptr, 0x02);
  sensor.offer(UpdateAction::fetch);
  sensor.hub.serve_all();
  CHECK(sensor.hub.gets.size() > 1);
  BenchOptions gateway;
  gateway.role = protocol::Role::gateway;
  Fixture g(70000, gateway, nullptr, 0x08);
  g.offer(UpdateAction::fetch);
  g.hub.serve_all();
  CHECK(g.hub.gets.size() > 1);
}

TEST_CASE("a header from another image than the one offered, or cut short, is a bad header") {
  Fixture f;
  ImageFile other = make_file(make_image(kNew, 60000, 9));
  REQUIRE(other.id != f.file.id);
  // The hub offers one image and serves another's header under the offered id.
  Source wrong(f.bench, LinkKind::network, other.file());
  f.bench.update().offer(make_offer(UpdateAction::fetch, f.file), UpdatePath::network, f.bench.now);
  wrong.serve();
  auto packet = f.bench.take_packet();
  REQUIRE(packet.has_value());
  CHECK(packet->status.reason == UpdateReason::bad_header);

  // 127 bytes for the header's Get.
  Fixture g;
  g.hub.rules.ignore_always = true;
  g.offer(UpdateAction::fetch);
  g.hub.serve();
  const Bytes file = g.file.file();
  g.bench.deliver_link(LinkKind::network, device::LinkEventKind::packet,
                       data_frame(g.file.id, file, 0, 127));
  packet = g.bench.take_packet();
  REQUIRE(packet.has_value());
  CHECK(packet->status.reason == UpdateReason::bad_header);
  CHECK(g.writes() == 0);
}

TEST_CASE(
    "the pull: pieces of at most 1,000 bytes, never across a sector, 4 out, 2 sectors ahead") {
  Fixture f(70000);
  // The first piece of the image goes unanswered until it is asked again.
  f.hub.rules.ignore_once = {kHeader};
  f.offer(UpdateAction::fetch);
  f.hub.serve_all();
  // Everything asked so far stays inside the current sector and the next.
  std::uint32_t highest = 0;
  for (const auto& get : f.hub.gets) {
    highest = std::max<std::uint32_t>(highest, get.offset + get.length);
  }
  CHECK(highest == kHeader + 2 * kSector);
  CHECK(f.ops(FlashOp::Kind::slot_erase).empty());
  // At most four out at once: the device asks for one more only as one is answered.
  const std::size_t asked = f.hub.gets.size();
  f.bench.advance(device::milliseconds(1999));
  f.hub.serve_all();
  CHECK(f.hub.gets.size() == asked);
  f.bench.advance(device::milliseconds(1));
  f.hub.serve();
  REQUIRE(f.run_to(UpdateStage::verified));

  std::set<std::uint32_t> offsets;
  for (const auto& get : f.hub.gets) {
    CHECK(get.length >= 1);
    CHECK(get.length <= 1000);
    if (get.offset >= kHeader) {
      const std::uint32_t start = (get.offset - kHeader) / kSector;
      const std::uint32_t end = (get.offset - kHeader + get.length - 1) / kSector;
      CHECK(start == end);
    }
    offsets.insert(get.offset);
  }
  // Every piece was asked once, and the unanswered one once more.
  CHECK(f.hub.gets.size() == offsets.size() + 1);
  CHECK(std::count_if(f.hub.gets.begin(), f.hub.gets.end(),
                      [](const auto& get) { return get.offset == kHeader; }) == 2);
  CHECK(f.slot() == f.file.image);
}

TEST_CASE("never more than four Gets out on a link, whatever the source does") {
  Fixture f(70000);
  f.hub.rules.ignore_always = true;
  f.offer(UpdateAction::fetch);
  f.hub.serve();
  // Answer the header by hand, then nothing: four Gets, no more.
  const Bytes file = f.file.file();
  f.bench.deliver_link(LinkKind::network, device::LinkEventKind::packet,
                       data_frame(f.file.id, file, 0, 128));
  f.hub.serve();
  REQUIRE(f.hub.gets.size() == 5);
  CHECK(f.hub.gets[1].offset == kHeader);
  CHECK(f.hub.gets[2].offset == kHeader + 1000);
  CHECK(f.hub.gets[3].offset == kHeader + 2000);
  CHECK(f.hub.gets[4].offset == kHeader + 3000);
  // Each is asked again after 2 s, the same four; not a microsecond earlier, whatever event
  // comes then.
  const Instant asked = f.bench.now;
  f.bench.now = asked + device::seconds(2) + device::microseconds(-1);
  f.bench.instance->runner.deliver(device::Event::timer_at(f.bench.now));
  f.hub.serve();
  REQUIRE(f.hub.gets.size() == 5);
  f.bench.advance_to(asked + device::seconds(2));
  f.hub.serve();
  REQUIRE(f.hub.gets.size() == 9);
  for (std::size_t i = 0; i < 4; ++i) {
    CHECK(f.hub.gets[5 + i].offset == f.hub.gets[1 + i].offset);
  }
}

TEST_CASE("a Data with a bad CRC is dropped and asked again at once") {
  Fixture f;
  f.hub.rules.bad_crc_once = {kHeader + 1000};
  f.offer(UpdateAction::fetch);
  REQUIRE(f.run_to(UpdateStage::verified));
  CHECK(std::count_if(f.hub.gets.begin(), f.hub.gets.end(),
                      [](const auto& get) { return get.offset == kHeader + 1000; }) == 2);
  CHECK(f.slot() == f.file.image);
  // The header's CRC too: asked again, not refused.
  Fixture g;
  g.hub.rules.bad_crc_once = {0};
  g.offer(UpdateAction::fetch);
  REQUIRE(g.run_to(UpdateStage::verified));
  CHECK(std::count_if(g.hub.gets.begin(), g.hub.gets.end(),
                      [](const auto& get) { return get.offset == 0; }) == 2);
}

TEST_CASE("Data nobody asked for is dropped: no Get, another image, another link, wrong length") {
  Fixture f;
  f.hub.rules.ignore_always = true;
  f.offer(UpdateAction::fetch);
  f.hub.serve();
  const Bytes file = f.file.file();
  f.bench.deliver_link(LinkKind::network, device::LinkEventKind::packet,
                       data_frame(f.file.id, file, 0, 128));
  f.hub.serve();
  const std::size_t changes = f.writes();
  const std::size_t gets = f.hub.gets.size();
  // Not asked for (the next sector's first piece is not out yet).
  f.bench.deliver_link(LinkKind::network, device::LinkEventKind::packet,
                       data_frame(f.file.id, file, kHeader + 3 * kSector, 1000));
  // Another image's id.
  protocol::ImageId other = f.file.id;
  other[0] ^= 1;
  f.bench.deliver_link(LinkKind::network, device::LinkEventKind::packet,
                       data_frame(other, file, kHeader, 1000));
  // The right piece on the wrong link.
  f.bench.deliver_link(LinkKind::usb, device::LinkEventKind::packet,
                       data_frame(f.file.id, file, kHeader, 1000));
  // The right offset, the wrong length: dropped, and asked again.
  f.bench.deliver_link(LinkKind::network, device::LinkEventKind::packet,
                       data_frame(f.file.id, file, kHeader, 999));
  f.hub.serve();
  CHECK(f.writes() == changes);
  CHECK(f.hub.gets.size() == gets + 1);
  CHECK(f.hub.gets.back().offset == kHeader);
  const auto codes = f.bench.log_codes();
  CHECK(std::count(codes.begin(), codes.end(), device::log_code::transfer_dropped) >= 1);
  // The transfer goes on.
  f.hub.rules.ignore_always = false;
  REQUIRE(f.run_to(UpdateStage::verified));
  CHECK(f.slot() == f.file.image);
}

TEST_CASE("each sector is erased, then written, in order, once; the slot holds the image") {
  Fixture f(70000);  // 17 full sectors and 368 bytes
  f.offer(UpdateAction::fetch);
  REQUIRE(f.run_to(UpdateStage::verified));
  std::vector<FlashOp> slot_ops;
  for (std::size_t i = f.ops_at_start; i < f.bench.power.ops.size(); ++i) {
    const FlashOp& op = f.bench.power.ops[i];
    if (op.kind == FlashOp::Kind::slot_erase || op.kind == FlashOp::Kind::slot_write) {
      slot_ops.push_back(op);
    }
  }
  REQUIRE(slot_ops.size() == 36);
  for (std::uint32_t sector = 0; sector < 18; ++sector) {
    const FlashOp& erase = slot_ops[2 * sector];
    const FlashOp& write = slot_ops[2 * sector + 1];
    CHECK(erase.kind == FlashOp::Kind::slot_erase);
    CHECK(erase.offset == sector * kSector);
    CHECK(write.kind == FlashOp::Kind::slot_write);
    CHECK(write.offset == sector * kSector);
    CHECK(write.size == (sector < 17 ? kSector : 70000 - 17 * kSector));
  }
  CHECK(f.slot() == f.file.image);
  // Then read back whole, once, in order, for the hash.
  const auto reads = f.ops(FlashOp::Kind::slot_read);
  REQUIRE(reads.size() == 18);
  for (std::uint32_t sector = 0; sector < 18; ++sector) {
    CHECK(reads[sector].offset == sector * kSector);
  }
}

TEST_CASE("the record: at the start before any erase, every 64 KB, and when verified") {
  Fixture f(140000);  // 35 sectors: checkpoints after 16 and 32
  f.offer(UpdateAction::fetch);
  REQUIRE(f.run_to(UpdateStage::verified));
  const auto records = f.records();
  REQUIRE(records.size() == 4);
  CHECK(records[0] == Rec(1, kHeader));
  CHECK(records[1] == Rec(1, kHeader + 65536));
  CHECK(records[2] == Rec(1, kHeader + 131072));
  CHECK(records[3] == Rec(2, kHeader + 140000));
  // The first record write comes before the first erase; each checkpoint after its 16th sector.
  std::size_t first_record = 0;
  std::size_t first_erase = 0;
  std::size_t writes_before_second = 0;
  for (std::size_t i = f.ops_at_start, n = 0; i < f.bench.power.ops.size(); ++i) {
    const FlashOp& op = f.bench.power.ops[i];
    if (op.kind == FlashOp::Kind::record_write && op.key == device::StoreKey::update) {
      n += 1;
      if (n == 1) {
        first_record = i;
      }
      if (n == 2) {
        writes_before_second = f.ops(FlashOp::Kind::slot_write).size();
        for (std::size_t j = i; j < f.bench.power.ops.size(); ++j) {
          writes_before_second -= f.bench.power.ops[j].kind == FlashOp::Kind::slot_write ? 1 : 0;
        }
      }
    }
    if (op.kind == FlashOp::Kind::slot_erase && first_erase == 0) {
      first_erase = i;
    }
  }
  CHECK(first_record < first_erase);
  CHECK(writes_before_second == 16);
  const auto packet = f.last_status();
  REQUIRE(packet.has_value());
  CHECK(packet->status.bytes_written == kHeader + 140000);
  CHECK(packet->status.image_id == f.file.id);
  CHECK(f.bench.update().active());  // a verified image waiting for the go-ahead
  CHECK(f.bench.instance->device.next_wake().deepest == SleepDepth::deep);
}

TEST_CASE("an image that ends on a 64 KB boundary takes no checkpoint at its end") {
  Fixture f(65536);
  f.offer(UpdateAction::fetch);
  REQUIRE(f.run_to(UpdateStage::verified));
  const auto records = f.records();
  REQUIRE(records.size() == 2);
  CHECK(records[0].second == kHeader);
  CHECK(records[1] == Rec(2, kHeader + 65536));
}

TEST_CASE("progress goes on links every 256 KB, and never as a LoRa packet") {
  BenchOptions large;
  large.capacity = 320 * 1024;
  Fixture f(300000, large);
  f.offer(UpdateAction::fetch);
  REQUIRE(f.run_to(UpdateStage::verified));
  std::vector<device::UpdatePacket> fetching;
  for (const auto& p : f.packets) {
    if (p.kind == UpdatePacketKind::status && p.status.stage == UpdateStage::fetching) {
      fetching.push_back(p);
    }
  }
  REQUIRE(fetching.size() == 1);
  CHECK(fetching[0].links_only);
  CHECK(fetching[0].status.bytes_written == kHeader + 262144);
  CHECK_FALSE(f.last_status()->links_only);
}

TEST_CASE("check 7: an image that reads back wrong is refused, and the next pull starts again") {
  Fixture f(70000);
  bool damaged = false;
  f.bench.slots.after_write = [&] {
    if (!damaged) {
      damaged = true;
      f.bench.slots.bytes[static_cast<std::size_t>(f.bench.slots.other_slot())][10] ^= 0x01;
    }
  };
  f.offer(UpdateAction::fetch);
  REQUIRE(f.run_to(UpdateStage::refused));
  const auto status = f.last_status();
  CHECK(status->status.reason == UpdateReason::hash_mismatch);
  CHECK(status->status.bytes_written == 0);
  CHECK_FALSE(f.bench.storage.has(device::StoreKey::update));
  CHECK(f.bench.log_value(device::log_code::update_refused) == UpdateReason::hash_mismatch);
  // From zero: the header first again.
  f.hub.gets.clear();
  f.packets.clear();
  f.offer(UpdateAction::fetch);
  f.hub.serve();
  REQUIRE_FALSE(f.hub.gets.empty());
  CHECK(f.hub.gets[0].offset == 0);
  REQUIRE(f.run_to(UpdateStage::verified));
  CHECK(f.slot() == f.file.image);
}

TEST_CASE("a reset resumes at the checkpoint: the query says so, and the pull asks from there") {
  Fixture f(140000);
  f.offer(UpdateAction::fetch);
  REQUIRE(run(f.bench, f.hub, [&] { return f.ops(FlashOp::Kind::slot_write).size() >= 20; }));
  f.bench.boot(device::BootKind::other_reset);
  const auto query = f.bench.take_packet();
  REQUIRE(query.has_value());
  REQUIRE(query->kind == UpdatePacketKind::query);
  CHECK(query->query.image_id == f.file.id);
  CHECK(query->query.held == protocol::UpdateHeld::part);
  CHECK(query->query.bytes_held == kHeader + 65536);
  CHECK(query->query.flags.has_wifi_details);
  CHECK_FALSE(query->query.flags.external_power);
  // Sector 16 again, without the header.
  const std::size_t before = f.hub.gets.size();
  f.offer(UpdateAction::fetch);
  f.hub.serve();
  REQUIRE(f.hub.gets.size() > before);
  CHECK(f.hub.gets[before].offset == kHeader + 65536);
  CHECK(std::none_of(f.hub.gets.begin() + static_cast<std::ptrdiff_t>(before), f.hub.gets.end(),
                     [](const auto& get) { return get.offset < kHeader + 65536; }));
  CHECK(f.bench.crypto.verifies == 1);  // the header is not checked again
  REQUIRE(f.run_to(UpdateStage::verified));
  CHECK(f.slot() == f.file.image);
}

TEST_CASE("a lost link: what is written stays, the device waits, asks on the new link, resumes") {
  Fixture f(140000);
  f.offer(UpdateAction::fetch);
  REQUIRE(run(f.bench, f.hub, [&] { return f.ops(FlashOp::Kind::slot_write).size() >= 20; }));
  f.bench.update().link_changed(LinkKind::network, false, f.bench.now);
  const std::size_t gets = f.hub.gets.size();
  // Waiting, light sleep allowed, until two minutes are up.
  const device::Wake wake = f.bench.instance->device.next_wake();
  CHECK(wake.deepest == SleepDepth::light);
  CHECK(wake.at == f.bench.now + device::seconds(120));
  f.bench.advance(device::seconds(30));
  f.bench.update().link_changed(LinkKind::network, true, f.bench.now);
  const auto query = f.bench.take_packet();
  REQUIRE(query.has_value());
  CHECK(query->kind == UpdatePacketKind::query);
  CHECK(query->query.bytes_held == kHeader + 65536);
  CHECK(f.hub.gets.size() == gets);
  // The grant on the new link: it resumes where it stopped, not at the checkpoint.
  f.offer(UpdateAction::fetch);
  f.hub.serve();
  REQUIRE(f.hub.gets.size() > gets);
  CHECK(f.hub.gets[gets].offset == kHeader + 20 * kSector);
  REQUIRE(f.run_to(UpdateStage::verified));
  CHECK(f.slot() == f.file.image);
  CHECK(f.ops(FlashOp::Kind::slot_write).size() == 35);
}

TEST_CASE("a lost link: another link coming up is asked on as well (a gateway back on Wi-Fi)") {
  BenchOptions gateway;
  gateway.role = protocol::Role::gateway;
  Fixture f(140000, gateway);
  f.offer(UpdateAction::fetch, UpdatePath::usb);
  Source usb(f.bench, LinkKind::usb, f.file.file());
  REQUIRE(run(f.bench, usb, [&] { return f.ops(FlashOp::Kind::slot_write).size() >= 20; }));
  f.bench.update().link_changed(LinkKind::usb, false, f.bench.now);
  f.bench.update().link_changed(LinkKind::network, true, f.bench.now);
  const auto query = f.bench.take_packet();
  REQUIRE(query.has_value());
  CHECK(query->kind == UpdatePacketKind::query);
  CHECK(query->query.held == protocol::UpdateHeld::part);
  f.offer(UpdateAction::fetch, UpdatePath::network);
  f.hub.serve();
  REQUIRE_FALSE(f.hub.gets.empty());
  CHECK(f.hub.gets[0].offset == kHeader + 20 * kSector);
  REQUIRE(f.run_to(UpdateStage::verified));
  CHECK(f.slot() == f.file.image);
}

TEST_CASE("a link down for two minutes ends the transfer as linkLost, keeping the part") {
  Fixture f(140000);
  f.offer(UpdateAction::fetch);
  REQUIRE(run(f.bench, f.hub, [&] { return f.ops(FlashOp::Kind::slot_write).size() >= 20; }));
  const Instant down = f.bench.now;
  f.bench.update().link_changed(LinkKind::network, false, down);
  f.bench.advance_to(down + device::seconds(120) + device::microseconds(-1));
  CHECK_FALSE(f.bench.take_packet().has_value());
  f.bench.advance_to(down + device::seconds(120));
  const auto packet = f.bench.take_packet();
  REQUIRE(packet.has_value());
  CHECK(packet->status.stage == UpdateStage::refused);
  CHECK(packet->status.reason == UpdateReason::link_lost);
  CHECK(packet->status.bytes_written == kHeader + 65536);
  CHECK(f.bench.storage.has(device::StoreKey::update));
  CHECK_FALSE(f.bench.update().active());
}

TEST_CASE("an up link where no Data comes for two minutes also ends as linkLost") {
  Fixture f;
  f.hub.rules.ignore_always = true;
  f.offer(UpdateAction::fetch);
  const Instant start = f.bench.now;
  f.hub.serve();
  run(f.bench, f.hub, [&] { return f.bench.now >= start + device::seconds(118); });
  CHECK_FALSE(f.bench.take_packet().has_value());
  // Asked again every 2 s meanwhile.
  CHECK(f.hub.gets.size() >= 59);
  run(f.bench, f.hub,
      [&] { return f.bench.update().next_packet(f.bench.now).kind != UpdatePacketKind::none; });
  CHECK(f.bench.now == start + device::seconds(120));
  const auto packet = f.bench.take_packet();
  REQUIRE(packet.has_value());
  CHECK(packet->status.reason == UpdateReason::link_lost);
}

TEST_CASE("a Get the link will not take goes again after 100 ms") {
  Fixture f;
  f.bench.network.send_error = HalError::busy;
  f.offer(UpdateAction::fetch);
  CHECK(f.bench.network.sent.empty());
  const device::Wake wake = f.bench.instance->device.next_wake();
  CHECK(wake.at == f.bench.now + device::milliseconds(100));
  f.bench.network.send_error = HalError::none;
  f.bench.advance(device::milliseconds(100));
  REQUIRE(f.bench.network.sent.size() == 1);
  CHECK(decode_get(f.bench.network.sent[0]).offset == 0);
}

TEST_CASE("Gone stops the pull and keeps the part; the next offer resumes it") {
  Fixture f(140000);
  f.offer(UpdateAction::fetch);
  REQUIRE(run(f.bench, f.hub, [&] { return f.ops(FlashOp::Kind::slot_write).size() >= 18; }));
  f.hub.rules.gone = protocol::GoneReason::paused;
  REQUIRE(run(f.bench, f.hub, nullptr) == false);
  CHECK_FALSE(f.bench.update().active());
  CHECK(f.bench.instance->device.next_wake().at.is_never());
  CHECK_FALSE(f.bench.take_packet().has_value());
  CHECK(f.bench.storage.has(device::StoreKey::update));
  f.hub.rules.gone.reset();
  const std::size_t before = f.hub.gets.size();
  f.offer(UpdateAction::fetch);
  f.hub.serve();
  CHECK(f.hub.gets[before].offset >= kHeader + 65536);
  REQUIRE(f.run_to(UpdateStage::verified));
  CHECK(f.slot() == f.file.image);
}

TEST_CASE("a flash fault is refused as flash, and the part to the checkpoint is kept") {
  Fixture f(140000);
  f.offer(UpdateAction::fetch);
  REQUIRE(run(f.bench, f.hub, [&] { return f.ops(FlashOp::Kind::slot_write).size() >= 17; }));
  f.bench.slots.fail_erase = true;
  REQUIRE(f.run_to(UpdateStage::refused));
  CHECK(f.last_status()->status.reason == UpdateReason::flash);
  CHECK(f.last_status()->status.bytes_written == kHeader + 65536);
  CHECK(f.bench.storage.has(device::StoreKey::update));
  f.bench.slots.fail_erase = false;
  f.packets.clear();
  f.offer(UpdateAction::fetch);
  REQUIRE(f.run_to(UpdateStage::verified));
  CHECK(f.slot() == f.file.image);
  // A record that cannot be written at the start refuses before any erase.
  Fixture g;
  g.bench.storage.fail_writes = true;
  g.offer(UpdateAction::fetch);
  REQUIRE(g.run_to(UpdateStage::refused));
  CHECK(g.last_status()->status.reason == UpdateReason::flash);
  CHECK(g.ops(FlashOp::Kind::slot_erase).empty());
}

TEST_CASE("install now: read back again, select, say installing, restart once it is sent") {
  Fixture f;
  f.offer(UpdateAction::fetch);
  REQUIRE(f.run_to(UpdateStage::verified));
  const std::uint32_t hashes = f.bench.crypto.sha_starts;
  f.offer(UpdateAction::install_now);
  CHECK(f.bench.crypto.sha_starts == hashes + 1);
  // The read-back runs in steps of 4 sectors, a millisecond apart, awake.
  const device::Wake stepping = f.bench.instance->device.next_wake();
  CHECK(stepping.deepest == SleepDepth::awake);
  CHECK(stepping.at == f.bench.now + device::milliseconds(1));
  CHECK(f.ops(FlashOp::Kind::slot_read).size() == 18 + 4);
  CHECK(f.bench.slots.select_calls == 0);
  REQUIRE(run(f.bench, f.hub, [&] { return f.bench.slots.select_calls > 0; }));
  CHECK(f.ops(FlashOp::Kind::slot_read).size() == 36);
  const auto packet = f.bench.update().next_packet(f.bench.now);
  REQUIRE(packet.kind == UpdatePacketKind::status);
  CHECK(packet.status.stage == UpdateStage::installing);
  CHECK(packet.status.image_id == f.file.id);
  CHECK_FALSE(f.bench.instance->device.next_wake().restart);
  f.bench.update().packet_sent(f.bench.now);
  CHECK(f.bench.instance->device.next_wake().restart);
  // Offers change nothing now.
  f.offer(UpdateAction::nothing);
  CHECK(f.bench.storage.has(device::StoreKey::update));
  f.bench.boot(device::BootKind::other_reset);
  CHECK(f.bench.update().running().on_trial);
  CHECK(f.bench.update().running().version.minor == 1);
}

TEST_CASE("installing restarts after 10 s even when the role cannot send the status") {
  Fixture f;
  f.offer(UpdateAction::fetch);
  REQUIRE(f.run_to(UpdateStage::verified));
  f.offer(UpdateAction::install_now);
  REQUIRE(run(f.bench, f.hub, [&] { return f.bench.slots.select_calls > 0; }));
  const Instant selected = f.bench.now;
  CHECK(f.bench.instance->device.next_wake().at == selected + device::seconds(10));
  f.bench.advance_to(selected + device::seconds(10) + device::microseconds(-1));
  CHECK_FALSE(f.bench.instance->device.next_wake().restart);
  f.bench.advance_to(selected + device::seconds(10));
  CHECK(f.bench.instance->device.next_wake().restart);
}

TEST_CASE("check 8: an image select() refuses is imageCheck, and the record goes") {
  // The image hashes right but is not one the bootloader would run.
  Bytes image = make_image(kNew, 70000);
  image[100] ^= 0xFF;
  Fixture f;
  f.file = make_file(image);
  Source hub(f.bench, LinkKind::network, f.file.file());
  f.bench.update().offer(make_offer(UpdateAction::fetch, f.file), UpdatePath::network, f.bench.now);
  std::vector<device::UpdatePacket> packets;
  const auto stage_seen = [&](std::uint8_t stage) {
    return std::any_of(packets.begin(), packets.end(),
                       [&](const auto& p) { return p.status.stage == stage; });
  };
  REQUIRE(run(
      f.bench, hub, [&] { return stage_seen(UpdateStage::verified); },
      [&](const auto& p) { packets.push_back(p); }));
  f.bench.update().offer(make_offer(UpdateAction::install_now, f.file), UpdatePath::network,
                         f.bench.now);
  REQUIRE(run(
      f.bench, hub, [&] { return stage_seen(UpdateStage::refused); },
      [&](const auto& p) { packets.push_back(p); }));
  CHECK(packets.back().status.reason == UpdateReason::image_check);
  CHECK_FALSE(f.bench.storage.has(device::StoreKey::update));
  CHECK_FALSE(f.bench.instance->device.next_wake().restart);
  // An I/O fault in select keeps the verified image.
  Fixture g;
  g.offer(UpdateAction::fetch);
  REQUIRE(g.run_to(UpdateStage::verified));
  g.bench.slots.fail_select_io = true;
  g.offer(UpdateAction::install_now);
  REQUIRE(g.run_to(UpdateStage::refused));
  CHECK(g.last_status()->status.reason == UpdateReason::flash);
  CHECK(g.bench.storage.has(device::StoreKey::update));
}

TEST_CASE("install now without a verified image of that id: a query, nothing selected") {
  Fixture f(140000);
  f.offer(UpdateAction::install_now);
  auto packet = f.bench.take_packet();
  REQUIRE(packet.has_value());
  CHECK(packet->kind == UpdatePacketKind::query);
  CHECK(packet->query.held == protocol::UpdateHeld::nothing);
  f.offer(UpdateAction::fetch);
  REQUIRE(run(f.bench, f.hub, [&] { return f.ops(FlashOp::Kind::slot_write).size() >= 20; }));
  f.bench.update().offer(make_offer(UpdateAction::wait, f.file), UpdatePath::network, f.bench.now);
  f.offer(UpdateAction::install_now);
  packet = f.bench.take_packet();
  REQUIRE(packet.has_value());
  CHECK(packet->query.held == protocol::UpdateHeld::part);
  CHECK(f.bench.slots.select_calls == 0);
}

TEST_CASE("a verified image offered again is reported verified, not pulled again") {
  Fixture f;
  f.offer(UpdateAction::fetch);
  REQUIRE(f.run_to(UpdateStage::verified));
  const std::size_t gets = f.hub.gets.size();
  f.bench.boot(device::BootKind::other_reset);
  auto query = f.bench.take_packet();
  REQUIRE(query.has_value());
  CHECK(query->query.held == protocol::UpdateHeld::verified);
  CHECK(query->query.bytes_held == kHeader + 70000);
  f.offer(UpdateAction::fetch);
  f.hub.serve();
  CHECK(f.hub.gets.size() == gets);
  const auto status = f.bench.take_packet();
  REQUIRE(status.has_value());
  CHECK(status->status.stage == UpdateStage::verified);
  CHECK(status->status.bytes_written == kHeader + 70000);
}

TEST_CASE("the same fetch offered while pulling changes nothing; another image starts over") {
  Fixture f(140000);
  f.offer(UpdateAction::fetch);
  REQUIRE(run(f.bench, f.hub, [&] { return f.ops(FlashOp::Kind::slot_write).size() >= 3; }));
  f.offer(UpdateAction::fetch);
  f.hub.serve();
  CHECK(std::count_if(f.hub.gets.begin(), f.hub.gets.end(),
                      [](const auto& get) { return get.offset == 0; }) == 1);
  // Another image: its header first; the record changes only once that header passes.
  ImageFile other = make_file(make_image({2, 0, 0}, 50000, 3));
  f.bench.network.handled = f.bench.network.sent.size();  // the first image's Gets, left
  Source hub(f.bench, LinkKind::network, other.file());
  hub.rules.ignore_always = true;
  f.bench.update().offer(make_offer(UpdateAction::fetch, other), UpdatePath::network, f.bench.now);
  hub.serve();
  REQUIRE(hub.gets.size() == 1);
  CHECK(hub.gets[0].offset == 0);
  CHECK(hub.gets[0].image_id == other.id);
  const Bytes record = f.bench.storage.records[device::StoreKey::update];
  CHECK(Bytes(record.begin() + 1, record.begin() + 129) == f.file.header_bytes);
}

TEST_CASE("action 0 discards what is held and says cancelled; action 5 stops and keeps it") {
  Fixture f(140000);
  f.offer(UpdateAction::fetch);
  REQUIRE(run(f.bench, f.hub, [&] { return f.ops(FlashOp::Kind::slot_write).size() >= 20; }));
  f.offer(UpdateAction::wait);
  CHECK_FALSE(f.bench.update().active());
  CHECK(f.bench.storage.has(device::StoreKey::update));
  CHECK_FALSE(f.bench.take_packet().has_value());
  const std::size_t sent = f.bench.network.sent.size();
  f.bench.advance(device::seconds(10));
  CHECK(f.bench.network.sent.size() == sent);
  CHECK(f.bench.instance->device.next_wake().at.is_never());
  f.offer(UpdateAction::nothing);
  CHECK_FALSE(f.bench.storage.has(device::StoreKey::update));
  const auto packet = f.bench.take_packet();
  REQUIRE(packet.has_value());
  CHECK(packet->status.stage == UpdateStage::cancelled);
  CHECK(packet->status.image_id == f.file.id);
  // With nothing held, nothing to say.
  Fixture g;
  g.offer(UpdateAction::nothing);
  CHECK_FALSE(g.bench.take_packet().has_value());
  CHECK(g.writes() == 0);
}

TEST_CASE("an unknown action is logged and changes nothing") {
  Fixture f;
  f.offer(9);
  CHECK(f.bench.network.sent.empty());
  CHECK_FALSE(f.bench.take_packet().has_value());
  CHECK(f.bench.log_value(device::log_code::unknown_type) == 9);
}

TEST_CASE("a reply's update flag asks for a query, with the device's facts") {
  BenchOptions no_wifi;
  no_wifi.wifi_details = false;
  Fixture f(70000, no_wifi);
  protocol::Reply reply;
  f.bench.update().update_flag(reply, f.bench.now);
  CHECK_FALSE(f.bench.take_packet().has_value());
  reply.flags.update_available = true;
  f.bench.supply.external = true;
  f.bench.update().update_flag(reply, f.bench.now);
  const auto packet = f.bench.take_packet();
  REQUIRE(packet.has_value());
  REQUIRE(packet->kind == UpdatePacketKind::query);
  CHECK(packet->query.image_id == protocol::ImageId{});
  CHECK(packet->query.held == protocol::UpdateHeld::nothing);
  CHECK(packet->query.bytes_held == 0);
  CHECK_FALSE(packet->query.flags.has_wifi_details);
  CHECK(packet->query.flags.external_power);
  CHECK_FALSE(f.bench.take_packet().has_value());
  // Not again while a pull is under way.
  f.offer(UpdateAction::fetch);
  f.bench.update().update_flag(reply, f.bench.now);
  CHECK_FALSE(f.bench.take_packet().has_value());
}

TEST_CASE("a status waiting goes before a query, and each is sent once") {
  Fixture f;
  f.hub.rules.ignore_always = true;
  protocol::Reply reply;
  reply.flags.update_available = true;
  f.bench.update().update_flag(reply, f.bench.now);
  f.bench.update().offer(make_offer(UpdateAction::join_wifi_and_fetch, f.file), UpdatePath::radio,
                         f.bench.now);
  // join: a query waits (from the flag); a refusal now would go first.
  f.bench.update().offer(make_offer(UpdateAction::nothing, f.file), UpdatePath::radio, f.bench.now);
  auto first = f.bench.take_packet();
  REQUIRE(first.has_value());
  CHECK(first->kind == UpdatePacketKind::status);
  CHECK(first->status.stage == UpdateStage::cancelled);
  auto second = f.bench.take_packet();
  REQUIRE(second.has_value());
  CHECK(second->kind == UpdatePacketKind::query);
  CHECK_FALSE(f.bench.take_packet().has_value());
}

TEST_CASE("join Wi-Fi: connect with the pairing's network, ask on it, pull, leave on refusal") {
  Fixture f;
  f.offer(UpdateAction::join_wifi_and_fetch, UpdatePath::radio);
  CHECK(f.bench.network.connects == 1);
  CHECK(f.bench.network.last_wifi_name == "home");
  CHECK(f.bench.instance->device.next_wake().at == f.bench.now + device::seconds(30));
  CHECK_FALSE(f.bench.take_packet().has_value());
  f.bench.network.is_up = true;
  f.bench.update().link_changed(LinkKind::network, true, f.bench.now);
  const auto query = f.bench.take_packet();
  REQUIRE(query.has_value());
  CHECK(query->kind == UpdatePacketKind::query);
  f.offer(UpdateAction::fetch, UpdatePath::network);
  f.hub.rules.bad_crc_once = {0};
  f.hub.serve();
  f.bench.slots.fail_erase = true;
  REQUIRE(f.run_to(UpdateStage::refused));
  CHECK(f.bench.network.disconnects == 1);
}

TEST_CASE("join Wi-Fi: once the image is verified the sensor leaves the network") {
  Fixture f;
  f.offer(UpdateAction::join_wifi_and_fetch, UpdatePath::radio);
  f.bench.network.is_up = true;
  f.bench.update().link_changed(LinkKind::network, true, f.bench.now);
  REQUIRE(f.bench.take_packet()->kind == UpdatePacketKind::query);
  f.offer(UpdateAction::fetch);
  REQUIRE(f.run_to(UpdateStage::verified));
  CHECK(f.bench.network.disconnects == 1);
  CHECK_FALSE(f.bench.network.connecting);
  // A network the service did not join (a siren's) is never left.
  Fixture g;
  g.bench.network.is_up = true;
  g.offer(UpdateAction::fetch);
  REQUIRE(g.run_to(UpdateStage::verified));
  CHECK(g.bench.network.disconnects == 0);
}

TEST_CASE("join Wi-Fi: no network in 30 s is noWifi, a network without the hub hubNotFound") {
  for (const std::int8_t signal : {std::int8_t{0}, std::int8_t{-60}}) {
    CAPTURE(signal);
    Fixture f;
    f.offer(UpdateAction::join_wifi_and_fetch, UpdatePath::radio);
    f.bench.network.signal = signal;
    const Instant start = f.bench.now;
    f.bench.advance_to(start + device::seconds(30) + device::microseconds(-1));
    CHECK_FALSE(f.bench.take_packet().has_value());
    f.bench.advance_to(start + device::seconds(30));
    const auto packet = f.bench.take_packet();
    REQUIRE(packet.has_value());
    CHECK(packet->status.stage == UpdateStage::refused);
    CHECK(packet->status.reason ==
          (signal == 0 ? UpdateReason::no_wifi : UpdateReason::hub_not_found));
    CHECK(f.bench.network.disconnects == 1);
  }
  // Joined, asked, and no grant for 30 s: linkLost, and it leaves.
  Fixture g;
  g.offer(UpdateAction::join_wifi_and_fetch, UpdatePath::radio);
  g.bench.network.is_up = true;
  g.bench.update().link_changed(LinkKind::network, true, g.bench.now);
  REQUIRE(g.bench.take_packet().has_value());
  g.bench.advance(device::seconds(30));
  const auto packet = g.bench.take_packet();
  REQUIRE(packet.has_value());
  CHECK(packet->status.reason == UpdateReason::link_lost);
  CHECK(g.bench.network.disconnects == 1);
}

TEST_CASE("join Wi-Fi without details, or without a network link, is noWifi at once") {
  BenchOptions none;
  none.wifi_details = false;
  Fixture f(70000, none);
  f.offer(UpdateAction::join_wifi_and_fetch, UpdatePath::radio);
  CHECK(f.bench.network.connects == 0);
  const auto packet = f.bench.take_packet();
  REQUIRE(packet.has_value());
  CHECK(packet->status.reason == UpdateReason::no_wifi);
  CHECK(packet->status.image_id == f.file.id);
  // A link already up (a siren's) is asked on at once, not joined again.
  Fixture g;
  g.bench.network.is_up = true;
  g.offer(UpdateAction::join_wifi_and_fetch, UpdatePath::network);
  CHECK(g.bench.network.connects == 0);
  REQUIRE(g.bench.take_packet()->kind == UpdatePacketKind::query);
}

TEST_CASE("a joined network that drops is joined again on the back-off, then the pull resumes") {
  Fixture f(140000);
  f.offer(UpdateAction::join_wifi_and_fetch, UpdatePath::radio);
  f.bench.network.is_up = true;
  f.bench.update().link_changed(LinkKind::network, true, f.bench.now);
  REQUIRE(f.bench.take_packet().has_value());
  f.offer(UpdateAction::fetch);
  REQUIRE(run(f.bench, f.hub, [&] { return f.ops(FlashOp::Kind::slot_write).size() >= 5; }));
  const Instant down = f.bench.now;
  f.bench.network.is_up = false;
  f.bench.update().link_changed(LinkKind::network, false, down);
  // Connects again at 1 s, then 2 s and 4 s after each try.
  f.bench.advance_to(down + device::seconds(1));
  CHECK(f.bench.network.connects == 2);
  f.bench.advance_to(down + device::seconds(3));
  CHECK(f.bench.network.connects == 3);
  f.bench.advance_to(down + device::seconds(7));
  CHECK(f.bench.network.connects == 4);
  f.bench.network.is_up = true;
  f.bench.update().link_changed(LinkKind::network, true, f.bench.now);
  REQUIRE(f.bench.take_packet()->kind == UpdatePacketKind::query);
  f.offer(UpdateAction::fetch);
  REQUIRE(f.run_to(UpdateStage::verified));
  CHECK(f.slot() == f.file.image);
}

TEST_CASE("idle, the service asks nothing of the chip; pulling allows light sleep only") {
  Fixture f;
  device::Wake wake = f.bench.update().next_wake();
  CHECK(wake.at.is_never());
  CHECK(wake.deepest == SleepDepth::deep);
  CHECK_FALSE(f.bench.update().active());
  f.hub.rules.ignore_always = true;
  f.offer(UpdateAction::fetch);
  f.hub.serve();
  wake = f.bench.update().next_wake();
  CHECK(wake.deepest == SleepDepth::light);
  CHECK(wake.at == f.bench.now + device::seconds(2));
  CHECK(f.bench.instance->device.next_wake().deepest == SleepDepth::light);
}

}  // namespace
}  // namespace hsn::test::update
