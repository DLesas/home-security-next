#include "hsn/host/pty_link.hpp"

#include <fcntl.h>
#include <poll.h>
#include <termios.h>
#include <unistd.h>

#include <cerrno>
#include <cstdlib>

#include "hsn/host/simulation_error.hpp"

namespace hsn::host {
namespace {

void set_nonblocking(int fd) {
  const int flags = fcntl(fd, F_GETFL);
  if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0) {
    throw SimulationError("cannot make a pseudo-terminal non-blocking");
  }
}

const char* kind_name(device::LinkKind kind) {
  switch (kind) {
    case device::LinkKind::usb:
      return "usb";
    case device::LinkKind::network:
      return "network";
    case device::LinkKind::bluetooth:
      return "bluetooth";
  }
  return "?";
}

}  // namespace

PtyLink::PtyLink(SimDevice& device, device::LinkKind kind, Note note, Note error)
    : device_(device),
      kind_(kind),
      note_(std::move(note)),
      error_(std::move(error)),
      decoder_(protocol::MutableByteView(frame_storage_)) {
  master_ = posix_openpt(O_RDWR | O_NOCTTY);
  if (master_ < 0 || grantpt(master_) != 0 || unlockpt(master_) != 0) {
    throw SimulationError("cannot open a pseudo-terminal");
  }
  const char* name = ptsname(master_);
  if (name == nullptr) {
    throw SimulationError("a pseudo-terminal has no name");
  }
  path_ = name;
  set_nonblocking(master_);
  // A far end that never opened looks open on some systems (macOS): opening and closing it once
  // puts the terminal in the closed state, which every system reports as a hang-up.
  const int far = open(path_.c_str(), O_RDWR | O_NOCTTY | O_NONBLOCK);
  if (far >= 0) {
    close(far);
  }
  device_.wire(kind_).detach();
}

PtyLink::~PtyLink() {
  device_.wire(kind_).detach();
  if (master_ >= 0) {
    close(master_);
  }
}

void PtyLink::say(const std::string& text) const {
  if (note_) {
    note_(device_.name() + " " + kind_name(kind_) + ": " + text);
  }
}

bool PtyLink::poll_far_open() const {
  pollfd probe{master_, POLLIN, 0};
  if (poll(&probe, 1, 0) < 0) {
    return false;
  }
  return (probe.revents & (POLLHUP | POLLERR | POLLNVAL)) == 0;
}

bool PtyLink::far_end_processes_output() const {
  // Termios belongs to the terminal, shared by every open of it: opening it to read them, and
  // closing again while the far end holds it, changes nothing.
  const int far = open(path_.c_str(), O_RDWR | O_NOCTTY | O_NONBLOCK);
  if (far < 0) {
    return false;
  }
  termios settings{};
  const bool processing = tcgetattr(far, &settings) == 0 && (settings.c_oflag & OPOST) != 0;
  close(far);
  return processing;
}

void PtyLink::attach() {
  attach_at_ = device::Instant::never();
  if (error_ && far_end_processes_output()) {
    error_(device_.name() + " " + kind_name(kind_) +
           ": the far end has output processing on (each 0x0A it writes arrives as 0x0D 0x0A, "
           "corrupting frames); open the terminal raw, with OPOST cleared");
  }
  attached_ = true;
  device_.wire(kind_).attach(*this, device::Duration{});
  if (kind_ == device::LinkKind::usb) {
    device_.board().gateway_io.host = true;
  }
  say("open");
  for (const Bytes& frame : held_) {
    device_.wire(kind_).send_to_device(frame);
  }
  held_.clear();
}

void PtyLink::detach() {
  attach_at_ = device::Instant::never();
  held_.clear();
  out_.clear();
  decoder_.reset();
  if (attached_) {
    attached_ = false;
    device_.wire(kind_).detach();
    if (kind_ == device::LinkKind::usb) {
      device_.board().gateway_io.host = false;
    }
    say(cut_ ? "cut" : "closed");
  }
}

void PtyLink::service(device::Instant now) {
  const bool open_now = poll_far_open();
  if (open_now != far_open_) {
    far_open_ = open_now;
    if (!open_now) {
      detach();
    } else if (!cut_) {
      attach_at_ = now + kSettle;
    }
  }
  if (far_open_ && !cut_ && !attached_ && attach_at_ <= now) {
    attach();
  }
  if (far_open_) {
    read_frames();
    flush();
  }
}

device::Instant PtyLink::next_service(device::Instant now) const {
  const device::Instant check = now + kFarEndCheck;
  return attach_at_ < check ? attach_at_ : check;
}

void PtyLink::read_frames() {
  std::array<std::uint8_t, 512> chunk{};
  for (int reads = 0; reads < 64; ++reads) {
    const ssize_t got = read(master_, chunk.data(), chunk.size());
    if (got <= 0) {
      return;
    }
    for (ssize_t i = 0; i < got; ++i) {
      const protocol::FrameEvent event = decoder_.push(chunk[static_cast<std::size_t>(i)]);
      if (event.status == protocol::FrameStatus::dropped) {
        bad_frames_ += 1;
        say("a frame that does not decode");
      } else if (event.status == protocol::FrameStatus::frame && !cut_) {
        Bytes frame(event.data.begin(), event.data.end());
        if (attached_) {
          device_.wire(kind_).send_to_device(frame);
        } else {
          held_.push_back(std::move(frame));
        }
      }
    }
  }
}

void PtyLink::flush() {
  std::size_t written = 0;
  while (written < out_.size()) {
    const ssize_t put = write(master_, out_.data() + written, out_.size() - written);
    if (put <= 0) {
      break;
    }
    written += static_cast<std::size_t>(put);
  }
  out_.erase(out_.begin(), out_.begin() + static_cast<std::ptrdiff_t>(written));
}

void PtyLink::cut() {
  cut_ = true;
  detach();
}

void PtyLink::restore() {
  cut_ = false;
  if (far_open_) {
    attach();
  }
}

void PtyLink::link_up(LinkWire&) {}

void PtyLink::link_down(LinkWire&) {}

void PtyLink::link_packet(LinkWire&, const Bytes& packet) {
  if (!attached_) {
    dropped_frames_ += 1;
    return;
  }
  std::array<std::uint8_t, protocol::kMaxEncodedFrameSize + 1> frame{};
  const auto size = protocol::encode_frame(protocol::ByteView(packet.data(), packet.size()),
                                           protocol::MutableByteView(frame));
  if (!size.ok()) {
    dropped_frames_ += 1;
    return;
  }
  out_.insert(out_.end(), frame.begin(), frame.begin() + static_cast<std::ptrdiff_t>(size.value()));
  flush();
}

}  // namespace hsn::host
