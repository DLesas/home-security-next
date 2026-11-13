// hsn_bench: runs a site of simulated boards in real time, with the real roles, joined to the real
// hub through pseudo-terminals (hub-design.md section 11). Every board starts unpaired, as a
// development build, with its role stored as when it was made; sensors are on USB power. The run
// writes a manifest naming each board's terminals, streams its timeline as JSON lines, and reads
// a script on standard input until `quit`. See README.md beside this file.

#include <poll.h>
#include <unistd.h>

#include <fcntl.h>
#include <algorithm>
#include <cerrno>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <memory>
#include <set>
#include <string>
#include <vector>

#include "hsn/host/bench_json.hpp"
#include "hsn/host/bench_script.hpp"
#include "hsn/host/provisioning.hpp"
#include "hsn/host/pty_link.hpp"
#include "hsn/host/real_time.hpp"
#include "hsn/host/role_box.hpp"
#include "hsn/host/simulation.hpp"
#include "hsn/host/simulation_error.hpp"
#include "hsn/roles/gateway/gateway_role.hpp"
#include "hsn/roles/sensor/sensor_role.hpp"
#include "hsn/roles/siren/siren_role.hpp"

namespace {

using hsn::device::LinkKind;
using hsn::host::PtyLink;

/** The longest the loop sleeps without looking at anything. */
constexpr hsn::device::Duration kLongestWait = hsn::device::milliseconds(50);

/** The site, from the command line. */
struct Options {
  int sensors = 1;
  int sirens = 1;
  int gateways = 1;
  bool gateway_wifi = false;
  double path_loss_db = 100;
  std::uint64_t seed = 1;
  std::string manifest = "bench-manifest.json";
  std::string timeline = "-";
  std::set<std::string> skip{"retained_write"};
};

const char* kUsage =
    "usage: hsn_bench [--sensors N] [--sirens N] [--gateways N] [--gateway-wifi]\n"
    "                 [--path-loss DB] [--seed N] [--manifest PATH] [--timeline PATH|-]\n"
    "                 [--skip KIND,KIND,...|none]\n"
    "Runs N sensors, sirens and gateways (default 1 each) in real time until `quit` on standard\n"
    "input. See firmware/tools/bench/README.md.\n";

bool parse(int argc, char** argv, Options& options) {
  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    const auto value = [&]() -> std::string {
      if (i + 1 >= argc) {
        throw std::runtime_error(arg + " needs a value");
      }
      return argv[++i];
    };
    if (arg == "--sensors") {
      options.sensors = std::stoi(value());
    } else if (arg == "--sirens") {
      options.sirens = std::stoi(value());
    } else if (arg == "--gateways") {
      options.gateways = std::stoi(value());
    } else if (arg == "--gateway-wifi") {
      options.gateway_wifi = true;
    } else if (arg == "--path-loss") {
      options.path_loss_db = std::stod(value());
    } else if (arg == "--seed") {
      options.seed = std::stoull(value());
    } else if (arg == "--manifest") {
      options.manifest = value();
    } else if (arg == "--timeline") {
      options.timeline = value();
    } else if (arg == "--skip") {
      options.skip.clear();
      const std::string kinds = value();
      std::size_t from = 0;
      while (kinds != "none" && from <= kinds.size()) {
        const std::size_t comma = std::min(kinds.find(',', from), kinds.size());
        options.skip.insert(kinds.substr(from, comma - from));
        from = comma + 1;
      }
    } else if (arg == "--help" || arg == "-h") {
      std::cout << kUsage;
      return false;
    } else {
      throw std::runtime_error("unknown option " + arg);
    }
  }
  if (options.sensors < 0 || options.sirens < 0 || options.gateways < 0) {
    throw std::runtime_error("device counts cannot be negative");
  }
  return true;
}

volatile std::sig_atomic_t g_stop = 0;

void on_signal(int) {
  g_stop = 1;
}

/** One board of the site and its terminals. */
struct Board {
  std::string role;
  hsn::host::SimDevice* device = nullptr;
  std::vector<std::unique_ptr<PtyLink>> links;
};

