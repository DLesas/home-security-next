#include "hsn/host/fake_radio.hpp"

namespace hsn::host {

device::HalError FakeRadio::record(RadioCall call) {
  tick();
  call.at = clock_.now();
  if (refuse_all) {
    call.result = device::HalError::io;
  } else if (fail_next != device::HalError::none) {
    call.result = fail_next;
    fail_next = device::HalError::none;
  }
  calls.push_back(call);
  if (call.result == device::HalError::none && observer_ != nullptr) {
    observer_->operation_started(*this, calls.back());
  }
  return call.result;
}

device::HalError FakeRadio::transmit(const device::RadioChannel& channel, std::int8_t power_dbm,
                                     protocol::ByteView packet) {
  RadioCall call;
  call.kind = RadioCall::Kind::transmit;
  call.channel = channel;
  call.power_dbm = power_dbm;
  call.packet.assign(packet.begin(), packet.end());
  const device::HalError error = record(call);
  if (error == device::HalError::none) {
    mode_ = RadioMode::transmitting;
    channel_ = channel;
  }
  return error;
}

device::HalError FakeRadio::receive(const device::RxParams& params) {
  RadioCall call;
  call.kind = RadioCall::Kind::receive;
  call.channel = params.channel;
  call.rx = params;
  const device::HalError error = record(call);
  if (error == device::HalError::none) {
    mode_ = RadioMode::receiving;
    channel_ = params.channel;
    rx_ = params;
  }
  return error;
}

device::HalError FakeRadio::detect_activity(const device::CadParams& params) {
  RadioCall call;
  call.kind = RadioCall::Kind::detect_activity;
  call.channel = params.channel;
  call.cad = params;
  const device::HalError error = record(call);
  if (error == device::HalError::none) {
    mode_ = RadioMode::detecting;
    channel_ = params.channel;
  }
  return error;
}

device::HalResult<std::int16_t> FakeRadio::noise_dbm() {
  RadioCall call;
  call.kind = RadioCall::Kind::noise;
  const device::HalError error = record(call);
  if (error != device::HalError::none) {
    return error;
  }
  if (mode_ != RadioMode::receiving) {
    return device::HalError::busy;
  }
  return noise;
}

device::HalError FakeRadio::sleep(bool warm) {
  RadioCall call;
  call.kind = RadioCall::Kind::sleep;
  call.warm = warm;
  const device::HalError error = record(call);
  if (error == device::HalError::none) {
    mode_ = RadioMode::sleeping;
  }
  return error;
}

device::HalError FakeRadio::recover() {
  RadioCall call;
  call.kind = RadioCall::Kind::recover;
  const device::HalError error = record(call);
  mode_ = RadioMode::standby;
  return error;
}

std::vector<RadioCall> FakeRadio::calls_of(RadioCall::Kind kind) const {
  std::vector<RadioCall> found;
  for (const RadioCall& call : calls) {
    if (call.kind == kind) {
      found.push_back(call);
    }
  }
  return found;
}

device::RadioEvent FakeRadio::tx_done(device::Instant at) {
  mode_ = RadioMode::standby;
  device::RadioEvent event;
  event.kind = device::RadioEventKind::tx_done;
  event.at = at;
  return event;
}

device::RadioEvent FakeRadio::rx_done(device::Instant at, const Bytes& packet,
                                      std::int16_t rssi_dbm, std::int8_t snr_quarter_db) {
  if (rx_.timeout.us != 0) {
    mode_ = RadioMode::standby;
  }
  rx_buffer_ = packet;
  device::RadioEvent event;
  event.kind = device::RadioEventKind::rx_done;
  event.at = at;
  event.packet = protocol::ByteView(rx_buffer_.data(), rx_buffer_.size());
  event.rssi_dbm = rssi_dbm;
  event.snr_quarter_db = snr_quarter_db;
  return event;
}

device::RadioEvent FakeRadio::rx_timeout(device::Instant at) {
  mode_ = RadioMode::standby;
  device::RadioEvent event;
  event.kind = device::RadioEventKind::rx_timeout;
  event.at = at;
  return event;
}

device::RadioEvent FakeRadio::rx_crc_error(device::Instant at) {
  if (rx_.timeout.us != 0) {
    mode_ = RadioMode::standby;
  }
  device::RadioEvent event;
  event.kind = device::RadioEventKind::rx_crc_error;
  event.at = at;
  return event;
}

device::RadioEvent FakeRadio::header_seen(device::Instant at) {
  device::RadioEvent event;
  event.kind = device::RadioEventKind::header_seen;
  event.at = at;
  return event;
}

device::RadioEvent FakeRadio::cad_done(device::Instant at, bool busy) {
  mode_ = RadioMode::standby;
  device::RadioEvent event;
  event.kind = device::RadioEventKind::cad_done;
  event.at = at;
  event.busy = busy;
  return event;
}

device::RadioEvent FakeRadio::fault(device::Instant at) {
  mode_ = RadioMode::standby;
  device::RadioEvent event;
  event.kind = device::RadioEventKind::fault;
  event.at = at;
  return event;
}

}  // namespace hsn::host
