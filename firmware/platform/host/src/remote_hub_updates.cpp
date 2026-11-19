// RemoteHub's firmware updates, backups and restores (m3-updates-design.md sections 4, 5, 7 and
// 8): the commands the system tests use, as `hsn` sends them on the control socket, and what this
// side reads of what the hub sends for them (transfer frames, Key changes).

#include <algorithm>
#include <filesystem>
#include <string_view>

#include "hsn/host/remote_hub.hpp"
#include "hsn/host/test_image.hpp"
#include "hsn/protocol/messages.hpp"
#include "hsn/protocol/transfer.hpp"

namespace hsn::host {
namespace {

using json::Value;

/** `fileChunk`'s largest chunk (FILE_CHUNKS.maxChunkBytes, m2-design.md section 6). */
constexpr std::size_t kChunkBytes = 48000;

constexpr const char* kAlphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Bytes as base64url without padding, as the app channel carries them. */
std::string base64url(protocol::ByteView bytes) {
  std::string out;
  std::uint32_t buffer = 0;
  int bits = 0;
  for (const std::uint8_t byte : bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out.push_back(kAlphabet[(buffer >> bits) & 0x3F]);
    }
  }
  if (bits > 0) {
    out.push_back(kAlphabet[(buffer << (6 - bits)) & 0x3F]);
  }
  return out;
}

Bytes from_base64url(const std::string& text) {
  Bytes out;
  std::uint32_t buffer = 0;
  int bits = 0;
  for (const char c : text) {
    const char* found = std::char_traits<char>::find(kAlphabet, 64, c);
    if (found == nullptr) {
      throw SimulationError("not base64url: a character outside its alphabet");
    }
    buffer = (buffer << 6) | static_cast<std::uint32_t>(found - kAlphabet);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back(static_cast<std::uint8_t>((buffer >> bits) & 0xFF));
    }
  }
  return out;
}

/**
 * The lockstep hub's made keys (hub/src/shell/lockstep/files.ts, `seededKey`): SHA-256 in counter
 * mode over the seed and the name's bytes; block 0 is SHA-256(seed ‖ name ‖ 0 as 8 bytes LE).
 */
protocol::Sha256Digest seeded_block(const Bytes& seed, std::string_view name) {
  Bytes input = seed;
  input.insert(input.end(), name.begin(), name.end());
  input.insert(input.end(), 8, 0);
  return sha256_of(protocol::ByteView(input.data(), input.size()));
}

std::string version_text(const protocol::FirmwareVersion& version) {
  return std::to_string(version.major) + "." + std::to_string(version.minor) + "." +
         std::to_string(version.patch);
}

}  // namespace

Bytes RemoteHub::seed_of_first_run() const {
  // As seed_bytes() in remote_hub.cpp: the seed `start` gives.
  Bytes out(32);
  for (std::size_t i = 0; i < out.size(); ++i) {
    out[i] = static_cast<std::uint8_t>((i % 2 == 0 ? 0x5E : 0xED) ^
                                       ((options_.seed >> (8 * (i % 8))) & 0xFF));
  }
  return out;
}

Bytes RemoteHub::seed() const {
  // A restored database counts its boots from 1 again, so each run after a restore takes a seed
  // of its own: with the first one its random stream would repeat an earlier run's.
  Bytes out = seed_of_first_run();
  out[31] = static_cast<std::uint8_t>(out[31] ^ (restores_ & 0xFF));
  return out;
}

std::string RemoteHub::seeded_backup_key() const {
  // Made once, at the first start, from that run's seed (seedBackupKeys); a restore keeps it.
  const auto key = seeded_block(seed_of_first_run(), "backup");
  return base64url(protocol::ByteView(key.data(), key.size()));
}

Value RemoteHub::operation_reply(const std::string& name, Value body) {
  return command_now(
      Value::object().set("kind", "op").set("op", name).set("body", std::move(body)));
}

