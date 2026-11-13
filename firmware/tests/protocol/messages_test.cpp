#include <array>

#include "hsn/protocol/messages.hpp"
#include "hsn/protocol/setup.hpp"
#include "support.hpp"

namespace hsn::test {
namespace {

using protocol::Error;
using protocol::MutableByteView;

TEST_CASE("every message encodes whole or reports a small buffer without writing past it") {
  protocol::for_each_type<protocol::Messages>([](auto tag) {
    using Message = typename decltype(tag)::type;
    INFO("message type " << int{Message::type});
    Arena arena;
    const Message message = sample_message<Message>(arena);
    Bytes full(protocol::kMaxLinkPacketSize);
    const auto size =
        protocol::encode_plaintext(message, MutableByteView(full.data(), full.size()));
    REQUIRE_MESSAGE(size.ok(), error_name(size.error()));
    full.resize(size.value());
    CHECK(full[0] == Message::type);
    for (std::size_t room = 0; room < full.size(); ++room) {
      Bytes buffer(full.size(), 0xEE);
      const auto result = protocol::encode_plaintext(message, MutableByteView(buffer.data(), room));
      CHECK(result.error() == Error::buffer_too_small);
      for (std::size_t i = room; i < buffer.size(); ++i) {
        CHECK(buffer[i] == 0xEE);
      }
    }
    // The encoded body decodes back to the same fields.
    Message decoded{};
    REQUIRE(protocol::decode_body(view(full).subspan(1), decoded) == Error::none);
    CHECK(to_json(decoded) == to_json(message));
  });
}

TEST_CASE("every body shorter than its fields is truncated, and leaves the output alone") {
  protocol::for_each_type<protocol::Messages>([](auto tag) {
    using Message = typename decltype(tag)::type;
    INFO("message type " << int{Message::type});
    Arena arena;
    Message message = sample_message<Message>(arena);
    Bytes full(protocol::kMaxLinkPacketSize);
    const auto size =
        protocol::encode_plaintext(message, MutableByteView(full.data(), full.size()));
    REQUIRE(size.ok());
    const protocol::ByteView body = view(full).subspan(1, size.value() - 1);
    const json before = to_json(message);
    for (std::size_t length = 0; length < body.size(); ++length) {
      CHECK(protocol::decode_body(body.first(length), message) == Error::truncated);
      CHECK(to_json(message) == before);
    }
  });
}

TEST_CASE("unknown message types are refused and never visited") {
  bool visited = false;
  const auto visit = [&](const auto&) { visited = true; };
  int known = 0;
  for (int type = 0; type < 256; ++type) {
    const auto byte = static_cast<std::uint8_t>(type);
    if (protocol::is_known_message_type(byte)) {
      known += 1;
      continue;
    }
    CHECK(protocol::decode_message(byte, protocol::ByteView(), visit) == Error::unknown_type);
  }
  CHECK(known == 19);
  CHECK_FALSE(visited);
}

TEST_CASE("a reply built without the move fields announces no move") {
  const protocol::Reply reply{};
  CHECK(reply.next_site_channel == protocol::kStaysAsItIs);
  CHECK(reply.next_send_data_rate == protocol::kStaysAsItIs);
  std::array<std::uint8_t, 15> out{};
  const auto size = protocol::encode_plaintext(reply, out);
  REQUIRE(size.ok());
  CHECK(size.value() == 15);
  CHECK(out[13] == 0xFF);
  CHECK(out[14] == 0xFF);
  // The body before D115 was 12 bytes; it is now too short.
  protocol::Reply decoded{};
  CHECK(protocol::decode_body(protocol::ByteView(out).subspan(1, 12), decoded) == Error::truncated);
}

TEST_CASE("flags write unnamed bits as zero and ignore them when read") {
  protocol::Reply reply{};
  reply.flags = {true, true, true};
  std::array<std::uint8_t, 16> out{};
  REQUIRE(protocol::encode_plaintext(reply, out).ok());
  CHECK(out[2] == 0x07);
  std::array<std::uint8_t, 14> body{};
  body[1] = 0xF8;
  REQUIRE(protocol::decode_body(protocol::ByteView(body), reply) == Error::none);
  CHECK(to_json(reply.flags) ==
        json{{"armed", false}, {"countdownStarted", false}, {"updateAvailable", false}});
}

TEST_CASE("the sensor status flags name all eight bits, bit 7 listening at the sending rate") {
  protocol::Heartbeat heartbeat{};
  heartbeat.flags = {true, true, true, true, true, true, true, true};
  std::array<std::uint8_t, 8> out{};
  REQUIRE(protocol::encode_plaintext(heartbeat, out).ok());
  CHECK(out[2] == 0xFF);
  const std::array<std::uint8_t, 7> body{0, 0x80, 0, 0, 0, 0, 0};
  REQUIRE(protocol::decode_body(protocol::ByteView(body), heartbeat) == Error::none);
  CHECK(to_json(heartbeat.flags) == json{{"doorOpen", false},
                                         {"coverOpen", false},
                                         {"usbPower", false},
                                         {"charging", false},
                                         {"replyWanted", false},
                                         {"localAlarmSounded", false},
                                         {"buzzing", false},
                                         {"listeningAtSendRate", true}});
}

TEST_CASE("carried packets must be 18 to 255 bytes on encode too") {
  Arena arena;
  protocol::TransmitRequest request = sample_message<protocol::TransmitRequest>(arena);
  Bytes out(protocol::kMaxLinkPacketSize);
  const MutableByteView out_view(out.data(), out.size());
  request.packet.bytes = arena.keep(Bytes(17, 1));
  CHECK(protocol::encode_plaintext(request, out_view).error() == Error::truncated);
  request.packet.bytes = arena.keep(Bytes(256, 1));
  CHECK(protocol::encode_plaintext(request, out_view).error() == Error::too_long);
  request.packet.bytes = arena.keep(Bytes(255, 1));
  CHECK(protocol::encode_plaintext(request, out_view).ok());
}

TEST_CASE("the log entries writer appends whole entries") {
  Arena arena;
  protocol::LogEntry entry{};
  entry.text.bytes = arena.keep(Bytes(protocol::kMaxLogTextSize, 'x'));
  // Type byte, then one 72-byte entry.
  Bytes buffer(1 + 72 + 10, 0xEE);
  protocol::LogEntriesWriter writer(MutableByteView(buffer.data(), buffer.size()));
  CHECK(writer.finish().error() == Error::truncated);
  CHECK(writer.entries().encoded().empty());
  REQUIRE(writer.append(entry) == Error::none);
  CHECK(writer.append(entry) == Error::buffer_too_small);
  REQUIRE(writer.finish().ok());
  CHECK(writer.finish().value() == 73);
  entry.text.bytes = arena.keep(Bytes(protocol::kMaxLogTextSize + 1, 'x'));
  CHECK(writer.append(entry) == Error::bad_length);
  entry.text.bytes = arena.keep(Bytes(2, 'y'));
  REQUIRE(writer.append(entry) == Error::none);
  CHECK(writer.finish().value() == 83);
  CHECK(buffer[0] == protocol::message_type::log_entries);

  protocol::LogEntryReader reader(writer.entries());
  protocol::LogEntry read{};
  REQUIRE(reader.next(read));
  CHECK(read.text.bytes.size() == protocol::kMaxLogTextSize);
  REQUIRE(reader.next(read));
  CHECK(read.text.bytes.size() == 2);
  CHECK_FALSE(reader.next(read));

  protocol::LogEntries empty{};
  Bytes out(16);
  CHECK(protocol::encode_plaintext(empty, MutableByteView(out.data(), out.size())).error() ==
        Error::truncated);
  protocol::LogEntriesWriter no_room{MutableByteView()};
  CHECK(no_room.append(entry) == Error::buffer_too_small);
}

TEST_CASE("setup messages: booleans, lengths and buffers") {
  Arena arena;
  protocol::Identity identity{};
  std::array<std::uint8_t, 22> bytes{};
  REQUIRE(protocol::encode_setup(identity, bytes).ok());
  CHECK(protocol::encode_setup(identity, MutableByteView(bytes.data(), 21)).error() ==
        Error::buffer_too_small);
  bytes[21] = 2;  // development build
  CHECK(protocol::decode_setup(protocol::ByteView(bytes), [](const auto&) {}) == Error::bad_value);

  protocol::PairingData pairing{};
  Bytes out(256);
  const MutableByteView out_view(out.data(), out.size());
  CHECK(protocol::encode_pairing_data(pairing, out_view).error() == Error::bad_address);
  pairing.address = 0xFFFFFFFFu;
  CHECK(protocol::encode_pairing_data(pairing, out_view).error() == Error::bad_address);
  pairing.address = 1;
  pairing.wifi_name.bytes = arena.keep(Bytes(protocol::kMaxWifiNameSize + 1, 'n'));
  CHECK(protocol::encode_pairing_data(pairing, out_view).error() == Error::bad_length);
  pairing.wifi_name.bytes = arena.keep(Bytes(protocol::kMaxWifiNameSize, 'n'));
  pairing.wifi_password.bytes = arena.keep(Bytes(protocol::kMaxWifiPasswordSize, 'p'));
  const auto size = protocol::encode_pairing_data(pairing, out_view);
  REQUIRE(size.ok());
  CHECK(size.value() == 1 + 4 + 16 + 8 + 64 + 1 + 1 + 1 + 32 + 1 + 64);
  CHECK(out[0] == protocol::kPairingFormatVersion);
  protocol::PairingData decoded{};
  REQUIRE(protocol::decode_pairing_data(view(out).first(size.value()), decoded) == Error::none);
  CHECK(to_json(decoded) == to_json(pairing));
  protocol::Provision provision{};
  provision.pairing = pairing;
  Bytes message(256);
  const auto message_size =
      protocol::encode_setup(provision, MutableByteView(message.data(), message.size()));
  REQUIRE(message_size.ok());
  CHECK(message_size.value() == 2 + size.value());
}

}  // namespace
}  // namespace hsn::test
