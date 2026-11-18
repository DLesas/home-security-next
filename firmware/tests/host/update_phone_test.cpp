// ScriptPhone, the phone's part of a Bluetooth update (m3-updates-design.md section 5), driven from
// the board's side of its Bluetooth wire with frames from the codec: the Open tag against the
// vectors, Gets answered from the file with their CRC, Gone outside it, wrong tags, a drop and its
// resume, a corrupted piece, and a phone that comes late.

#include <doctest/doctest.h>

#include <filesystem>
#include <optional>
#include <vector>

#include "hsn/host/script_phone.hpp"
#include "hsn/host/test_image.hpp"
#include "hsn/protocol/checksum.hpp"
#include "sim_support.hpp"
#include "support.hpp"

namespace hsn::test {
namespace {

using device::HalError;
namespace transfer = protocol::transfer;

template <typename Frame>
Bytes encode(const Frame& frame) {
  Bytes bytes(1100);
  const auto size =
      protocol::encode_transfer(frame, protocol::MutableByteView(bytes.data(), bytes.size()));
  REQUIRE(size.ok());
  bytes.resize(size.value());
  return bytes;
}

/** What the phone sent, decoded. */
struct FromPhone {
  std::vector<transfer::Open> opens;
  std::vector<transfer::Data> data;
  std::vector<Bytes> data_bytes;
  std::vector<transfer::Gone> gones;
};

/** The vectors' first Hello: a session key, an address, a device random and an image id. */
struct VectorSession {
  VectorSession() {
    const json file = load_json(std::filesystem::path(HSN_VECTORS_DIR) / "ble-update-session.json");
    const json& item = file.at("openTags").at(0);
    const Bytes key = from_hex(item.at("sessionKey").get<std::string>());
    std::copy(key.begin(), key.end(), session.session_key.begin());
    session.address = item.at("address").get<std::uint32_t>();
    const Bytes random_bytes = from_hex(item.at("deviceRandom").get<std::string>());
    std::copy(random_bytes.begin(), random_bytes.end(), random.begin());
    const Bytes image = from_hex(item.at("imageId").get<std::string>());
    std::copy(image.begin(), image.end(), session.image.begin());
    tag = from_hex(item.at("tag").get<std::string>());
    session.file.resize(3000);
    for (std::size_t i = 0; i < session.file.size(); ++i) {
      session.file[i] = static_cast<std::uint8_t>(i * 7 + 3);
    }
  }
  host::BluetoothSession session;
  protocol::DeviceRandom random{};
  Bytes tag;
};

/** The board's side of a Bluetooth wire, with a phone at the far end. */
struct Bench {
  explicit Bench(host::ScriptPhoneOptions options = {})
      : link(clock, device::LinkKind::bluetooth),
        wire(scheduler, timeline, labels, timeline.add_actor("board"), link,
             [this](const host::LinkWire::Build& build) {
               const device::LinkEvent event = build();
               on_event(event);
               return true;
             }),
        phone(scheduler, wire, vector.session, options) {}

  void on_event(const device::LinkEvent& event) {
    if (event.kind == device::LinkEventKind::up) {
      ups += 1;
      if (hello_on_up) {
        send_hello();
      }
      return;
    }
    if (event.kind == device::LinkEventKind::down) {
      downs += 1;
      return;
    }
    const protocol::Error error = protocol::decode_transfer(event.packet, [&](const auto& frame) {
      using Frame = std::decay_t<decltype(frame)>;
      if constexpr (std::is_same_v<Frame, transfer::Open>) {
        got.opens.push_back(frame);
      } else if constexpr (std::is_same_v<Frame, transfer::Data>) {
        got.data.push_back(frame);
        got.data_bytes.emplace_back(frame.data.bytes.begin(), frame.data.bytes.end());
      } else if constexpr (std::is_same_v<Frame, transfer::Gone>) {
        got.gones.push_back(frame);
      }
    });
    CHECK(error == protocol::Error::none);
  }

  void send(const Bytes& frame) {
    REQUIRE(link.send(view(frame)) == HalError::none);
  }

  void send_hello(std::uint32_t held = 0) {
    transfer::Hello hello;
    hello.address = vector.session.address;
    hello.device_random = vector.random;
    hello.image_id = vector.session.image;
    hello.bytes_held = held;
    hello.largest_data = 164;
    send(encode(hello));
  }

