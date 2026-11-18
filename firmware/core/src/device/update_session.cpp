#include "hsn/device/services.hpp"
#include "hsn/device/services/update.hpp"

namespace hsn::device {

// UpdateService, part three: the device's side of the Bluetooth update session (protocol section
// 10, "The update service over Bluetooth"; m3-updates-design.md section 5, D138). It opens only on
// the hub's offer (action 3), for the offer's window; a phone proves it holds the session key with
// Open's tag; then the file is pulled as on any link, and Done ends it.

namespace {

/** "hsn-ble-open/1", a zero byte, the address, the device random and the image id. */
constexpr std::size_t kOpenMessageSize = protocol::kSessionOpenLabel.size() + 4 +
                                         std::tuple_size<protocol::DeviceRandom>::value +
                                         std::tuple_size<protocol::ImageId>::value;

}  // namespace

void UpdateService::offer_bluetooth(const protocol::UpdateOffer& offer, Instant now) {
  Link* bluetooth = hal_.bluetooth;
  if (bluetooth == nullptr) {
    log_.add(now, LogLevel::warning, log_code::transfer_dropped, "no bluetooth");
    return;
  }
  if (session_ != Session::closed && nonce_ == offer.bluetooth_nonce &&
      image_id_ == offer.image_id) {
    // The same session offered again: it goes on.
    return;
  }
  // One nonce serves one session; a new offer replaces it.
  close_session();
  stop_transfer();
  leave_wifi();
  select_image(offer.image_id);
  if (hal_.update_crypto.session_key(protocol::ByteView(offer.bluetooth_nonce),
                                     setup_.pairing().address,
                                     protocol::MutableByteView(session_key_)) != HalError::none) {
    session_key_.fill(0);
    refuse_offer(offer, protocol::UpdateReason::session_refused, now);
    return;
  }
  if (bluetooth->connect(LinkTarget{}) != HalError::none) {
    session_key_.fill(0);
    refuse_offer(offer, protocol::UpdateReason::window_ended, now);
    return;
  }
  nonce_ = offer.bluetooth_nonce;
  const Duration window =
      offer.bluetooth_window_units == 0
          ? kWindowDefault
          : seconds(10 * static_cast<std::int64_t>(offer.bluetooth_window_units));
  window_end_ = now + window;
  session_end_ = now + kSessionLife;
  session_opened_ = false;
  wrong_tags_ = 0;
  session_ = Session::advertising;
}

void UpdateService::session_up(Instant now) {
  if (session_ != Session::advertising) {
    return;
  }
  session_ = Session::connected;
  // The piece this connection carries: what the link says the phone agreed, less the Data
  // frame's header; the design's smallest when it says nothing (or too little to carry data).
  const std::uint16_t largest = hal_.bluetooth->largest_packet();
  const std::size_t header = protocol::kTransferDataHeaderSize;
  bluetooth_piece_ =
      largest > header ? static_cast<std::uint16_t>(largest - header) : kPieceOnBluetooth;
  if (bluetooth_piece_ > kPieceOnLinks) {
    bluetooth_piece_ = kPieceOnLinks;
  }
  random_.fill(protocol::MutableByteView(device_random_));
  last_progress_ = now;
  protocol::transfer::Hello hello;
  hello.address = setup_.pairing().address;
  hello.device_random = device_random_;
  hello.image_id = image_id_;
  hello.bytes_held = record_verified(image_id_) ? record_bytes()
                     : have_header_
                         ? static_cast<std::uint32_t>(protocol::kImageHeaderSize) + written_bytes()
                         : 0;
  hello.largest_data = bluetooth_piece_;
  const auto size = protocol::encode_transfer(hello, protocol::MutableByteView(frame_out_));
  if (!size.ok() ||
      hal_.bluetooth->send(protocol::ByteView(frame_out_).first(size.value())) != HalError::none) {
    log_.add(now, LogLevel::warning, log_code::transfer_dropped, "hello not sent");
  }
}

void UpdateService::session_down(Instant now) {
  static_cast<void>(now);
  if (session_ == Session::closed) {
    return;
  }
  if (link_ == LinkKind::bluetooth) {
    // What is written stays; the phone may connect again (within the session's bounds) and the
    // device asks from there.
    stop_transfer();
  }
  session_ = Session::advertising;
}

void UpdateService::on_open(LinkKind link, const protocol::transfer::Open& open, Instant now) {
  if (link != LinkKind::bluetooth || session_ != Session::connected) {
    log_.add(now, LogLevel::debug, log_code::transfer_dropped, "open not expected");
    return;
  }
  std::array<std::uint8_t, kOpenMessageSize> message{};
  std::size_t at = 0;
  for (const std::uint8_t byte : protocol::kSessionOpenLabel) {
    message[at++] = byte;
  }
  const std::uint32_t address = setup_.pairing().address;
  for (std::size_t i = 0; i < 4; ++i) {
    message[at++] = static_cast<std::uint8_t>((address >> (8 * i)) & 0xFFu);
  }
  for (const std::uint8_t byte : device_random_) {
    message[at++] = byte;
  }
  for (const std::uint8_t byte : image_id_) {
    message[at++] = byte;
  }
  std::array<std::uint8_t, kSha256Size> mac{};
  const bool computed =
      hal_.update_crypto.hmac_sha256(protocol::ByteView(session_key_), protocol::ByteView(message),
                                     protocol::MutableByteView(mac)) == HalError::none;
  // Every byte is compared, so the time taken says nothing about where a wrong tag differs.
  std::uint8_t difference = computed ? 0 : 1;
  for (std::size_t i = 0; i < open.tag.size(); ++i) {
    difference = static_cast<std::uint8_t>(difference | (mac[i] ^ open.tag[i]));
  }
  mac.fill(0);
  if (difference != 0) {
    wrong_tags_ = static_cast<std::uint8_t>(wrong_tags_ + 1);
    log_.add(now, LogLevel::warning, log_code::session_refused, "wrong tag", wrong_tags_);
    if (wrong_tags_ >= kWrongTagsAllowed) {
      refuse(protocol::UpdateReason::session_refused, true, now);
      return;
    }
    // A wrong tag closes the connection; the window stays open for another try.
    hal_.bluetooth->disconnect();
    if (hal_.bluetooth->connect(LinkTarget{}) != HalError::none) {
      refuse(protocol::UpdateReason::window_ended, true, now);
      return;
    }
    session_ = Session::advertising;
    return;
  }
  session_ = Session::open;
  session_opened_ = true;
  last_progress_ = now;
  if (record_verified(image_id_)) {
    send_done(protocol::DoneResult::verified, protocol::UpdateReason::none);
    close_session();
    send_status(image_id_, protocol::UpdateStage::verified, protocol::UpdateReason::none,
                record_bytes(), false);
    return;
  }
  start_fetch(image_id_, LinkKind::bluetooth, now);
}

void UpdateService::send_done(std::uint8_t result, std::uint8_t reason) {
  if (hal_.bluetooth == nullptr) {
    return;
  }
  protocol::transfer::Done done;
  done.image_id = image_id_;
  done.result = result;
  done.reason = reason;
  const auto size = protocol::encode_transfer(done, protocol::MutableByteView(frame_out_));
  if (size.ok()) {
    static_cast<void>(hal_.bluetooth->send(protocol::ByteView(frame_out_).first(size.value())));
  }
}

void UpdateService::close_session() {
  if (session_ == Session::closed) {
    return;
  }
  if (hal_.bluetooth != nullptr) {
    hal_.bluetooth->disconnect();
  }
  if (link_ == LinkKind::bluetooth) {
    stop_transfer();
  }
  session_key_.fill(0);
  nonce_ = {};
  device_random_ = {};
  window_end_ = Instant::never();
  session_end_ = Instant::never();
  session_opened_ = false;
  session_ = Session::closed;
}

void UpdateService::poll_session(Instant now) {
  if (session_ == Session::closed) {
    return;
  }
  if (now >= session_end_) {
    refuse(protocol::UpdateReason::window_ended, true, now);
  } else if (session_ == Session::advertising && !session_opened_ && now >= window_end_) {
    // The window ended with nobody connected.
    refuse(protocol::UpdateReason::window_ended, true, now);
  } else if ((session_ != Session::advertising || session_opened_) &&
             now - last_progress_ >= kSessionNoProgress) {
    refuse(protocol::UpdateReason::link_lost, true, now);
  }
}

Instant UpdateService::session_due() const {
  Instant due = session_end_;
  if (session_ == Session::advertising && !session_opened_) {
    due = earliest(due, window_end_);
  }
  if (session_ != Session::advertising || session_opened_) {
    due = earliest(due, last_progress_ + kSessionNoProgress);
  }
  return due;
}

}  // namespace hsn::device
