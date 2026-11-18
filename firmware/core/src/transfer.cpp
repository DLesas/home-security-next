#include "hsn/protocol/transfer.hpp"

#include "codec.hpp"
#include "hsn/protocol/image.hpp"

namespace hsn::protocol {

template <typename Frame>
Error decode_transfer_body(ByteView body, Frame& out) {
  return codec::decode_struct(body, out);
}

template <typename Frame>
Result<std::size_t> encode_transfer(const Frame& frame, MutableByteView out) {
  codec::Encoder e{ByteWriter(out)};
  codec::encode_value(e, kTransferMarker);
  codec::encode_value(e, Frame::kind);
  return codec::encode_struct(e, frame);
}

// One line per type in TransferFrames: C++17 cannot generate explicit instantiations from a type
// list. A missing entry is a link error: decode_transfer and the tests use every type in both.
template Error decode_transfer_body(ByteView, transfer::Get&);
template Error decode_transfer_body(ByteView, transfer::Data&);
template Error decode_transfer_body(ByteView, transfer::Gone&);
template Error decode_transfer_body(ByteView, transfer::Hello&);
template Error decode_transfer_body(ByteView, transfer::Open&);
template Error decode_transfer_body(ByteView, transfer::Done&);

template Result<std::size_t> encode_transfer(const transfer::Get&, MutableByteView);
template Result<std::size_t> encode_transfer(const transfer::Data&, MutableByteView);
template Result<std::size_t> encode_transfer(const transfer::Gone&, MutableByteView);
template Result<std::size_t> encode_transfer(const transfer::Hello&, MutableByteView);
template Result<std::size_t> encode_transfer(const transfer::Open&, MutableByteView);
template Result<std::size_t> encode_transfer(const transfer::Done&, MutableByteView);

Error decode_image_header(ByteView bytes, ImageHeader& out) {
  return codec::decode_struct(bytes, out);
}

Result<std::size_t> encode_image_header(const ImageHeader& header, MutableByteView out) {
  codec::Encoder e{ByteWriter(out)};
  return codec::encode_struct(e, header);
}

}  // namespace hsn::protocol