Value RemoteHub::operation(const std::string& name, Value body) {
  return op(name, std::move(body));
}

const RemoteImage& RemoteHub::add_own_build(const Bytes& image,
                                            const protocol::FirmwareVersion& version) {
  const std::int64_t job = next_upload_++;
  const auto digest = sha256_of(protocol::ByteView(image.data(), image.size()));
  const std::size_t chunks =
      std::max<std::size_t>(1, (image.size() + kChunkBytes - 1) / kChunkBytes);
  for (std::size_t n = 0; n < chunks; ++n) {
    const std::size_t from = n * kChunkBytes;
    const std::size_t to = std::min(image.size(), from + kChunkBytes);
    Value chunk = Value::object()
                      .set("kind", "fileChunk")
                      .set("job", job)
                      .set("n", static_cast<std::int64_t>(n))
                      .set("data", base64url(protocol::ByteView(image.data() + from, to - from)));
    if (n + 1 == chunks) {
      chunk.set("end", Value::object()
                           .set("chunks", static_cast<std::int64_t>(chunks))
                           .set("sha256", json::to_hex(Bytes(digest.begin(), digest.end()))));
    }
    answer_or_throw(command_now(std::move(chunk)));
  }
  const Value stored =
      op("firmware.upload", Value::object()
                                .set("job", job)
                                .set("own", Value::object().set("version", version_text(version)))
                                .set("confirmOwn", true));
  RemoteImage held;
  held.id = stored.at("id").as_int();
  held.version = version;
  const Bytes id = json::from_hex(stored.at("imageId").as_string());
  if (id.size() != held.image.size()) {
    throw SimulationError("the hub's image id is not 8 bytes");
  }
  std::copy(id.begin(), id.end(), held.image.begin());
  // The header as the hub makes it: its own seeded signing key, deterministic (RFC 6979).
  const auto scalar_block = seeded_block(seed_of_first_run(), "keys");
  SigningScalar scalar{};
  std::copy(scalar_block.begin(), scalar_block.end(), scalar.begin());
  const HubSigningKey key(scalar);
  const protocol::ImageHeader header =
      key.header_for(protocol::ByteView(image.data(), image.size()), true);
  if (protocol::image_id_of(header) != held.image) {
    throw SimulationError("the hub's image id is not the image's");
  }
  held.file = image_file(header, protocol::ByteView(image.data(), image.size()));
  images_.push_back(std::move(held));
  return images_.back();
}

std::int64_t RemoteHub::rollout_start(std::int64_t image, const std::vector<std::string>& devices,
                                      const std::vector<std::string>& pilots) {
  Value body = Value::object().set("image", image);
  if (!devices.empty()) {
    Value list = Value::array();
    for (const std::string& name : devices) {
      list.push(device_number(name));
    }
    body.set("devices", std::move(list));
  }
  if (!pilots.empty()) {
    Value list = Value::array();
    for (const std::string& name : pilots) {
      list.push(device_number(name));
    }
    body.set("pilots", std::move(list));
  }
  rollout_ = op("rollout.start", std::move(body)).at("id").as_int();
  return rollout_;
}

std::int64_t RemoteHub::current_rollout() {
  if (rollout_ == 0) {
    throw SimulationError("no rollout was started");
  }
  return rollout_;
}

Value RemoteHub::rollout_status() {
  return op("rollout.status", Value::object());
}

Value RemoteHub::rollout_pause() {
  return op("rollout.pause", Value::object().set("rollout", current_rollout()));
}

Value RemoteHub::rollout_resume(const std::string& device, bool force) {
  Value body = Value::object().set("rollout", current_rollout());
  if (!device.empty()) {
    body.set("device", device_number(device));
  }
  if (force) {
    body.set("force", true);
  }
  return op("rollout.resume", std::move(body));
}

Value RemoteHub::rollout_cancel() {
  return op("rollout.cancel", Value::object().set("rollout", current_rollout()));
}

