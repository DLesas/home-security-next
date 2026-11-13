// The pseudo-terminal link peer (hub-design.md section 11, item 2) over real pseudo-terminals:
// the far end opened as the hub opens it, frames both ways in the USB framing (protocol section
// 10), both framings of a 254-byte frame, a network link up only while the far end holds it, a
// cut and its restore, and a far end that leaves output processing on.

#include <fcntl.h>
#include <poll.h>
#include <termios.h>
#include <unistd.h>

#include <doctest/doctest.h>

#include <algorithm>
#include <string>
#include <vector>

#include "hsn/host/provisioning.hpp"
#include "hsn/host/pty_link.hpp"
#include "hsn/host/sim_time.hpp"
#include "hsn/host/simulation.hpp"
#include "hsn/protocol/framing.hpp"
#include "hsn/protocol/setup.hpp"

namespace hsn::test {
namespace {

using device::LinkKind;
using device::milliseconds;
using device::seconds;
using host::at;
using Bytes = std::vector<std::uint8_t>;

/** The far end of a terminal, opened as the hub opens one: read-write, no controlling tty. */
struct FarEnd {
  explicit FarEnd(const std::string& path, bool raw = true) {
    fd = open(path.c_str(), O_RDWR | O_NOCTTY | O_NONBLOCK);
    REQUIRE(fd >= 0);
    if (raw) {
      termios settings{};
      REQUIRE(tcgetattr(fd, &settings) == 0);
      cfmakeraw(&settings);
      REQUIRE(tcsetattr(fd, TCSANOW, &settings) == 0);
    }
  }
  ~FarEnd() {
    close();
  }
  void close() {
    if (fd >= 0) {
      ::close(fd);
      fd = -1;
    }
  }
  void write_bytes(const Bytes& bytes) const {
    REQUIRE(::write(fd, bytes.data(), bytes.size()) == static_cast<ssize_t>(bytes.size()));
  }
  /** Every whole frame waiting, decoded. */
  std::vector<Bytes> frames() {
    std::vector<std::uint8_t> chunk(4096);
    const ssize_t got = ::read(fd, chunk.data(), chunk.size());
    if (got > 0) {
      stream.insert(stream.end(), chunk.begin(), chunk.begin() + got);
    }
    std::vector<Bytes> decoded;
    for (auto end = std::find(stream.begin(), stream.end(), 0); end != stream.end();
         end = std::find(stream.begin(), stream.end(), 0)) {
      Bytes encoded(stream.begin(), end);
      stream.erase(stream.begin(), end + 1);
      Bytes out(protocol::kMaxFrameDataSize);
      const auto size = protocol::cobs_decode(protocol::ByteView(encoded.data(), encoded.size()),
                                              protocol::MutableByteView(out.data(), out.size()));
      REQUIRE(size.ok());
      out.resize(size.value());
      decoded.push_back(out);
    }
    return decoded;
  }
  int fd = -1;
  Bytes stream;
};

/** A frame as the USB link sends it: COBS, then a zero byte. */
Bytes framed(const Bytes& data) {
  Bytes out(protocol::kMaxEncodedFrameSize + 1);
  const auto size = protocol::encode_frame(protocol::ByteView(data.data(), data.size()),
                                           protocol::MutableByteView(out.data(), out.size()));
  REQUIRE(size.ok());
  out.resize(size.value());
  return out;
}

/** An unpaired board made as a sensor, on USB power, booted: it answers setup messages. */
struct Bench {
  Bench() {
    host::DeviceSpec spec;
    spec.name = "board";
    device = &sim.add_device(spec);
    host::make_board(device->board(), protocol::Role::sensor);
    device->board().power.external = true;
    sim.run_until(at(milliseconds(100)));
  }

  /** Services the link, then lets the simulation run for `span`. */
  void step(host::PtyLink& link, device::Duration span = milliseconds(10)) {
    link.service(sim.now());
    sim.run_for(span);
    link.service(sim.now());
  }

