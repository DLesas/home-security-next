// A short real-time run of hsn_bench with no hub attached (hub-design.md section 11): the boards
// start unpaired, as development builds in setup-only mode, and answer Identify on their USB
// terminals; the manifest names every terminal; quit ends the run cleanly.

#include <fcntl.h>
#include <poll.h>
#include <spawn.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>

#include <doctest/doctest.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <array>
#include <chrono>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <functional>
#include <string>
#include <vector>

#include "hsn/protocol/framing.hpp"
#include "hsn/protocol/setup.hpp"

extern char** environ;

namespace hsn::test {
namespace {

using json = nlohmann::json;
using Bytes = std::vector<std::uint8_t>;
using Clock = std::chrono::steady_clock;

constexpr auto kPatience = std::chrono::seconds(10);

/** hsn_bench running as a child, its stdin and stdout on pipes. */
class BenchProcess {
public:
  explicit BenchProcess(const std::vector<std::string>& args) {
    int in[2];
    int out[2];
    REQUIRE(pipe(in) == 0);
    REQUIRE(pipe(out) == 0);
    posix_spawn_file_actions_t actions;
    posix_spawn_file_actions_init(&actions);
    posix_spawn_file_actions_adddup2(&actions, in[0], STDIN_FILENO);
    posix_spawn_file_actions_adddup2(&actions, out[1], STDOUT_FILENO);
    for (const int fd : {in[0], in[1], out[0], out[1]}) {
      posix_spawn_file_actions_addclose(&actions, fd);
    }
    std::vector<std::string> all = {HSN_BENCH_PATH};
    all.insert(all.end(), args.begin(), args.end());
    std::vector<char*> argv;
    for (std::string& arg : all) {
      argv.push_back(arg.data());
    }
    argv.push_back(nullptr);
    const int spawned = posix_spawn(&pid_, HSN_BENCH_PATH, &actions, nullptr, argv.data(), environ);
    posix_spawn_file_actions_destroy(&actions);
    ::close(in[0]);
    ::close(out[1]);
    stdin_ = in[1];
    stdout_ = out[0];
    REQUIRE(spawned == 0);
    fcntl(stdout_, F_SETFL, fcntl(stdout_, F_GETFL) | O_NONBLOCK);
  }

  ~BenchProcess() {
    if (pid_ > 0) {
      kill(pid_, SIGKILL);
      waitpid(pid_, nullptr, 0);
    }
    ::close(stdin_);
    ::close(stdout_);
  }

  BenchProcess(const BenchProcess&) = delete;
  BenchProcess& operator=(const BenchProcess&) = delete;

  void send(const std::string& line) const {
    const std::string text = line + "\n";
    REQUIRE(::write(stdin_, text.data(), text.size()) == static_cast<ssize_t>(text.size()));
  }

  /** Reads whatever the timeline has written; false at end of file. */
  bool drain() {
    char chunk[4096];
    for (;;) {
      const ssize_t got = ::read(stdout_, chunk, sizeof chunk);
      if (got > 0) {
        pending_.append(chunk, static_cast<std::size_t>(got));
        continue;
      }
      if (got == 0) {
        return false;
      }
      break;
    }
    for (auto end = pending_.find('\n'); end != std::string::npos; end = pending_.find('\n')) {
      lines.push_back(json::parse(pending_.substr(0, end)));
      pending_.erase(0, end + 1);
    }
    return true;
  }

  /** Waits until a timeline line has `key`, or the patience runs out. */
  bool wait_for(const char* key) {
    return wait_until([key](const json& line) { return line.contains(key); });
  }

  /** Waits until a timeline line satisfies `wanted`, or the patience runs out. */
  bool wait_until(const std::function<bool(const json&)>& wanted) {
    const auto deadline = Clock::now() + kPatience;
    while (Clock::now() < deadline) {
      const bool open = drain();
      if (std::any_of(lines.begin(), lines.end(), wanted)) {
        return true;
      }
      if (!open) {
        return false;
      }
      pollfd waiting{stdout_, POLLIN, 0};
      poll(&waiting, 1, 50);
    }
    return false;
  }