Value RemoteHub::update_of(const std::string& name) {
  const std::int64_t number = device_number(name);
  const Value status = rollout_status();
  for (const Value& device : status.at("devices").as_array()) {
    if (device.at("device").as_int() == number) {
      return device;
    }
  }
  return Value();
}

std::string RemoteHub::update_state(const std::string& name) {
  const Value device = update_of(name);
  return device.is_null() ? std::string() : device.at("state").as_string();
}

BluetoothSession RemoteHub::firmware_bluetooth(const std::string& name) {
  const Value reply = op("firmware.bluetooth", Value::object().set("device", device_number(name)));
  BluetoothSession session;
  session.address = static_cast<std::uint32_t>(reply.at("address").as_int() & 0xFFFFFFFF);
  const Bytes key = from_base64url(reply.at("sessionKey").as_string());
  if (key.size() != session.session_key.size()) {
    throw SimulationError("the session key is not 32 bytes");
  }
  std::copy(key.begin(), key.end(), session.session_key.begin());
  session.window_units = static_cast<std::uint8_t>(reply.at("windowS").as_int() / 10);
  const Bytes id = json::from_hex(reply.at("imageId").as_string());
  std::copy_n(id.begin(), std::min(id.size(), session.image.size()), session.image.begin());
  for (const RemoteImage& held : images_) {
    if (held.image == session.image) {
      session.file = held.file;
    }
  }
  if (session.file.empty()) {
    throw SimulationError("firmware.bluetooth names an image this side did not add");
  }
  if (static_cast<std::int64_t>(session.file.size()) != reply.at("fileBytes").as_int()) {
    throw SimulationError("firmware.bluetooth's file length is not the image's");
  }
  return session;
}

void RemoteHub::on_transfer_frame(std::size_t index, const Bytes& frame) {
  HubTransfer transfer;
  transfer.at = sim_.now() + send_delay_;
  transfer.device = boards_[index].name;
  transfer.frame = frame;
  const auto decoded = protocol::decode_transfer(
      protocol::ByteView(frame.data(), frame.size()), [&](const auto& body) {
        using Frame = std::decay_t<decltype(body)>;
        if constexpr (std::is_same_v<Frame, protocol::transfer::Data>) {
          transfer.answer = protocol::transfer_kind::data;
          transfer.offset = body.offset;
          transfer.length = static_cast<std::uint16_t>(body.data.bytes.size());
          if (body.offset == 0) {
            // The header the hub serves: is it the one this side made with the hub's key?
            for (RemoteImage& held : images_) {
              if (held.image == body.image_id && held.file.size() >= 128 &&
                  body.data.bytes.size() >= 128) {
                const bool same =
                    std::equal(held.file.begin(), held.file.begin() + 128, body.data.bytes.begin());
                held.header_matches = held.header_matches.value_or(true) && same;
              }
            }
          }
        } else if constexpr (std::is_same_v<Frame, protocol::transfer::Gone>) {
          transfer.answer = protocol::transfer_kind::gone;
          transfer.gone_reason = body.reason;
        } else {
          transfer.answer = Frame::kind;
        }
      });
  if (decoded != protocol::Error::none) {
    throw SimulationError("the hub sent " + boards_[index].name +
                          " a transfer frame it cannot read");
  }
  transfers_.push_back(std::move(transfer));
}

void RemoteHub::learn_key_change(Board& board, const protocol::OpenedPacket& opened) {
  if (opened.type != protocol::message_type::key_change) {
    return;
  }
  protocol::KeyChange change;
  if (protocol::decode_body(opened.body, change) != protocol::Error::none) {
    return;
  }
  board.next_cipher = std::make_unique<psa::PsaPacketCipher>();
  if (board.next_cipher->set_key(change.new_key) != protocol::Error::none) {
    board.next_cipher.reset();
  }
}

