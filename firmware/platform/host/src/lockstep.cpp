#include "hsn/host/lockstep.hpp"

#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <initializer_list>
#include <string_view>
#include <thread>

extern char** environ;

namespace hsn::host::lockstep {
namespace {

using json::Value;
using json::WireError;

/** How long a hub gets to connect after it is started, and to answer each line. */
constexpr auto kConnectTimeout = std::chrono::seconds(30);
constexpr auto kAnswerTimeout = std::chrono::seconds(60);
/** How long a stopped or refused hub gets to exit. */
constexpr auto kExitTimeout = std::chrono::seconds(15);

const char* type_name(ToHub::Type type) {
  switch (type) {
    case ToHub::Type::start:
      return "start";
    case ToHub::Type::advance:
      return "advance";
    case ToHub::Type::frame:
      return "frame";
    case ToHub::Type::link_up:
      return "linkUp";
    case ToHub::Type::link_down:
      return "linkDown";
    case ToHub::Type::control:
      return "control";
    case ToHub::Type::clock:
      return "clock";
    case ToHub::Type::stop:
      return "stop";
  }
  return "?";
}

/** Checks an object has exactly the members named (those marked optional may be missing). */
void check_members(const Value& object, std::initializer_list<std::string_view> required,
                   std::initializer_list<std::string_view> optional = {}) {
  for (const Value::Member& member : object.as_object()) {
    bool known = false;
    for (const std::string_view name : required) {
      known = known || member.first == name;
    }
    for (const std::string_view name : optional) {
      known = known || member.first == name;
    }
    if (!known) {
      throw WireError("an unknown member \"" + member.first + "\"");
    }
  }
  for (const std::string_view name : required) {
    if (object.find(name) == nullptr) {
      throw WireError("the member \"" + std::string(name) + "\" is missing");
    }
  }
}

std::int64_t time_of(const Value& object, std::string_view name) {
  const std::int64_t value = object.at(name).as_int();
  if (value < 0) {
    throw WireError("\"" + std::string(name) + "\" is negative");
  }
  return value;
}

std::string link_of(const Value& object) {
  const std::string& link = object.at("link").as_string();
  if (link.empty() || link.size() > 128) {
    throw WireError("a link name must have 1 to 128 characters");
  }
  return link;
}

Value frame_json(const FrameOut& frame) {
  return Value::object()
      .set("link", frame.link)
      .set("at", frame.at)
      .set("bytes", json::to_hex(frame.bytes));
}

/** With HSN_LOCKSTEP_TRACE set to a file, every line both ways, as the session files have them. */
void trace(const char* direction, const std::string& line) {
  static const char* path = std::getenv("HSN_LOCKSTEP_TRACE");
  if (path == nullptr) {
    return;
  }
  if (FILE* file = std::fopen(path, "a")) {
    std::fprintf(file, "%s %s\n", direction, line.c_str());
    std::fclose(file);
  }
}

void write_all(int fd, const std::string& text) {
  std::size_t sent = 0;
  while (sent < text.size()) {
#ifdef MSG_NOSIGNAL
    const ssize_t count = ::send(fd, text.data() + sent, text.size() - sent, MSG_NOSIGNAL);
#else
    const ssize_t count = ::send(fd, text.data() + sent, text.size() - sent, 0);
#endif
    if (count < 0) {
      if (errno == EINTR) {
        continue;
      }
      if (errno == EAGAIN) {
        pollfd waiting{fd, POLLOUT, 0};
        poll(&waiting, 1, 100);
        continue;
      }
      throw WireError(std::string("cannot write to the hub: ") + std::strerror(errno));
    }
    sent += static_cast<std::size_t>(count);
  }
}

}  // namespace

ToHub ToHub::start(std::int64_t at, std::int64_t wall, bool trusted, Bytes seed) {
  ToHub m;
  m.type = Type::start;
  m.at = at;
  m.wall = wall;
  m.trusted = trusted;
  m.seed = std::move(seed);
  return m;
}

ToHub ToHub::advance(std::int64_t to) {
  ToHub m;
  m.type = Type::advance;
  m.to = to;
  return m;
}

ToHub ToHub::frame(std::string link, std::int64_t at, Bytes bytes) {
  ToHub m;
  m.type = Type::frame;
  m.link = std::move(link);
  m.at = at;
  m.bytes = std::move(bytes);
  return m;
}

ToHub ToHub::link_up(std::string link, std::string kind, std::int64_t at) {
  ToHub m;
  m.type = Type::link_up;
  m.link = std::move(link);
  m.kind = std::move(kind);
  m.at = at;
  return m;
}

ToHub ToHub::link_down(std::string link, std::int64_t at) {
  ToHub m;
  m.type = Type::link_down;
  m.link = std::move(link);
  m.at = at;
  return m;
}

ToHub ToHub::control(std::int64_t at, std::int64_t id, std::string actor, Value command) {
  ToHub m;
  m.type = Type::control;
  m.at = at;
  m.request = Value::object()
                  .set("id", id)
                  .set("actor", std::move(actor))
                  .set("command", std::move(command));
  return m;
}

ToHub ToHub::clock(std::int64_t at, std::int64_t wall, bool trusted) {
  ToHub m;
  m.type = Type::clock;
  m.at = at;
  m.wall = wall;
  m.trusted = trusted;
  return m;
}

ToHub ToHub::stop(std::int64_t at) {
  ToHub m;
  m.type = Type::stop;
  m.at = at;
  return m;
}

int ToHub::answers() const {
  switch (type) {
    case Type::start:
    case Type::advance:
      return 1;
    case Type::stop:
      return 2;
    default:
      return 0;
  }
}

std::string write(const ToHub& m) {
  Value out = Value::object().set("type", type_name(m.type));
  switch (m.type) {
    case ToHub::Type::start:
      out.set("version", kVersion).set("at", m.at).set("wall", m.wall).set("trusted", m.trusted);
      if (m.mono.has_value()) {
        out.set("mono", *m.mono);
      }
      out.set("seed", json::to_hex(m.seed));
      if (!m.zone.empty()) {
        out.set("zone", m.zone);
      }
      break;
    case ToHub::Type::advance:
      out.set("to", m.to);
      break;
    case ToHub::Type::frame:
      out.set("link", m.link).set("at", m.at).set("bytes", json::to_hex(m.bytes));
      break;
    case ToHub::Type::link_up:
      out.set("link", m.link).set("kind", m.kind).set("at", m.at);
      break;
    case ToHub::Type::link_down:
      out.set("link", m.link).set("at", m.at);
      break;
    case ToHub::Type::control:
      out.set("at", m.at).set("request", m.request);
      break;
    case ToHub::Type::clock:
      out.set("at", m.at).set("wall", m.wall).set("trusted", m.trusted);
      break;
    case ToHub::Type::stop:
      out.set("at", m.at);
      break;
  }
  return json::write(out);
}

std::string write(const FromHub& m) {
  Value out = Value::object();
  switch (m.type) {
    case FromHub::Type::idle: {
      Value frames = Value::array();
      for (const FrameOut& frame : m.frames) {
        frames.push(frame_json(frame));
      }
      Value closed = Value::array();
      for (const ClosedLink& link : m.closed) {
        closed.push(
            Value::object().set("link", link.link).set("at", link.at).set("reason", link.reason));
      }
      Value records = Value::array();
      for (const Value& record : m.records) {
        records.push(record);
      }
      Value replies = Value::array();
      for (const Reply& reply : m.replies) {
        replies.push(Value::object().set("id", reply.id).set("reply", reply.reply));
      }
      out.set("type", "idle")
          .set("to", m.to)
          .set("boot", m.boot)
          .set("frames", std::move(frames))
          .set("closed", std::move(closed))
          .set("records", std::move(records))
          .set("replies", std::move(replies))
          .set("wake", m.wake.has_value() ? Value(*m.wake) : Value());
      break;
    }
    case FromHub::Type::stopped:
      out.set("type", "stopped").set("at", m.at);
      break;
    case FromHub::Type::error:
      out.set("type", "error").set("message", m.message).set("line", m.line);
      break;
  }
  return json::write(out);
}

ToHub read_to_hub(const std::string& line) {
  const Value v = json::parse(line);
  const std::string& type = v.at("type").as_string();
  ToHub m;
  if (type == "start") {
    check_members(v, {"type", "version", "at", "wall", "trusted", "seed"}, {"mono", "zone"});
    if (v.at("version").as_int() != kVersion) {
      throw WireError("version " + std::to_string(v.at("version").as_int()) + " is not " +
                      std::to_string(kVersion));
    }
    m = ToHub::start(time_of(v, "at"), time_of(v, "wall"), v.at("trusted").as_bool(),
                     json::from_hex(v.at("seed").as_string()));
    if (m.seed.size() != 32) {
      throw WireError("the seed must be 32 bytes");
    }
    if (v.find("mono") != nullptr) {
      m.mono = time_of(v, "mono");
    }
    if (const Value* zone = v.find("zone")) {
      m.zone = zone->as_string();
      if (m.zone.empty() || m.zone.size() > 64) {
        throw WireError("a zone has 1 to 64 characters");
      }
    }
  } else if (type == "advance") {
    check_members(v, {"type", "to"});
    m = ToHub::advance(time_of(v, "to"));
  } else if (type == "frame") {
    check_members(v, {"type", "link", "at", "bytes"});
    m = ToHub::frame(link_of(v), time_of(v, "at"), json::from_hex(v.at("bytes").as_string()));
    if (m.bytes.empty()) {
      throw WireError("a frame has at least one byte");
    }
  } else if (type == "linkUp") {
    check_members(v, {"type", "link", "kind", "at"});
    const std::string& kind = v.at("kind").as_string();
    if (kind != "usb" && kind != "network") {
      throw WireError("a link's kind is usb or network, not " + kind);
    }
    m = ToHub::link_up(link_of(v), kind, time_of(v, "at"));
  } else if (type == "linkDown") {
    check_members(v, {"type", "link", "at"});
    m = ToHub::link_down(link_of(v), time_of(v, "at"));
  } else if (type == "control") {
    check_members(v, {"type", "at", "request"});
    const Value& request = v.at("request");
    check_members(request, {"id", "actor", "command"});
    const std::int64_t id = request.at("id").as_int();
    if (id < 0) {
      throw WireError("a request's id is negative");
    }
    if (request.at("actor").as_string().empty()) {
      throw WireError("a request's actor is empty");
    }
    static_cast<void>(request.at("command").at("kind").as_string());
    m = ToHub::control(time_of(v, "at"), id, request.at("actor").as_string(),
                       request.at("command"));
  } else if (type == "clock") {
    check_members(v, {"type", "at", "wall", "trusted"});
    m = ToHub::clock(time_of(v, "at"), time_of(v, "wall"), v.at("trusted").as_bool());
  } else if (type == "stop") {
    check_members(v, {"type", "at"});
    m = ToHub::stop(time_of(v, "at"));
  } else {
    throw WireError("an unknown message type \"" + type + "\"");
  }
  return m;
}

FromHub read_from_hub(const std::string& line) {
  const Value v = json::parse(line);
  const std::string& type = v.at("type").as_string();
  FromHub m;
  if (type == "idle") {
    check_members(v, {"type", "to", "boot", "frames", "closed", "records", "replies", "wake"});
    m.type = FromHub::Type::idle;
    m.to = time_of(v, "to");
    m.boot = v.at("boot").as_int();
    if (m.boot < 1) {
      throw WireError("a boot is at least 1");
    }
    for (const Value& frame : v.at("frames").as_array()) {
      check_members(frame, {"link", "at", "bytes"});
      m.frames.push_back(FrameOut{link_of(frame), time_of(frame, "at"),
                                  json::from_hex(frame.at("bytes").as_string())});
    }
    for (const Value& link : v.at("closed").as_array()) {
      check_members(link, {"link", "at", "reason"});
      m.closed.push_back(
          ClosedLink{link_of(link), time_of(link, "at"), link.at("reason").as_string()});
    }
    for (const Value& record : v.at("records").as_array()) {
      check_members(record, {"kind", "row"}, {"table"});
      static_cast<void>(record.at("kind").as_string());
      static_cast<void>(record.at("row").as_object());
      m.records.push_back(record);
    }
    for (const Value& reply : v.at("replies").as_array()) {
      check_members(reply, {"id", "reply"});
      static_cast<void>(reply.at("reply").at("ok").as_bool());
      m.replies.push_back(Reply{reply.at("id").as_int(), reply.at("reply")});
    }
    const Value& wake = v.at("wake");
    if (!wake.is_null()) {
      m.wake = time_of(v, "wake");
    }
  } else if (type == "stopped") {
    check_members(v, {"type", "at"});
    m.type = FromHub::Type::stopped;
    m.at = time_of(v, "at");
  } else if (type == "error") {
    check_members(v, {"type", "message", "line"});
    m.type = FromHub::Type::error;
    m.message = v.at("message").as_string();
    m.line = v.at("line").as_string();
  } else {
    throw WireError("an unknown message type \"" + type + "\"");
  }
  return m;
}

RunFolder::RunFolder() {
  // A Unix socket's path is short (104 bytes on macOS): a long $TMPDIR falls back to /tmp.
  const char* temporary = std::getenv("TMPDIR");
  std::string base = temporary != nullptr && std::strlen(temporary) < 60 ? temporary : "/tmp";
  if (!base.empty() && base.back() == '/') {
    base.pop_back();
  }
  std::string pattern = base + "/hsn-lockstep-XXXXXX";
  if (mkdtemp(pattern.data()) == nullptr) {
    throw WireError("cannot make a folder for the hub's run under " + base);
  }
  path_ = pattern;
}

RunFolder::~RunFolder() {
  std::error_code ignored;
  std::filesystem::remove_all(path_, ignored);
}

HubProcess::HubProcess(HubProgram program, std::string data_dir, std::string socket_path)
    : program_(std::move(program)),
      data_dir_(std::move(data_dir)),
      socket_path_(std::move(socket_path)) {
  sockaddr_un address{};
  if (socket_path_.size() >= sizeof(address.sun_path)) {
    throw WireError("the socket path is too long: " + socket_path_);
  }
  listener_ = ::socket(AF_UNIX, SOCK_STREAM, 0);
  if (listener_ < 0) {
    throw WireError("cannot make a socket");
  }
  address.sun_family = AF_UNIX;
  std::memcpy(address.sun_path, socket_path_.c_str(), socket_path_.size() + 1);
  ::unlink(socket_path_.c_str());
  if (::bind(listener_, reinterpret_cast<const sockaddr*>(&address), sizeof address) != 0 ||
      ::listen(listener_, 1) != 0) {
    ::close(listener_);
    throw WireError("cannot listen on " + socket_path_ + ": " + std::strerror(errno));
  }
  fcntl(listener_, F_SETFL, fcntl(listener_, F_GETFL) | O_NONBLOCK);
}

HubProcess::~HubProcess() {
  if (pid_ > 0) {
    ::kill(pid_, SIGKILL);
    waitpid(pid_, nullptr, 0);
  }
  close_connection();
  if (listener_ >= 0) {
    ::close(listener_);
  }
  ::unlink(socket_path_.c_str());
}

void HubProcess::spawn() {
  posix_spawn_file_actions_t actions;
  posix_spawn_file_actions_init(&actions);
  posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0);
  posix_spawn_file_actions_addopen(&actions, STDOUT_FILENO, "/dev/null", O_WRONLY, 0);
  std::vector<std::string> args = {program_.bun, program_.main,      "--data",
                                   data_dir_,    "--bench-lockstep", socket_path_};
  std::vector<char*> argv;
  for (std::string& arg : args) {
    argv.push_back(arg.data());
  }
  argv.push_back(nullptr);
  const int spawned =
      posix_spawn(&pid_, program_.bun.c_str(), &actions, nullptr, argv.data(), environ);
  posix_spawn_file_actions_destroy(&actions);
  if (spawned != 0) {
    pid_ = 0;
    throw WireError("cannot start the hub with " + program_.bun + ": " + std::strerror(spawned));
  }
  exit_status_.reset();
}