  /** Reads to the end of the timeline and returns the exit status, or -1. */
  int wait_exit() {
    const auto deadline = Clock::now() + kPatience;
    while (Clock::now() < deadline && drain()) {
      pollfd waiting{stdout_, POLLIN, 0};
      poll(&waiting, 1, 50);
    }
    int status = 0;
    const pid_t done = waitpid(pid_, &status, 0);
    pid_ = 0;
    return done > 0 && WIFEXITED(status) ? WEXITSTATUS(status) : -1;
  }

  std::vector<json> lines;

private:
  pid_t pid_ = 0;
  int stdin_ = -1;
  int stdout_ = -1;
  std::string pending_;
};

/** A USB terminal opened as the hub opens it, in raw mode. */
class Terminal {
public:
  explicit Terminal(const std::string& path)
      : fd_(open(path.c_str(), O_RDWR | O_NOCTTY | O_NONBLOCK)) {
    REQUIRE(fd_ >= 0);
    termios settings{};
    REQUIRE(tcgetattr(fd_, &settings) == 0);
    cfmakeraw(&settings);
    REQUIRE(tcsetattr(fd_, TCSANOW, &settings) == 0);
  }
  ~Terminal() {
    ::close(fd_);
  }
  Terminal(const Terminal&) = delete;
  Terminal& operator=(const Terminal&) = delete;

  void send(const Bytes& data) const {
    Bytes out(protocol::kMaxEncodedFrameSize + 1);
    const auto size = protocol::encode_frame(protocol::ByteView(data.data(), data.size()),
                                             protocol::MutableByteView(out.data(), out.size()));
    REQUIRE(size.ok());
    REQUIRE(::write(fd_, out.data(), size.value()) == static_cast<ssize_t>(size.value()));
  }

  /** The next frame of setup type `type` to arrive, decoded; empty if none came in time. */
  Bytes receive_setup(BenchProcess& bench, std::uint8_t type) {
    const auto deadline = Clock::now() + kPatience;
    while (Clock::now() < deadline) {
      const Bytes frame = receive(bench);
      if (frame.size() >= 2 && frame[0] == protocol::kSetupMarker && frame[1] == type) {
        return frame;
      }
    }
    return {};
  }

