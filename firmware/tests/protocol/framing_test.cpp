#include <array>

#include "hsn/protocol/framing.hpp"
#include "support.hpp"

namespace hsn::test {
namespace {

using protocol::Error;
using protocol::FrameStatus;
using protocol::MutableByteView;

Bytes counting(std::size_t size) {
  Bytes data(size);
  for (std::size_t i = 0; i < size; ++i) {
    data[i] = static_cast<std::uint8_t>(i % 7 == 0 ? 0 : i);
  }
  return data;
}

TEST_CASE("the encoder reports a small buffer at every size without writing past it") {
  for (const std::size_t size :
       {std::size_t{0}, std::size_t{1}, std::size_t{254}, std::size_t{300}}) {
    const Bytes data = size == 300 ? counting(size) : Bytes(size, 0x42);
    Bytes full(protocol::cobs_max_encoded_size(size));
    const auto encoded =
        protocol::cobs_encode(view(data), MutableByteView(full.data(), full.size()));
    REQUIRE(encoded.ok());
    for (std::size_t room = 0; room < encoded.value(); ++room) {
      Bytes buffer(encoded.value(), 0xEE);
      CHECK(protocol::cobs_encode(view(data), MutableByteView(buffer.data(), room)).error() ==
            Error::buffer_too_small);
      for (std::size_t i = room; i < buffer.size(); ++i) {
        CHECK(buffer[i] == 0xEE);
      }
    }
    Bytes frame(encoded.value() + 1);
    CHECK(protocol::encode_frame(view(data), MutableByteView(frame.data(), encoded.value()))
              .error() == Error::buffer_too_small);
    CHECK(protocol::encode_frame(view(data), MutableByteView(frame.data(), frame.size())).ok());
  }
}

TEST_CASE("frames are limited to one link packet") {
  const Bytes too_big(protocol::kMaxFrameDataSize + 1, 1);
  Bytes out(2 * protocol::kMaxEncodedFrameSize);
  CHECK(protocol::encode_frame(view(too_big), MutableByteView(out.data(), out.size())).error() ==
        Error::too_long);

  // 1,030 encoded bytes of 0x01 (each a zero): over both the encoded and the decoded limit.
  const Bytes long_encoded(protocol::kMaxEncodedFrameSize + 1, 0x01);
  Bytes decoded(2048);
  CHECK(protocol::cobs_decode(view(long_encoded), MutableByteView(decoded.data(), decoded.size()))
            .error() == Error::too_long);

  // The largest frame, all zeros: 1,025 encoded bytes.
  const Bytes zeros(protocol::kMaxFrameDataSize, 0);
  const auto encoded = protocol::cobs_encode(view(zeros), MutableByteView(out.data(), out.size()));
  REQUIRE(encoded.ok());
  CHECK(encoded.value() == protocol::kMaxFrameDataSize + 1);
  const auto size = protocol::cobs_decode(protocol::ByteView(out.data(), encoded.value()),
                                          MutableByteView(decoded.data(), decoded.size()));
  REQUIRE(size.ok());
  CHECK(size.value() == protocol::kMaxFrameDataSize);
}

TEST_CASE("a decoder with small storage drops a frame that does not fit, then resynchronises") {
  std::array<std::uint8_t, 4> storage{};
  protocol::FrameDecoder decoder(storage);
  const Bytes stream = from_hex("0611223344550003112202330000");
  std::vector<protocol::FrameEvent> events;
  for (const std::uint8_t byte : stream) {
    const auto event = decoder.push(byte);
    if (event.status != FrameStatus::pending) {
      events.push_back(event);
    }
  }
  REQUIRE(events.size() == 2);
  CHECK(events[0].status == FrameStatus::dropped);
  CHECK(events[0].error == Error::buffer_too_small);
  CHECK(events[1].status == FrameStatus::frame);
  CHECK(to_hex(events[1].data) == "11220033");

  Bytes out(3);
  CHECK(protocol::cobs_decode(view(from_hex("0511223344")), MutableByteView(out.data(), out.size()))
            .error() == Error::buffer_too_small);
}

TEST_CASE("reset drops a partial frame") {
  std::array<std::uint8_t, 8> storage{};
  protocol::FrameDecoder decoder(storage);
  for (const std::uint8_t byte : from_hex("051122")) {
    CHECK(decoder.push(byte).status == FrameStatus::pending);
  }
  decoder.reset();
  for (const std::uint8_t byte : from_hex("0233")) {
    CHECK(decoder.push(byte).status == FrameStatus::pending);
  }
  const auto event = decoder.push(0);
  CHECK(event.status == FrameStatus::frame);
  CHECK(to_hex(event.data) == "33");
}

}  // namespace
}  // namespace hsn::test