void HubProcess::accept_connection() {
  const auto deadline = std::chrono::steady_clock::now() + kConnectTimeout;
  while (std::chrono::steady_clock::now() < deadline) {
    pollfd waiting{listener_, POLLIN, 0};
    if (poll(&waiting, 1, 100) > 0) {
      connection_ = ::accept(listener_, nullptr, nullptr);
      if (connection_ >= 0) {
#ifdef SO_NOSIGPIPE
        const int on = 1;
        setsockopt(connection_, SOL_SOCKET, SO_NOSIGPIPE, &on, sizeof on);
#endif
        fcntl(connection_, F_SETFL, fcntl(connection_, F_GETFL) | O_NONBLOCK);
        return;
      }
    }
    int status = 0;
    if (waitpid(pid_, &status, WNOHANG) == pid_) {
      pid_ = 0;
      exit_status_ = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
      throw WireError("the hub exited with status " + std::to_string(*exit_status_) +
                      " before it connected");
    }
  }
  throw WireError("the hub did not connect within 30 s");
}

std::string HubProcess::read_line() {
  const auto deadline = std::chrono::steady_clock::now() + kAnswerTimeout;
  for (;;) {
    for (auto end = pending_.find('\n'); end != std::string::npos; end = pending_.find('\n')) {
      std::string line = pending_.substr(0, end);
      pending_.erase(0, end + 1);
      if (!line.empty()) {
        trace("<", line);
        return line;
      }
    }
    if (pending_.size() > kMaxLine) {
      throw WireError("the hub sent a line longer than 1 MiB");
    }
    if (connection_ < 0) {
      throw WireError("no hub is connected");
    }
    if (std::chrono::steady_clock::now() > deadline) {
      throw WireError("the hub did not answer within 60 s");
    }
    pollfd waiting{connection_, POLLIN, 0};
    if (poll(&waiting, 1, 100) <= 0) {
      continue;
    }
    char chunk[65536];
    const ssize_t got = ::read(connection_, chunk, sizeof chunk);
    if (got > 0) {
      pending_.append(chunk, static_cast<std::size_t>(got));
    } else if (got == 0) {
      close_connection();
      throw WireError("the hub closed the socket");
    } else if (errno != EAGAIN && errno != EINTR) {
      throw WireError(std::string("cannot read from the hub: ") + std::strerror(errno));
    }
  }
}

