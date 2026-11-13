// A restart the device asks for lets its links finish sending (firmware-design.md section 4, the
// Waiter row): the Provision result that announces the restart reaches the far end, over a wire
// and over a pseudo-terminal, and the board then boots paired. A power loss or a scripted restart
// gives no such grace. And each board answers with its own chip identifier.

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
using host::RecordKind;
using Bytes = std::vector<std::uint8_t>;

constexpr device::Duration kLatency = milliseconds(25);

/** A Provision message for a sensor at `address`. */
Bytes provision_message(std::uint32_t address = 0x1A2B3C4D) {
  protocol::Provision message;
  message.pairing.address = address;
  message.pairing.key = {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15};
  message.pairing.hub_identity = {1, 1, 2, 2, 3, 3, 4, 4};
  message.pairing.site_channel = 1;
  message.pairing.allowed_data_rate_mask = 0x3F;
  Bytes out(256);
  const auto size =
      protocol::encode_setup(message, protocol::MutableByteView(out.data(), out.size()));
  REQUIRE(size.ok());
  out.resize(size.value());
  return out;
}

const Bytes kIdentify = {protocol::kSetupMarker, protocol::setup_type::identify};

protocol::Identity identity_of(const Bytes& frame) {
  protocol::Identity identity;
  REQUIRE(frame.size() > 2);
  REQUIRE(frame[1] == protocol::setup_type::identity);
  REQUIRE(protocol::decode_setup_body(protocol::ByteView(frame.data() + 2, frame.size() - 2),
                                      identity) == protocol::Error::none);
  return identity;
}

/** The far end of a USB wire: keeps every frame that reaches it, with its arrival time. */
class Peer final : public host::LinkPeer {
public:
  void link_up(host::LinkWire&) override {}
  void link_down(host::LinkWire&) override {}
  void link_packet(host::LinkWire&, const Bytes& packet) override {
    frames.push_back(packet);
    arrivals.push_back(arrival());
  }

  /** The provision results that arrived, in order. */
  std::vector<std::uint8_t> results() const {
    std::vector<std::uint8_t> out;
    for (const Bytes& frame : frames) {
      if (frame.size() == 3 && frame[1] == protocol::setup_type::provision_result) {
        out.push_back(frame[2]);
      }
    }
    return out;
  }

  std::function<device::Instant()> arrival;
  std::vector<Bytes> frames;
  std::vector<device::Instant> arrivals;
};

/** One unpaired board, made as a sensor, on USB power, with a peer on its USB wire. */
struct Bench {
  explicit Bench(host::SimulationOptions options = {}) : sim(options) {
    board = &add("board");
    peer.arrival = [this]() { return sim.now(); };
    board->wire(LinkKind::usb).attach(peer, kLatency);
    sim.run_until(at(seconds(1)));
  }

  host::SimDevice& add(const std::string& name) {
    host::DeviceSpec spec;
    spec.name = name;
    host::SimDevice& device = sim.add_device(spec);
    host::make_board(device.board(), protocol::Role::sensor);
    device.board().power.external = true;
    return device;
  }

  /** Sends Identify and returns the identity that comes back. */
  protocol::Identity identify(host::SimDevice& device, Peer& to) {
    const std::size_t before = to.frames.size();
    device.wire(LinkKind::usb).send_to_device(kIdentify);
    sim.run_for(milliseconds(200));
    REQUIRE(to.frames.size() == before + 1);
    return identity_of(to.frames.back());
  }

  host::Simulation sim;
  host::SimDevice* board = nullptr;
  Peer peer;
};

TEST_CASE("a Provision over a wire returns its result to the far end, then the board is paired") {
  Bench bench;
  bench.board->wire(LinkKind::usb).send_to_device(provision_message());
  bench.sim.run_until(at(seconds(2)));
  INFO(bench.sim.timeline().select().dump());
  CHECK(bench.peer.results() == std::vector<std::uint8_t>{protocol::ProvisionOutcome::accepted});
  // Sent at the restart's instant, it arrives one latency later, while the board reboots.
  const auto restarts = bench.board->records().kind(RecordKind::restart).records();
  REQUIRE(restarts.size() == 1);
  REQUIRE(bench.peer.arrivals.size() == 1);
  CHECK(bench.peer.arrivals[0] == restarts[0].at + kLatency);
  CHECK(bench.board->boots() == 2);
  const protocol::Identity identity = bench.identify(*bench.board, bench.peer);
  CHECK(identity.paired);
  CHECK(identity.hub_identity == protocol::HubIdentity{1, 1, 2, 2, 3, 3, 4, 4});
}

TEST_CASE("frames towards a restarting board are still lost") {
  Bench bench;
  bench.board->wire(LinkKind::usb).send_to_device(provision_message());
  // Identify arrives 1 ms after the Provision, while the board is restarting.
  bench.sim.schedule(at(seconds(1) + milliseconds(1)),
                     [&]() { bench.board->wire(LinkKind::usb).send_to_device(kIdentify); });
  bench.sim.run_until(at(seconds(2)));
  CHECK(bench.peer.frames.size() == 1);
  CHECK(bench.peer.results() == std::vector<std::uint8_t>{protocol::ProvisionOutcome::accepted});
}

