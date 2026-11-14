#pragma once

#include <sys/types.h>

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "hsn/host/wire_json.hpp"

namespace hsn::host::lockstep {

using Bytes = std::vector<std::uint8_t>;

/**
 * The wire's version (hub-design.md section 11, "Lockstep: the wire"): 2 added `idle.closed`, and
 * the hub refuses any other.
 */
constexpr std::int64_t kVersion = 2;

/** The longest line either side may send: 1 MiB. */
constexpr std::size_t kMaxLine = 1024 * 1024;

/**
 * One message from the controller to the hub. `type` says which fields mean something; times
 * are whole microseconds on the controller's true clock, walls milliseconds since 1970.
 */
struct ToHub {
  enum class Type : std::uint8_t {
    start,
    advance,
    frame,
    link_up,
    link_down,
    control,
    clock,
    stop
  };
  Type type = Type::advance;
  /** start, frame, linkUp, linkDown, control, clock, stop. */
  std::int64_t at = 0;
  /** advance. */
  std::int64_t to = 0;
  /** start, clock. */
  std::int64_t wall = 0;
  bool trusted = true;
  /** start: the hub's own monotonic clock at `at`, left out when empty. */
  std::optional<std::int64_t> mono;
  /** start: 32 bytes. */
  Bytes seed;
  /** frame, linkUp, linkDown: the link's name. */
  std::string link;
  /** linkUp: "usb" or "network". */
  std::string kind;
  /** frame: one packet or setup message, without COBS. */
  Bytes bytes;
  /** control: the request line, {id, actor, command}. */
  json::Value request;

  static ToHub start(std::int64_t at, std::int64_t wall, bool trusted, Bytes seed);
  static ToHub advance(std::int64_t to);
  static ToHub frame(std::string link, std::int64_t at, Bytes bytes);
  static ToHub link_up(std::string link, std::string kind, std::int64_t at);
  static ToHub link_down(std::string link, std::int64_t at);
  static ToHub control(std::int64_t at, std::int64_t id, std::string actor, json::Value command);
  static ToHub clock(std::int64_t at, std::int64_t wall, bool trusted);
  static ToHub stop(std::int64_t at);

  /** How many lines the hub answers this with: start and advance 1, stop 2, the rest none. */
  int answers() const;
};

/** One frame the hub sent, with when it left. */
struct FrameOut {
  std::string link;
  std::int64_t at = 0;
  Bytes bytes;
};

/** A link the hub closed itself (a gateway session replaced or never proven…), and why. */
struct ClosedLink {
  std::string link;
  std::int64_t at = 0;
  std::string reason;
};

/** An answer to a command, as the control socket's reply line has it. */
struct Reply {
  std::int64_t id = 0;
  /** {"ok":true,"result":…} or {"ok":false,…}. */
  json::Value reply;
};

/** One message from the hub to the controller. */
struct FromHub {
  enum class Type : std::uint8_t { idle, stopped, error };
  Type type = Type::idle;
  /** idle: the time reached. */
  std::int64_t to = 0;
  /** idle: this run's boot. */
  std::int64_t boot = 0;
  std::vector<FrameOut> frames;
  /** idle: the links the hub closed itself, in order. */
  std::vector<ClosedLink> closed;
  /** idle: every record made, each {"kind":…,"row":{…}} (section 6's rows as `hsn log --json`). */
  std::vector<json::Value> records;
  std::vector<Reply> replies;
  /** idle: the next wake, or none. */
  std::optional<std::int64_t> wake;
  /** stopped. */
  std::int64_t at = 0;
  /** error. */
  std::string message;
  std::string line;
};

/** The message as one line of the wire, without the line end; members in the contract's order. */
std::string write(const ToHub& message);
std::string write(const FromHub& message);

/**
 * Reads one line strictly, as the hub's own schema does: a message of a known type with exactly
 * its fields (an optional one may be left out), each of its kind and range. Throws
 * json::WireError saying what is wrong.
 */
ToHub read_to_hub(const std::string& line);
FromHub read_from_hub(const std::string& line);

/** Where the hub's program is: Bun, and the hub's main.ts (absolute paths). */
struct HubProgram {
  std::string bun;
  std::string main;
};

/** A run's folders: a fresh data folder and the socket beside it, all removed at the end. */
class RunFolder {
public:
  /** A new empty folder under $TMPDIR (or /tmp when that is too long for a socket path). */
  RunFolder();
  RunFolder(const RunFolder&) = delete;
  RunFolder& operator=(const RunFolder&) = delete;
  ~RunFolder();

  const std::string& path() const {
    return path_;
  }
  std::string data() const {
    return path_ + "/data";
  }
  std::string socket() const {
    return path_ + "/hub.sock";
  }

private:
  std::string path_;
};

/**
 * The hub's end of the wire, for a controller: a real hub process (`bun main.ts --data <folder>
 * --bench-lockstep <socket>`) on a Unix socket this side listens on, one JSON message a line both
 * ways. A `start` starts a new process (after a stop or a kill, on the same data folder) and
 * waits for it to connect; every message sent gets its answers back. Nothing here blocks for
 * longer than its timeouts: a hub that does not connect or answer is an error.
 */
class HubProcess {
public:
  HubProcess(HubProgram program, std::string data_dir, std::string socket_path);
  HubProcess(const HubProcess&) = delete;
  HubProcess& operator=(const HubProcess&) = delete;
  /** Kills a hub still running. */
  ~HubProcess();

  /** Sends one message as a line, as written; returns the hub's answers to it. */
  std::vector<FromHub> send(const ToHub& message);

  /** Sends a line as it is (for replaying recorded lines); returns the answer lines as read. */
  std::vector<std::string> send_line(const std::string& line, int answers, bool starts);

  /** `kill -9`: nothing more is committed; waits for the exit. */
  void kill();

  /** True while a hub process runs. */
  bool running() const {
    return pid_ > 0;
  }

  /** The last hub's exit status (its code, or 128 + signal), once it has exited. */
  std::optional<int> exit_status() const {
    return exit_status_;
  }

private:
  void spawn();
  void accept_connection();
  std::string read_line();
  void close_connection();
  void wait_exit();

  HubProgram program_;
  std::string data_dir_;
  std::string socket_path_;
  int listener_ = -1;
  int connection_ = -1;
  pid_t pid_ = 0;
  std::optional<int> exit_status_;
  std::string pending_;
};

}  // namespace hsn::host::lockstep
