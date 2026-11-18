#include "hsn/protocol/messages.hpp"

#include "codec.hpp"

namespace hsn::protocol {

namespace codec {

void decode_value(Decoder& d, LogEntryList& out) {
  if (!d.ok()) {
    return;
  }
  d.fail(decode_log_entry_list(d.reader.read_rest(), out));
}

void encode_value(Encoder& e, const LogEntryList& value) {
  // A list is either empty (default-constructed) or validated, so its bytes are copied as they
  // are; a body needs at least one entry.
  if (e.ok() && value.encoded().empty()) {
    e.fail(Error::truncated);
    return;
  }
  encode_bytes(e, value.encoded());
}

}  // namespace codec

Error decode_log_entry_list(ByteView bytes, LogEntryList& out) {
  // One or more entries that fill the body exactly (section 6). Each entry consumes at least
  // eight bytes, so the loop is bounded by the body's length.
  if (bytes.empty()) {
    return Error::truncated;
  }
  codec::Decoder d{ByteReader(bytes)};
  while (d.ok() && d.reader.remaining() > 0) {
    LogEntry entry;
    codec::decode_value(d, entry);
  }
  if (!d.ok()) {
    return d.error;
  }
  out.encoded_ = bytes;
  return Error::none;
}

bool LogEntryReader::next(LogEntry& out) {
  if (reader_.remaining() == 0) {
    return false;
  }
  codec::Decoder d{reader_};
  LogEntry entry;
  codec::decode_value(d, entry);
  if (!d.ok()) {
    return false;
  }
  reader_ = d.reader;
  out = entry;
  return true;
}

Error LogEntriesWriter::append(const LogEntry& entry) {
  // The type byte goes first and is written with the first entry. The entry is encoded into the
  // room after what is already there, so a failure leaves earlier entries intact.
  const std::size_t start = size_ == 0 ? 1 : size_;
  codec::Encoder e{ByteWriter(out_.subspan(start))};
  codec::encode_value(e, entry);
  if (!e.ok()) {
    return e.error;
  }
  out_[0] = message_type::log_entries;
  size_ = start + e.writer.size();
  return Error::none;
}

Result<std::size_t> LogEntriesWriter::finish() const {
  if (size_ == 0) {
    return Error::truncated;
  }
  return size_;
}

LogEntryList LogEntriesWriter::entries() const {
  LogEntryList list;
  list.encoded_ = ByteView(out_).subspan(1, size_ == 0 ? 0 : size_ - 1);
  return list;
}

template <typename Message>
Error decode_body(ByteView body, Message& out) {
  return codec::decode_struct(body, out);
}

template <typename Message>
Result<std::size_t> encode_plaintext(const Message& message, MutableByteView out) {
  codec::Encoder e{ByteWriter(out)};
  codec::encode_value(e, Message::type);
  return codec::encode_struct(e, message);
}

// One line per type in Messages: C++17 cannot generate explicit instantiations from a type list.
// A missing entry is a link error: decode_message and the tests use every type in both lists.
template Error decode_body(ByteView, Heartbeat&);
template Error decode_body(ByteView, DoorChanged&);
template Error decode_body(ByteView, CoverChanged&);
template Error decode_body(ByteView, Button&);
template Error decode_body(ByteView, Started&);
template Error decode_body(ByteView, UpdateQuery&);
template Error decode_body(ByteView, UpdateStatus&);
template Error decode_body(ByteView, SirenReport&);
template Error decode_body(ByteView, Hello&);
template Error decode_body(ByteView, ForwardedPacket&);
template Error decode_body(ByteView, GatewayStatus&);
template Error decode_body(ByteView, TransmitResult&);
template Error decode_body(ByteView, Interference&);
template Error decode_body(ByteView, LogEntries&);
template Error decode_body(ByteView, Reply&);
template Error decode_body(ByteView, DisarmedNotice&);
template Error decode_body(ByteView, UpdateOffer&);
template Error decode_body(ByteView, KeyChange&);
template Error decode_body(ByteView, SirenCommand&);
template Error decode_body(ByteView, SirenSettings&);
template Error decode_body(ByteView, Welcome&);
template Error decode_body(ByteView, TransmitRequest&);
template Error decode_body(ByteView, GatewaySettings&);

template Result<std::size_t> encode_plaintext(const Heartbeat&, MutableByteView);
template Result<std::size_t> encode_plaintext(const DoorChanged&, MutableByteView);
template Result<std::size_t> encode_plaintext(const CoverChanged&, MutableByteView);
template Result<std::size_t> encode_plaintext(const Button&, MutableByteView);
template Result<std::size_t> encode_plaintext(const Started&, MutableByteView);
template Result<std::size_t> encode_plaintext(const UpdateQuery&, MutableByteView);
template Result<std::size_t> encode_plaintext(const UpdateStatus&, MutableByteView);
template Result<std::size_t> encode_plaintext(const SirenReport&, MutableByteView);
template Result<std::size_t> encode_plaintext(const Hello&, MutableByteView);
template Result<std::size_t> encode_plaintext(const ForwardedPacket&, MutableByteView);
template Result<std::size_t> encode_plaintext(const GatewayStatus&, MutableByteView);
template Result<std::size_t> encode_plaintext(const TransmitResult&, MutableByteView);
template Result<std::size_t> encode_plaintext(const Interference&, MutableByteView);
template Result<std::size_t> encode_plaintext(const LogEntries&, MutableByteView);
template Result<std::size_t> encode_plaintext(const Reply&, MutableByteView);
template Result<std::size_t> encode_plaintext(const DisarmedNotice&, MutableByteView);
template Result<std::size_t> encode_plaintext(const UpdateOffer&, MutableByteView);
template Result<std::size_t> encode_plaintext(const KeyChange&, MutableByteView);
template Result<std::size_t> encode_plaintext(const SirenCommand&, MutableByteView);
template Result<std::size_t> encode_plaintext(const SirenSettings&, MutableByteView);
template Result<std::size_t> encode_plaintext(const Welcome&, MutableByteView);
template Result<std::size_t> encode_plaintext(const TransmitRequest&, MutableByteView);
template Result<std::size_t> encode_plaintext(const GatewaySettings&, MutableByteView);

}  // namespace hsn::protocol
