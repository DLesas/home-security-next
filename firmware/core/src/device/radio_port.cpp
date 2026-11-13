#include "hsn/device/services/radio_port.hpp"

#include <cstring>

#include "hsn/device/services/radio_plan.hpp"

namespace hsn::device {

Admission RadioPort::check(const Transmission& transmission, std::size_t length,
                           Instant now) const {
  const auto band = band_of(transmission.channel.frequency_hz);
  const auto airtime = time_on_air(transmission.channel.data_rate, length);
  if (!band.has_value() || !airtime.has_value()) {
    return Admission{};
  }
  return airtime_.admit(*band, *airtime, transmission.tx_class, now);
}

Status RadioPort::send(protocol::ByteView packet, const Transmission& transmission, Instant now) {
  if (state_ == PortState::checking || state_ == PortState::backing_off ||
      state_ == PortState::sending) {
    return Status::busy;
  }
  const auto band = band_of(transmission.channel.frequency_hz);
  const auto airtime = time_on_air(transmission.channel.data_rate, packet.size());
  if (!band.has_value() || !airtime.has_value() || packet.size() < protocol::kMinPacketSize) {
    return Status::refused;
  }
  if (!airtime_.admit(*band, *airtime, transmission.tx_class, now).allowed) {
    return Status::deferred;
  }
  std::memcpy(packet_.data(), packet.data(), packet.size());
  size_ = packet.size();
  resume_listening_ = state_ == PortState::receiving && continuous_;
  transmission_ = transmission;
  band_ = *band;
  airtime_needed_ = *airtime;
  busy_checks_ = 0;
  return transmission.listen_first ? start_check(now) : start_transmit(now);
}

Status RadioPort::start_check(Instant now) {
  const auto params = cad_params(transmission_.channel);
  const auto duration = cad_duration(transmission_.channel.data_rate);
  if (!params.has_value() || !duration.has_value()) {
    become_idle();
    return Status::refused;
  }
  if (radio_.detect_activity(*params) != HalError::none) {
    log_.add(now, LogLevel::warning, log_code::radio_refused, "cad refused");
    become_idle();
    return Status::radio_error;
  }
  state_ = PortState::checking;
  deadline_ = now + *duration + kRadioGuardMargin;
  return Status::ok;
}

void RadioPort::start_wait(Instant now) {
  state_ = PortState::backing_off;
  wait_end_ = now + random_.between(kBusyWaitMin, kBusyWaitMax);
  deadline_ = wait_end_;
  wait_receiving_ = false;
  wait_listening_ = false;
  if (resume_listening_) {
    if (radio_.receive(rx_params_) == HalError::none) {
      wait_listening_ = true;
    } else {
      log_.add(now, LogLevel::warning, log_code::radio_refused, "rx refused");
    }
  }
}

Instant RadioPort::reception_guard(Instant now) const {
  // A packet whose header has arrived may last up to the longest radio packet at this rate.
  const auto longest = time_on_air(rx_params_.channel.data_rate, protocol::kMaxRadioPacketSize);
  return now + longest.value_or(seconds(10)) + kRadioGuardMargin;
}

PortReport RadioPort::on_wait_event(const RadioEvent& event, Instant now) {
  if (!wait_listening_) {
    return PortReport{};
  }
  switch (event.kind) {
    case RadioEventKind::header_seen:
      // Receiving comes first: the next check waits for this reception, within a guard.
      wait_receiving_ = true;
      deadline_ = latest(wait_end_, reception_guard(now));
      return PortReport{};
    case RadioEventKind::rx_done:
    case RadioEventKind::rx_crc_error:
      // The receive is continuous: the radio goes on listening for the rest of the wait.
      wait_receiving_ = false;
      deadline_ = wait_end_;
      return PortReport{
          event.kind == RadioEventKind::rx_done ? PortResult::received : PortResult::rx_error,
          event.at};
    default:
      return PortReport{};
  }
}

Status RadioPort::start_transmit(Instant now) {
  // The check took time; the budget is judged again with the same class.
  const Admission admission = airtime_.admit(band_, airtime_needed_, transmission_.tx_class, now);
  if (!admission.allowed) {
    become_idle();
    return Status::deferred;
  }
  const HalError error = radio_.transmit(transmission_.channel, transmission_.power_dbm,
                                         protocol::ByteView(packet_.data(), size_));
  if (error != HalError::none) {
    log_.add(now, LogLevel::warning, log_code::radio_refused, "tx refused");
    become_idle();
    return Status::radio_error;
  }
  if (admission.past_limit) {
    // D111: every packet sent past the legal hour is logged; the log merges repeats.
    log_.add(now, LogLevel::warning, log_code::airtime_past_limit, "past airtime limit");
  }
  airtime_.record(band_, now, airtime_needed_);
  state_ = PortState::sending;
  deadline_ = now + airtime_needed_ + kRadioGuardMargin;
  return Status::ok;
}

Status RadioPort::listen(const RxParams& params, Instant now) {
  if (state_ == PortState::checking || state_ == PortState::backing_off ||
      state_ == PortState::sending) {
    return Status::busy;
  }
  if (radio_.receive(params) != HalError::none) {
    log_.add(now, LogLevel::warning, log_code::radio_refused, "rx refused");
    become_idle();
    return Status::radio_error;
  }
  state_ = PortState::receiving;
  rx_params_ = params;
  continuous_ = params.timeout.us == 0;
  rx_data_rate_ = params.channel.data_rate;
  rx_timeout_ = params.timeout;
  if (continuous_) {
    deadline_ = Instant::never();
  } else {
    // With stop-on-preamble a packet may keep the radio receiving past the timeout: allow the
    // longest radio packet at that rate.
    const auto longest = time_on_air(rx_data_rate_, protocol::kMaxRadioPacketSize);
    deadline_ = now + params.timeout + longest.value_or(seconds(10)) + kRadioGuardMargin;
  }
  return Status::ok;
}

void RadioPort::sleep(Instant now) {
  if (radio_.sleep(true) != HalError::none) {
    log_.add(now, LogLevel::warning, log_code::radio_refused, "sleep refused");
  }
  become_idle();
}

void RadioPort::become_idle() {
  state_ = PortState::idle;
  deadline_ = Instant::never();
  wait_listening_ = false;
  wait_receiving_ = false;
}

PortReport RadioPort::recover(Instant now) {
  log_.add(now, LogLevel::error, log_code::radio_guard, "radio recovered");
  static_cast<void>(radio_.recover());
  become_idle();
  return PortReport{PortResult::recovered, now};
}

PortReport RadioPort::on_radio(const RadioEvent& event, Instant now) {
  if (event.kind == RadioEventKind::fault) {
    return recover(now);
  }
  switch (state_) {
    case PortState::checking:
      if (event.kind != RadioEventKind::cad_done) {
        return PortReport{};
      }
      if (event.busy) {
        busy_checks_ = static_cast<std::uint8_t>(busy_checks_ + 1);
        if (busy_checks_ < kMaxBusyChecks) {
          start_wait(now);
          return PortReport{};
        }
      }
      // Clear, or busy five times: send anyway.
      if (start_transmit(now) != Status::ok) {
        return PortReport{PortResult::not_sent, now};
      }
      return PortReport{};
    case PortState::sending:
      if (event.kind != RadioEventKind::tx_done) {
        return PortReport{};
      }
      become_idle();
      return PortReport{PortResult::sent, event.at};
    case PortState::receiving:
      switch (event.kind) {
        case RadioEventKind::header_seen:
          if (!continuous_) {
            // A packet is arriving: let it finish, however long the timeout was.
            const auto longest = time_on_air(rx_data_rate_, protocol::kMaxRadioPacketSize);
            deadline_ = now + longest.value_or(seconds(10)) + kRadioGuardMargin;
          }
          return PortReport{};
        case RadioEventKind::rx_done:
          if (!continuous_) {
            become_idle();
          }
          return PortReport{PortResult::received, event.at};
        case RadioEventKind::rx_crc_error:
          if (!continuous_) {
            become_idle();
          }
          return PortReport{PortResult::rx_error, event.at};
        case RadioEventKind::rx_timeout:
          become_idle();
          return PortReport{PortResult::rx_timeout, event.at};
        default:
          return PortReport{};
      }
    case PortState::backing_off:
      return on_wait_event(event, now);
    case PortState::idle:
      return PortReport{};
  }
  return PortReport{};
}

PortReport RadioPort::on_timer(Instant now) {
  if (now < deadline_) {
    return PortReport{};
  }
  if (state_ == PortState::backing_off) {
    // The wait is over and no reception holds it (or its guard passed): the check cancels the
    // resumed receive.
    if (wait_receiving_) {
      log_.add(now, LogLevel::warning, log_code::radio_guard, "reception overran");
    }
    wait_receiving_ = false;
    wait_listening_ = false;
    if (start_check(now) != Status::ok) {
      return PortReport{PortResult::not_sent, now};
    }
    return PortReport{};
  }
  if (state_ == PortState::idle) {
    deadline_ = Instant::never();
    return PortReport{};
  }
  return recover(now);
}

}  // namespace hsn::device