void RemoteHub::learn_from_hub_packet(Board& board, protocol::ByteView packet) {
  Bytes plaintext;
  const auto bound = [&](const protocol::Binding& binding) {
    return open(board, packet, protocol::Direction::from_hub, binding, protocol::PacketLimit::link,
                plaintext);
  };
  if (const auto plain = bound(protocol::Binding::none())) {
    learn_key_change(board, *plain);
    return;
  }
  // To a sensor: bound to one of its latest packets (§4).
  for (auto it = board.recent.rbegin(); it != board.recent.rend(); ++it) {
    if (const auto answer = bound(protocol::Binding::sensor_packet(*it))) {
      learn_key_change(board, *answer);
      return;
    }
  }
}

void RemoteHub::key_seen_from(Board& board, protocol::ByteView packet) {
  // The device's own packet under the new key: it holds it from now (D141), and so does this side.
  if (board.next_cipher == nullptr) {
    return;
  }
  Bytes plaintext(protocol::kMaxLinkPacketSize, 0);
  const auto opened = protocol::open_packet(
      *board.next_cipher, packet, protocol::Direction::to_hub, protocol::Binding::none(),
      protocol::PacketLimit::link, protocol::MutableByteView(plaintext.data(), plaintext.size()));
  if (opened.ok()) {
    board.cipher = std::move(board.next_cipher);
    board.next_cipher.reset();
  }
}

void RemoteHub::firmware_actions(const Value& row, bool received) {
  // hub/src/core/model/bench-actions.ts: a received Update query or status, a sent Update offer,
  // a packet under the old key, with their values as hub_log.hpp names them.
  const std::int64_t type = row.at("type").as_int();
  const std::string device = name_of_id(row.at("deviceId"));
  const Bytes body = json::from_hex(row.at("body").as_string());
  const auto decide = [&](HubAction action, std::int64_t value) {
    decisions_.push_back(HubDecision{sim_.now(), action, device, value});
  };
  if (received) {
    const Value* old_key = row.find("oldKey");
    if (old_key != nullptr && old_key->as_bool()) {
      decide(HubAction::old_key_packet, row.at("counter").as_int());
      return;
    }
    if (type == protocol::message_type::update_query && body.size() > 8) {
      decide(HubAction::firmware_query, body[8]);
    } else if (type == protocol::message_type::update_status && body.size() > 9) {
      decide(HubAction::firmware_status, body[8] * 256 + body[9]);
    }
    return;
  }
  if (type == protocol::message_type::update_offer && !body.empty()) {
    decide(HubAction::firmware_offer, body[0]);
  }
}

std::string RemoteHub::backup_now(const std::string& folder) {
  if (backup_folder_ != folder) {
    std::filesystem::create_directories(folder);
    op("backup.settings", Value::object().set("folder", folder));
    backup_folder_ = folder;
  }
  op("backup.now", Value::object());
  // The job runs in pieces at the instant it began (the lockstep hub takes no time): the file is
  // there now, the newest of this hub's in the folder.
  std::string newest;
  for (const auto& entry : std::filesystem::directory_iterator(folder)) {
    const std::string name = entry.path().filename().string();
    if (name.size() > 5 && name.substr(name.size() - 5) == ".hsnb" &&
        (newest.empty() || name > std::filesystem::path(newest).filename().string())) {
      newest = entry.path().string();
    }
  }
  if (newest.empty()) {
    throw SimulationError("backup.now wrote no file in " + folder + "\n" + dump());
  }
  return newest;
}

Value RemoteHub::bench_restore_reply(const std::string& file, const std::string& key) {
  return command_now(Value::object().set("kind", "benchRestore").set("file", file).set("key", key));
}

void RemoteHub::restore(const std::string& file) {
  answer_or_throw(bench_restore_reply(file, seeded_backup_key()));
  // The restored database goes in at the next start (retryWaitingRestore), as a real hub's after
  // its switch: the controller restarts the hub.
  stop();
  restores_ += 1;
  start();
}

}  // namespace hsn::host