/** Writes the timeline and the bench's own lines, one JSON object per line, flushed each. */
class Output {
public:
  explicit Output(const std::string& path) {
    if (path != "-") {
      file_.open(path, std::ios::out | std::ios::trunc);
      if (!file_) {
        throw std::runtime_error("cannot write " + path);
      }
    }
  }

  void line(const std::string& json) {
    std::ostream& out = file_.is_open() ? static_cast<std::ostream&>(file_) : std::cout;
    out << json << '\n';
    out.flush();
  }

  /** A line of the bench's own: {"t", "<key>": "<text>"}. */
  void event(hsn::device::Instant at, const char* key, const std::string& text) {
    line("{\"t\":" + hsn::host::json_seconds(at) + ",\"" + key +
         "\":" + hsn::host::json_string(text) + "}");
  }

private:
  std::ofstream file_;
};

int run(const Options& options) {
  hsn::host::SimulationOptions simulation;
  simulation.seed = options.seed;
  // A run of hours: the timeline goes out as it happens, the fakes need not keep their records.
  simulation.keep_fake_records = false;
  hsn::host::Simulation sim(simulation);
  Output output(options.timeline);
  sim.timeline().set_listener([&](const hsn::host::Record& record) {
    if (options.skip.count(hsn::host::record_kind_name(record.kind)) == 0) {
      output.line(hsn::host::record_json(sim.timeline(), record));
    }
  });

  std::vector<Board> boards;
  const auto add = [&](const std::string& role, int count) {
    for (int i = 1; i <= count; ++i) {
      hsn::host::DeviceSpec spec;
      spec.name = role + std::to_string(i);
      std::uint8_t role_id = 0;
      if (role == "sensor") {
        spec.role =
            hsn::host::make_role<hsn::roles::sensor::SensorRole>(&hsn::host::HostBoard::sensor_io);
        role_id = hsn::protocol::Role::sensor;
      } else if (role == "siren") {
        spec.role =
            hsn::host::make_role<hsn::roles::siren::SirenRole>(&hsn::host::HostBoard::siren_io);
        role_id = hsn::protocol::Role::siren;
      } else {
        spec.role = hsn::host::make_role<hsn::roles::gateway::GatewayRole>(
            &hsn::host::HostBoard::gateway_io);
        role_id = hsn::protocol::Role::gateway;
      }
      Board board;
      board.role = role;
      board.device = &sim.add_device(spec);
      // Made, not paired: the hub provisions it over USB (section 10). Every board starts on
      // external power (a sensor on USB until the script says otherwise, a siren on its supply, a
      // gateway on USB), so it sleeps no deeper than light and its port stays up.
      hsn::host::make_board(board.device->board(), role_id);
      board.device->board().power.external = true;
      boards.push_back(std::move(board));
    }
  };
  add("sensor", options.sensors);
  add("siren", options.sirens);
  add("gateway", options.gateways);
  for (std::size_t a = 0; a < boards.size(); ++a) {
    for (std::size_t b = a + 1; b < boards.size(); ++b) {
      sim.medium().set_path_loss(boards[a].device->station(), boards[b].device->station(),
                                 options.path_loss_db);
    }
  }

  hsn::host::SteadyHostClock clock;
  hsn::host::RealTimeDriver driver(sim, clock);
  const auto note = [&](const std::string& text) { output.event(sim.now(), "note", text); };
  const auto fault = [&](const std::string& text) { output.event(sim.now(), "error", text); };
  std::vector<hsn::host::ManifestDevice> manifest;
  for (Board& board : boards) {
    hsn::host::ManifestDevice entry;
    entry.name = board.device->name();
    entry.role = board.role;
    std::vector<LinkKind> kinds{LinkKind::usb};
    if (board.role == "siren" || (board.role == "gateway" && options.gateway_wifi)) {
      kinds.push_back(LinkKind::network);
    }
    for (const LinkKind kind : kinds) {
      board.links.push_back(std::make_unique<PtyLink>(*board.device, kind, note, fault));
      entry.links.push_back(
          {kind == LinkKind::usb ? "usb" : "network", board.links.back()->path()});
    }
    manifest.push_back(entry);
  }
  {
    std::ofstream file(options.manifest, std::ios::out | std::ios::trunc);
    file << hsn::host::manifest_json(manifest) << '\n';
    if (!file) {
      throw std::runtime_error("cannot write the manifest " + options.manifest);
    }
  }
  const auto find_link = [&](const std::string& name, LinkKind kind) -> PtyLink* {
    for (Board& board : boards) {
      for (auto& link : board.links) {
        if (board.device->name() == name && link->kind() == kind) {
          return link.get();
        }
      }
    }
    return nullptr;
  };
  hsn::host::BenchScript script(sim, find_link);
  driver.set_lag_listener([&](const hsn::host::Lag& lag) {
    output.line("{\"t\":" + hsn::host::json_seconds(sim.now()) +
                ",\"lag_ms\":" + std::to_string(static_cast<double>(lag.by.us) / 1000.0) +
                ",\"due\":" + hsn::host::json_seconds(lag.due) + "}");
  });
  output.event(sim.now(), "started", options.manifest);

  fcntl(STDIN_FILENO, F_SETFL, fcntl(STDIN_FILENO, F_GETFL) | O_NONBLOCK);
  bool stdin_open = true;
  std::string pending;
  bool quit = false;
  while (!quit && g_stop == 0) {
    driver.deliver([&]() {
      for (Board& board : boards) {
        for (auto& link : board.links) {
          link->service(sim.now());
        }
      }
    });
    // Script lines, each at the instant it is read.
    if (stdin_open) {
      char chunk[512];
      for (;;) {
        const ssize_t got = read(STDIN_FILENO, chunk, sizeof(chunk));
        if (got > 0) {
          pending.append(chunk, static_cast<std::size_t>(got));
          continue;
        }
        if (got == 0) {
          // No more script: the run goes on until a signal stops it.
          stdin_open = false;
        }
        break;
      }
      for (std::size_t end = pending.find('\n'); end != std::string::npos && !quit;
           end = pending.find('\n')) {
        const std::string text = pending.substr(0, end);
        pending.erase(0, end + 1);
        hsn::host::ScriptResult result;
        driver.deliver([&]() { result = script.run(text); });
        if (!result.ok) {
          output.event(sim.now(), "error", result.error);
        } else if (!text.empty() && text[0] != '#') {
          output.event(sim.now(), "command", text);
        }
        quit = result.quit;
      }
    }
    if (quit) {
      break;
    }
    // Wait for the next action, a terminal or the script, never longer than kLongestWait.
    hsn::device::Duration wait = driver.time_to_next(kLongestWait);
    std::vector<pollfd> fds;
    if (stdin_open) {
      fds.push_back({STDIN_FILENO, POLLIN, 0});
    }
    for (Board& board : boards) {
      for (auto& link : board.links) {
        const hsn::device::Duration until = link->next_service(sim.now()) - sim.now();
        wait = until < wait ? until : wait;
        // A terminal whose far end is closed reports a hang-up at once: it is checked, not polled.
        if (link->far_open()) {
          fds.push_back(
              {link->fd(), static_cast<short>(POLLIN | (link->has_output() ? POLLOUT : 0)), 0});
        }
      }
    }
    const int wait_ms = static_cast<int>(std::max<std::int64_t>(0, (wait.us + 999) / 1000));
    if (poll(fds.data(), static_cast<nfds_t>(fds.size()), wait_ms) < 0 && errno != EINTR) {
      throw std::runtime_error(std::string("poll: ") + std::strerror(errno));
    }
  }
  driver.catch_up();
  output.event(sim.now(), "quit", quit ? "quit" : "signal");
  return 0;
}

}  // namespace

int main(int argc, char** argv) {
  std::signal(SIGINT, on_signal);
  std::signal(SIGTERM, on_signal);
  std::signal(SIGPIPE, SIG_IGN);
  try {
    Options options;
    if (!parse(argc, argv, options)) {
      return 0;
    }
    return run(options);
  } catch (const std::exception& error) {
    std::cerr << "hsn_bench: " << error.what() << '\n' << kUsage;
    return 2;
  }
}