  /** The next whole frame to arrive, decoded; empty if none came in time. */
  Bytes receive(BenchProcess& bench) {
    const auto deadline = Clock::now() + kPatience;
    while (Clock::now() < deadline) {
      bench.drain();
      std::uint8_t chunk[1024];
      const ssize_t got = ::read(fd_, chunk, sizeof chunk);
      if (got > 0) {
        stream_.insert(stream_.end(), chunk, chunk + got);
      }
      const auto end = std::find(stream_.begin(), stream_.end(), 0);
      if (end != stream_.end()) {
        Bytes out(protocol::kMaxFrameDataSize);
        const auto size = protocol::cobs_decode(
            protocol::ByteView(&*stream_.begin(), static_cast<std::size_t>(end - stream_.begin())),
            protocol::MutableByteView(out.data(), out.size()));
        REQUIRE(size.ok());
        out.resize(size.value());
        stream_.erase(stream_.begin(), end + 1);
        return out;
      }
      pollfd waiting{fd_, POLLIN, 0};
      poll(&waiting, 1, 20);
    }
    return {};
  }

private:
  int fd_;
  Bytes stream_;
};

/** A Provision message for a board at `address`. */
Bytes provision_message(std::uint32_t address) {
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

std::uint8_t role_named(const std::string& name) {
  if (name == "siren") {
    return protocol::Role::siren;
  }
  if (name == "gateway") {
    return protocol::Role::gateway;
  }
  return protocol::Role::sensor;
}

TEST_CASE("hsn_bench runs a site whose unpaired boards answer Identify on their terminals") {
  const char* temporary = std::getenv("TMPDIR");
  std::string folder = std::string(temporary != nullptr ? temporary : "/tmp") + "/hsn-bench-XXXXXX";
  REQUIRE(mkdtemp(folder.data()) != nullptr);
  const std::string manifest_path = folder + "/manifest.json";
  {
    BenchProcess bench({"--sensors", "2", "--sirens", "1", "--gateways", "1", "--manifest",
                        manifest_path, "--timeline", "-"});
    REQUIRE(bench.wait_for("started"));

    std::ifstream file(manifest_path);
    REQUIRE(file.good());
    const json manifest = json::parse(file);
    CHECK(manifest.at("version") == 1);
    const json& devices = manifest.at("devices");
    REQUIRE(devices.size() == 4);
    CHECK(devices[0].at("name") == "sensor1");
    CHECK(devices[1].at("name") == "sensor2");
    CHECK(devices[2].at("name") == "siren1");
    CHECK(devices[3].at("name") == "gateway1");

    std::vector<std::array<std::uint8_t, 6>> chip_ids;
    for (const json& device : devices) {
      const std::string name = device.at("name");
      INFO(name);
      const json& links = device.at("links");
      REQUIRE(!links.empty());
      CHECK(links[0].at("kind") == "usb");
      CHECK(links.size() == (device.at("role") == "siren" ? 2U : 1U));
      if (links.size() == 2) {
        CHECK(links[1].at("kind") == "network");
      }

      Terminal usb(links[0].at("path").get<std::string>());
      usb.send({protocol::kSetupMarker, protocol::setup_type::identify});
      const Bytes answer = usb.receive(bench);
      REQUIRE(answer.size() > 2);
      CHECK(answer[0] == protocol::kSetupMarker);
      CHECK(answer[1] == protocol::setup_type::identity);
      protocol::Identity identity;
      REQUIRE(protocol::decode_setup_body(protocol::ByteView(answer.data() + 2, answer.size() - 2),
                                          identity) == protocol::Error::none);
      CHECK(identity.role == role_named(device.at("role")));
      CHECK_FALSE(identity.paired);
      CHECK(identity.development_build);
      chip_ids.push_back(identity.chip_id);
    }
    // Every board has its own chip identifier.
    std::sort(chip_ids.begin(), chip_ids.end());
    CHECK(std::adjacent_find(chip_ids.begin(), chip_ids.end()) == chip_ids.end());

    // The gateway's add: its Provision result arrives the first time, although the board restarts
    // right after sending it, and the board then says it is paired.
    {
      Terminal usb(devices[3].at("links")[0].at("path").get<std::string>());
      usb.send(provision_message(0x6A7E0042));
      const Bytes result = usb.receive_setup(bench, protocol::setup_type::provision_result);
      CHECK(result == Bytes{protocol::kSetupMarker, protocol::setup_type::provision_result,
                            protocol::ProvisionOutcome::accepted});
      // Asked again once it has booted a second time (a frame sent while it boots is lost).
      REQUIRE(bench.wait_until([](const json& line) {
        return line.value("actor", "") == "gateway1" && line.value("kind", "") == "boot" &&
               line.at("t").get<double>() > 0.1;
      }));
      usb.send({protocol::kSetupMarker, protocol::setup_type::identify});
      const Bytes answer = usb.receive_setup(bench, protocol::setup_type::identity);
      REQUIRE(answer.size() > 2);
      protocol::Identity identity;
      REQUIRE(protocol::decode_setup_body(protocol::ByteView(answer.data() + 2, answer.size() - 2),
                                          identity) == protocol::Error::none);
      CHECK(identity.paired);
    }

    bench.send("door sensor1 open");
    bench.send("quit");
    CHECK(bench.wait_exit() == 0);
    const auto has = [&bench](const char* key, const char* value) {
      return std::any_of(bench.lines.begin(), bench.lines.end(), [&](const json& line) {
        return line.contains(key) && line.at(key) == value;
      });
    };
    CHECK(has("command", "door sensor1 open"));
    CHECK(has("note", "sensor1 usb: open"));
    REQUIRE(!bench.lines.empty());
    CHECK(bench.lines.back().at("quit") == "quit");
    CHECK_FALSE(has("kind", "deep_sleep"));
    // No check that nothing lagged: a loaded host (a parallel build) may delay the bench.
  }
  std::remove(manifest_path.c_str());
  rmdir(folder.c_str());
}

}  // namespace
}  // namespace hsn::test