  host::Simulation sim;
  host::SimDevice* device = nullptr;
  std::vector<std::string> notes;
};

std::size_t received(Bench& bench, std::uint16_t length) {
  return bench.device->records()
      .kind(host::RecordKind::link_received)
      .where([length](const host::Record& record) { return record.length == length; })
      .count();
}

TEST_CASE("a USB link carries frames only while the far end holds the terminal open") {
  Bench bench;
  host::PtyLink link(*bench.device, LinkKind::usb,
                     [&](const std::string& text) { bench.notes.push_back(text); });
  bench.step(link);
  CHECK_FALSE(link.far_open());
  CHECK_FALSE(link.attached());
  CHECK_FALSE(bench.device->board().gateway_io.host);

  FarEnd hub(link.path());
  // The hub sends Identify at once; the link holds it while the far end settles.
  hub.write_bytes(framed({protocol::kSetupMarker, protocol::setup_type::identify}));
  bench.step(link);
  CHECK(link.far_open());
  CHECK_FALSE(link.attached());
  bench.step(link, host::PtyLink::kSettle);
  CHECK(link.attached());
  CHECK(bench.device->board().gateway_io.host);
  bench.step(link);
  const auto answers = hub.frames();
  REQUIRE(answers.size() == 1);
  protocol::Identity identity;
  REQUIRE(answers[0].size() > 2);
  REQUIRE(protocol::decode_setup_body(
              protocol::ByteView(answers[0].data(), answers[0].size()).subspan(2), identity) ==
          protocol::Error::none);
  CHECK(answers[0][1] == protocol::setup_type::identity);
  CHECK(identity.role == protocol::Role::sensor);
  CHECK_FALSE(identity.paired);
  CHECK(identity.development_build);

  hub.close();
  bench.step(link);
  CHECK_FALSE(link.far_open());
  CHECK_FALSE(link.attached());
  CHECK_FALSE(bench.device->board().gateway_io.host);
  CHECK(bench.notes.back() == "board usb: closed");
}

TEST_CASE("a 254-byte frame arrives the same in both framings") {
  Bench bench;
  host::PtyLink link(*bench.device, LinkKind::usb);
  FarEnd hub(link.path());
  bench.step(link, host::PtyLink::kSettle);
  REQUIRE(link.attached());
  // 254 non-zero bytes: one full block. The encoder writes no empty block after it; a decoder
  // accepts the frame with one too (protocol section 10).
  Bytes data(254);
  for (std::size_t i = 0; i < data.size(); ++i) {
    data[i] = static_cast<std::uint8_t>(1 + i % 255);
  }
  Bytes without = framed(data);
  REQUIRE(without.size() == 256);
  Bytes with = without;
  with.insert(with.end() - 1, 0x01);
  hub.write_bytes(without);
  hub.write_bytes(with);
  bench.step(link);
  CHECK(received(bench, 254) == 2);
  CHECK(link.bad_frames() == 0);
  // A frame that is not COBS costs only itself.
  hub.write_bytes({0x05, 0x01, 0x00});
  hub.write_bytes(framed({protocol::kSetupMarker, protocol::setup_type::identify}));
  bench.step(link);
  CHECK(link.bad_frames() == 1);
  CHECK(hub.frames().size() == 1);
}

TEST_CASE("a network link is up only while the far end holds the terminal open") {
  Bench bench;
  host::PtyLink link(*bench.device, LinkKind::network);
  host::LinkWire& wire = bench.device->wire(LinkKind::network);
  const device::LinkTarget target;
  // Nobody at the far end: the device's connect fails.
  static_cast<void>(bench.device->board().network.connect(target));
  bench.step(link, seconds(20));
  CHECK_FALSE(wire.connected());

  FarEnd bridge(link.path());
  bench.step(link, host::PtyLink::kSettle);
  REQUIRE(link.attached());
  static_cast<void>(bench.device->board().network.connect(target));
  bench.step(link);
  CHECK(wire.connected());
  CHECK(bench.device->board().network.up());

  bridge.close();
  bench.step(link);
  CHECK_FALSE(wire.connected());
  CHECK_FALSE(bench.device->board().network.up());
}

TEST_CASE("a cut link carries nothing either way until it is restored") {
  Bench bench;
  host::PtyLink link(*bench.device, LinkKind::usb);
  FarEnd hub(link.path());
  bench.step(link, host::PtyLink::kSettle);
  REQUIRE(link.attached());
  link.cut();
  CHECK(link.is_cut());
  CHECK_FALSE(link.attached());
  hub.write_bytes(framed({protocol::kSetupMarker, protocol::setup_type::identify}));
  bench.step(link);
  CHECK(hub.frames().empty());
  link.restore();
  CHECK(link.attached());
  hub.write_bytes(framed({protocol::kSetupMarker, protocol::setup_type::identify}));
  bench.step(link);
  CHECK(hub.frames().size() == 1);
}

/** Reads from `fd` until `expected` bytes came, or about a second passed. */
Bytes read_all(int fd, std::size_t expected) {
  Bytes got;
  for (int tries = 0; tries < 100 && got.size() < expected; ++tries) {
    std::uint8_t chunk[512];
    const ssize_t count = ::read(fd, chunk, sizeof chunk);
    if (count > 0) {
      got.insert(got.end(), chunk, chunk + count);
    } else {
      pollfd waiting{fd, POLLIN, 0};
      poll(&waiting, 1, 10);
    }
  }
  return got;
}

TEST_CASE("a far end that leaves output processing on is named once and left as it is") {
  Bench bench;
  std::vector<std::string> errors;
  host::PtyLink link(
      *bench.device, LinkKind::usb, [&](const std::string& text) { bench.notes.push_back(text); },
      [&](const std::string& text) { errors.push_back(text); });
  // The terminal's default state, as an opener that does not clear OPOST leaves it.
  FarEnd hub(link.path(), false);
  termios before{};
  REQUIRE(tcgetattr(hub.fd, &before) == 0);
  REQUIRE((before.c_oflag & OPOST) != 0);
  REQUIRE((before.c_oflag & ONLCR) != 0);
  bench.step(link, host::PtyLink::kSettle);
  REQUIRE(link.attached());
  REQUIRE(errors.size() == 1);
  CHECK(errors[0].find("board usb: the far end has output processing on") == 0);
  CHECK(std::none_of(bench.notes.begin(), bench.notes.end(), [](const std::string& note) {
    return note.find("output processing") != std::string::npos;
  }));
  termios after{};
  REQUIRE(tcgetattr(hub.fd, &after) == 0);
  CHECK((after.c_oflag & OPOST) != 0);
  // Unrepaired: the far end's 0x0A reaches the bench as 0x0D 0x0A.
  hub.write_bytes({0x41, 0x0A});
  CHECK(read_all(link.fd(), 3) == Bytes{0x41, 0x0D, 0x0A});
  bench.step(link);
  CHECK(errors.size() == 1);
}

TEST_CASE("a raw far end passes every byte value both ways, with no error") {
  Bench bench;
  std::vector<std::string> errors;
  host::PtyLink link(*bench.device, LinkKind::usb, {},
                     [&](const std::string& text) { errors.push_back(text); });
  FarEnd hub(link.path());
  bench.step(link, host::PtyLink::kSettle);
  REQUIRE(link.attached());
  CHECK(errors.empty());
  Bytes every(256);
  for (std::size_t i = 0; i < every.size(); ++i) {
    every[i] = static_cast<std::uint8_t>(i);
  }
  hub.write_bytes(every);
  CHECK(read_all(link.fd(), every.size()) == every);
  REQUIRE(::write(link.fd(), every.data(), every.size()) == static_cast<ssize_t>(every.size()));
  CHECK(read_all(hub.fd, every.size()) == every);
}

}  // namespace
}  // namespace hsn::test