TEST_CASE("a power loss or a scripted restart in the same instant still loses the result") {
  for (const bool power_loss : {true, false}) {
    INFO(power_loss);
    Bench bench;
    // As soon as the board has sent its answer, the power goes (or the script resets it), in
    // that same instant.
    bool struck = false;
    bench.sim.timeline().set_listener([&](const host::Record& record) {
      if (!struck && record.kind == RecordKind::link_sent && record.actor == bench.board->actor()) {
        struck = true;
        if (power_loss) {
          bench.board->power_loss(bench.sim.now(), milliseconds(100));
        } else {
          bench.board->restart(bench.sim.now());
        }
      }
    });
    bench.board->wire(LinkKind::usb).send_to_device(provision_message());
    bench.sim.run_until(at(seconds(2)));
    REQUIRE(struck);
    CHECK(bench.peer.frames.empty());
    // The flash write went before the answer: the board is paired all the same.
    bench.sim.timeline().set_listener({});
    CHECK(bench.identify(*bench.board, bench.peer).paired);
  }
}

/** The far end of a pseudo-terminal, raw, as the hub opens it. */
struct Terminal {
  explicit Terminal(const std::string& path)
      : fd(open(path.c_str(), O_RDWR | O_NOCTTY | O_NONBLOCK)) {
    REQUIRE(fd >= 0);
    termios settings{};
    REQUIRE(tcgetattr(fd, &settings) == 0);
    cfmakeraw(&settings);
    REQUIRE(tcsetattr(fd, TCSANOW, &settings) == 0);
  }
  ~Terminal() {
    close(fd);
  }
  Terminal(const Terminal&) = delete;
  Terminal& operator=(const Terminal&) = delete;

  void send(const Bytes& data) const {
    Bytes out(protocol::kMaxEncodedFrameSize + 1);
    const auto size = protocol::encode_frame(protocol::ByteView(data.data(), data.size()),
                                             protocol::MutableByteView(out.data(), out.size()));
    REQUIRE(size.ok());
    REQUIRE(::write(fd, out.data(), size.value()) == static_cast<ssize_t>(size.value()));
  }

  /** Every whole frame waiting, decoded. */
  std::vector<Bytes> frames() {
    std::uint8_t chunk[1024];
    for (ssize_t got = ::read(fd, chunk, sizeof chunk); got > 0;
         got = ::read(fd, chunk, sizeof chunk)) {
      stream.insert(stream.end(), chunk, chunk + got);
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

  int fd;
  Bytes stream;
};

TEST_CASE("a Provision over a pseudo-terminal returns its result, then the board is paired") {
  host::Simulation sim;
  host::DeviceSpec spec;
  spec.name = "board";
  host::SimDevice& board = sim.add_device(spec);
  host::make_board(board.board(), protocol::Role::sensor);
  board.board().power.external = true;
  host::PtyLink link(board, LinkKind::usb);
  Terminal hub(link.path());
  const auto step = [&](device::Duration span) {
    link.service(sim.now());
    sim.run_for(span);
    link.service(sim.now());
  };
  step(host::PtyLink::kSettle + milliseconds(10));
  REQUIRE(link.attached());

  hub.send(provision_message());
  step(milliseconds(10));
  const auto answers = hub.frames();
  REQUIRE(answers.size() == 1);
  CHECK(answers[0] == Bytes{protocol::kSetupMarker, protocol::setup_type::provision_result,
                            protocol::ProvisionOutcome::accepted});
  CHECK(board.records().kind(RecordKind::restart).count() == 1);

  step(milliseconds(100));
  CHECK(board.boots() == 2);
  hub.send(kIdentify);
  step(milliseconds(10));
  const auto identities = hub.frames();
  REQUIRE(identities.size() == 1);
  CHECK(identity_of(identities[0]).paired);
}

TEST_CASE("each board has its own chip identifier, kept across resets, from its name and seed") {
  Bench bench;
  host::SimDevice& other = bench.add("other");
  Peer other_peer;
  other_peer.arrival = [&]() { return bench.sim.now(); };
  other.wire(LinkKind::usb).attach(other_peer, kLatency);
  bench.sim.run_until(at(seconds(2)));

  const auto board_id = bench.identify(*bench.board, bench.peer).chip_id;
  const auto other_id = bench.identify(other, other_peer).chip_id;
  CHECK(board_id != other_id);
  CHECK(board_id != std::array<std::uint8_t, 6>{0x10, 0x20, 0x30, 0x40, 0x50, 0x60});
  CHECK(board_id == host::chip_id_for(1, "board"));
  // A locally administered unicast address.
  CHECK((board_id[0] & 0x03u) == 0x02u);

  bench.board->restart(bench.sim.now());
  bench.board->power_loss(bench.sim.now() + seconds(1), seconds(1));
  bench.sim.run_for(seconds(3));
  CHECK(bench.board->boots() == 3);
  CHECK(bench.identify(*bench.board, bench.peer).chip_id == board_id);

  // The same name and seed give the same identifier in another run; another seed does not.
  CHECK(host::chip_id_for(1, "board") == board_id);
  CHECK(host::chip_id_for(2, "board") != board_id);
  host::SimulationOptions seeded;
  seeded.seed = 2;
  Bench again(seeded);
  CHECK(again.identify(*again.board, again.peer).chip_id == host::chip_id_for(2, "board"));
}

}  // namespace
}  // namespace hsn::test