  void get(std::uint32_t offset, std::uint16_t length) {
    transfer::Get request;
    request.image_id = vector.session.image;
    request.offset = offset;
    request.length = length;
    send(encode(request));
  }

  void run_for(device::Duration span) {
    scheduler.run_until(scheduler.now() + span);
  }

  VectorSession vector;
  host::Scheduler scheduler;
  host::Timeline timeline;
  host::PacketLabels labels;
  host::FakeClock clock;
  host::FakeLink link;
  host::LinkWire wire;
  host::ScriptPhone phone;
  FromPhone got;
  int ups = 0;
  int downs = 0;
  bool hello_on_up = true;
};

TEST_CASE("the phone opens with the vectors' tag and serves exactly the bytes asked") {
  Bench bench;
  REQUIRE(bench.link.connect(device::LinkTarget{}) == HalError::none);
  bench.run_for(seconds(1));
  CHECK(bench.ups == 1);
  CHECK(bench.phone.connections == 1);
  REQUIRE(bench.phone.hellos.size() == 1);
  REQUIRE(bench.got.opens.size() == 1);
  CHECK(Bytes(bench.got.opens[0].tag.begin(), bench.got.opens[0].tag.end()) == bench.vector.tag);
  CHECK(bench.phone.wrong_opens == 0);

  const Bytes& file = bench.vector.session.file;
  bench.get(0, 128);
  bench.get(128, 164);
  bench.get(2900, 164);  // runs past the end: what is there
  bench.get(3000, 10);   // at the end: out of range
  bench.run_for(seconds(1));
  REQUIRE(bench.got.data.size() == 3);
  CHECK(bench.got.data[0].offset == 0);
  CHECK(bench.got.data_bytes[0] == Bytes(file.begin(), file.begin() + 128));
  CHECK(bench.got.data[1].offset == 128);
  CHECK(bench.got.data_bytes[1] == Bytes(file.begin() + 128, file.begin() + 292));
  CHECK(bench.got.data_bytes[2] == Bytes(file.begin() + 2900, file.end()));
  for (std::size_t i = 0; i < bench.got.data.size(); ++i) {
    CHECK(bench.got.data[i].image_id == bench.vector.session.image);
    CHECK(bench.got.data[i].crc32 == protocol::crc32(view(bench.got.data_bytes[i])));
  }
  REQUIRE(bench.got.gones.size() == 1);
  CHECK(bench.got.gones[0].reason == protocol::GoneReason::out_of_range);
  CHECK(bench.phone.data_frames == 3);
  CHECK(bench.phone.gone_frames == 1);
  CHECK(bench.phone.served_to == 3000);
  CHECK(bench.phone.oversize == 0);

  // A Get for another image: not available.
  transfer::Get other;
  other.image_id = bench.vector.session.image;
  other.image_id[0] ^= 0xFF;
  other.length = 10;
  bench.send(encode(other));
  // Done ends it.
  transfer::Done done;
  done.image_id = bench.vector.session.image;
  done.result = protocol::DoneResult::verified;
  bench.send(encode(done));
  bench.run_for(seconds(1));
  REQUIRE(bench.got.gones.size() == 2);
  CHECK(bench.got.gones[1].reason == protocol::GoneReason::not_available);
  REQUIRE(bench.phone.done.has_value());
  CHECK(bench.phone.done->result == protocol::DoneResult::verified);
  // A frame a phone never receives is counted, and nothing is sent unasked.
  bench.send(encode(transfer::Open{}));
  const std::size_t answers = bench.got.data.size() + bench.got.gones.size();
  bench.run_for(seconds(5));
  CHECK(bench.phone.unexpected == 1);
  CHECK(bench.got.data.size() + bench.got.gones.size() == answers);
}

TEST_CASE("wrong tags: the first Opens carry one, and the phone connects again each time") {
  host::ScriptPhoneOptions options;
  options.wrong_tags = 2;
  Bench bench(options);
  REQUIRE(bench.link.connect(device::LinkTarget{}) == HalError::none);
  bench.run_for(seconds(1));
  for (int attempt = 0; attempt < 2; ++attempt) {
    // The board refuses the tag: it closes, and advertises again.
    bench.link.disconnect();
    REQUIRE(bench.link.connect(device::LinkTarget{}) == HalError::none);
    bench.run_for(seconds(1));
  }
  REQUIRE(bench.got.opens.size() == 3);
  CHECK(Bytes(bench.got.opens[0].tag.begin(), bench.got.opens[0].tag.end()) != bench.vector.tag);
  CHECK(Bytes(bench.got.opens[1].tag.begin(), bench.got.opens[1].tag.end()) != bench.vector.tag);
  CHECK(Bytes(bench.got.opens[2].tag.begin(), bench.got.opens[2].tag.end()) == bench.vector.tag);
  CHECK(bench.phone.wrong_opens == 2);
  CHECK(bench.phone.connections == 3);
}

TEST_CASE("a drop: the phone reconnects while the board advertises, and serves on") {
  host::ScriptPhoneOptions options;
  options.drop_after_data = 2;
  options.reconnect_after = seconds(3);
  Bench bench(options);
  REQUIRE(bench.link.connect(device::LinkTarget{}) == HalError::none);
  bench.run_for(seconds(1));
  bench.get(0, 100);
  bench.get(100, 100);
  bench.get(200, 100);  // the third is lost to the drop
  bench.run_for(seconds(1));
  CHECK(bench.got.data.size() == 2);
  CHECK(bench.downs == 1);
  CHECK(bench.wire.advertising());
  bench.run_for(seconds(3));
  CHECK(bench.ups == 2);
  CHECK(bench.phone.connections == 2);
  CHECK(bench.phone.hellos.size() == 2);
  bench.get(200, 100);
  bench.run_for(seconds(1));
  REQUIRE(bench.got.data.size() == 3);
  CHECK(bench.got.data[2].offset == 200);
  // It drops only once.
  bench.get(300, 100);
  bench.run_for(seconds(1));
  CHECK(bench.downs == 1);
  // When the board has ended the window, a drop is not followed by a reconnect.
  bench.link.disconnect();
  bench.run_for(seconds(10));
  CHECK(bench.ups == 2);
}

TEST_CASE("a corrupted piece carries a CRC that does not match its data") {
  host::ScriptPhoneOptions options;
  options.corrupt_data = 2;
  Bench bench(options);
  REQUIRE(bench.link.connect(device::LinkTarget{}) == HalError::none);
  bench.run_for(seconds(1));
  bench.get(0, 50);
  bench.get(50, 50);
  bench.get(50, 50);
  bench.run_for(seconds(1));
  REQUIRE(bench.got.data.size() == 3);
  CHECK(bench.got.data[0].crc32 == protocol::crc32(view(bench.got.data_bytes[0])));
  CHECK(bench.got.data[1].crc32 != protocol::crc32(view(bench.got.data_bytes[1])));
  CHECK(bench.got.data[2].crc32 == protocol::crc32(view(bench.got.data_bytes[2])));
}

TEST_CASE("a phone that comes late connects only then; frames over the MTU are counted") {
  host::ScriptPhoneOptions options;
  options.arrives = device::Instant{} + seconds(30);
  options.mtu = 100;
  Bench bench(options);
  REQUIRE(bench.link.connect(device::LinkTarget{}) == HalError::none);
  bench.run_for(seconds(29));
  CHECK(bench.ups == 0);
  bench.run_for(seconds(2));
  CHECK(bench.ups == 1);
  bench.get(0, 100);  // a Data of 118 bytes: over 97
  bench.run_for(seconds(1));
  CHECK(bench.phone.oversize == 1);
}

TEST_CASE("a phone for a simulated board is on that board's Bluetooth wire") {
  host::Simulation sim;
  host::DeviceSpec spec;
  spec.name = "board";
  host::SimDevice& board = sim.add_device(spec);
  VectorSession vector;
  host::ScriptPhone phone(sim, board, vector.session);
  CHECK_FALSE(board.wire(device::LinkKind::bluetooth).attached());
  sim.run_until(at(milliseconds(1)));
  CHECK(board.wire(device::LinkKind::bluetooth).attached());
  CHECK_FALSE(board.wire(device::LinkKind::network).attached());
}

}  // namespace
}  // namespace hsn::test
