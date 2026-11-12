#include "hsn/protocol/setup.hpp"

#include "codec.hpp"

namespace hsn::protocol {

Error decode_pairing_data(ByteView bytes, PairingData& out) {
  return codec::decode_struct(bytes, out);
}

Result<std::size_t> encode_pairing_data(const PairingData& pairing, MutableByteView out) {
  codec::Encoder e{ByteWriter(out)};
  return codec::encode_struct(e, pairing);
}

template <typename Message>
Error decode_setup_body(ByteView body, Message& out) {
  return codec::decode_struct(body, out);
}

template <typename Message>
Result<std::size_t> encode_setup(const Message& message, MutableByteView out) {
  codec::Encoder e{ByteWriter(out)};
  codec::encode_value(e, kSetupMarker);
  codec::encode_value(e, Message::type);
  return codec::encode_struct(e, message);
}

// One line per type in SetupMessages: C++17 cannot generate explicit instantiations from a type
// list. A missing entry is a link error: decode_setup and the tests use every type in both lists.
template Error decode_setup_body(ByteView, Identify&);
template Error decode_setup_body(ByteView, Identity&);
template Error decode_setup_body(ByteView, Provision&);
template Error decode_setup_body(ByteView, ProvisionResult&);
template Error decode_setup_body(ByteView, Erase&);

template Result<std::size_t> encode_setup(const Identify&, MutableByteView);
template Result<std::size_t> encode_setup(const Identity&, MutableByteView);
template Result<std::size_t> encode_setup(const Provision&, MutableByteView);
template Result<std::size_t> encode_setup(const ProvisionResult&, MutableByteView);
template Result<std::size_t> encode_setup(const Erase&, MutableByteView);

}  // namespace hsn::protocol