void HubProcess::close_connection() {
  if (connection_ >= 0) {
    ::close(connection_);
    connection_ = -1;
  }
  pending_.clear();
}

void HubProcess::wait_exit() {
  const auto deadline = std::chrono::steady_clock::now() + kExitTimeout;
  while (pid_ > 0) {
    int status = 0;
    const pid_t done = waitpid(pid_, &status, WNOHANG);
    if (done == pid_) {
      exit_status_ = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
      pid_ = 0;
      break;
    }
    if (std::chrono::steady_clock::now() > deadline) {
      ::kill(pid_, SIGKILL);
      waitpid(pid_, &status, 0);
      exit_status_ = 128 + SIGKILL;
      pid_ = 0;
      break;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  close_connection();
}

std::vector<std::string> HubProcess::send_line(const std::string& line, int answers, bool starts) {
  if (starts) {
    if (pid_ > 0) {
      throw WireError("a start while a hub still runs: stop or kill it first");
    }
    close_connection();
    spawn();
    accept_connection();
  }
  if (connection_ < 0) {
    throw WireError("no hub is connected: start one first");
  }
  trace(">", line);
  write_all(connection_, line + "\n");
  std::vector<std::string> out;
  for (int n = 0; n < answers; ++n) {
    out.push_back(read_line());
    bool refused = false;
    try {
      refused = json::parse(out.back()).at("type").as_string() == "error";
    } catch (const WireError&) {
      // Not the wire's JSON: the caller's reading says so.
    }
    if (refused) {
      wait_exit();
      return out;
    }
  }
  if (answers == 2) {
    wait_exit();
  }
  return out;
}

std::vector<FromHub> HubProcess::send(const ToHub& message) {
  std::vector<FromHub> out;
  for (const std::string& line :
       send_line(write(message), message.answers(), message.type == ToHub::Type::start)) {
    out.push_back(read_from_hub(line));
  }
  return out;
}

void HubProcess::kill() {
  if (pid_ > 0) {
    ::kill(pid_, SIGKILL);
    int status = 0;
    waitpid(pid_, &status, 0);
    exit_status_ = 128 + SIGKILL;
    pid_ = 0;
  }
  close_connection();
}

}  // namespace hsn::host::lockstep
