#include "hsn/host/test_image.hpp"

#include <algorithm>
#include <string>

#include "hsn/host/simulation_error.hpp"
#include "hsn/psa/hub_identity.hpp"

namespace hsn::host {
namespace {

constexpr std::size_t kHeaderSize = 24;
constexpr std::size_t kSegmentHeaderSize = 8;
constexpr std::size_t kAppDescSize = 256;
constexpr std::size_t kHashSize = 32;
constexpr std::uint8_t kChecksumSeed = 0xEF;
constexpr std::size_t kMaxSegments = 16;

void put_u16(Bytes& out, std::size_t at, std::uint16_t value) {
  out[at] = static_cast<std::uint8_t>(value & 0xFFu);
  out[at + 1] = static_cast<std::uint8_t>(value >> 8);
}

void put_u32(Bytes& out, std::size_t at, std::uint32_t value) {
  for (std::size_t i = 0; i < 4; ++i) {
    out[at + i] = static_cast<std::uint8_t>((value >> (8 * i)) & 0xFFu);
  }
}

std::uint32_t get_u32(protocol::ByteView in, std::size_t at) {
  std::uint32_t value = 0;
  for (std::size_t i = 0; i < 4; ++i) {
    value |= static_cast<std::uint32_t>(in[at + i]) << (8 * i);
  }
  return value;
}

void put_text(Bytes& out, std::size_t at, std::size_t room, const std::string& text) {
  std::copy_n(text.begin(), std::min(text.size(), room - 1), out.data() + at);
}

std::string version_text(const protocol::FirmwareVersion& version) {
  return std::to_string(version.major) + "." + std::to_string(version.minor) + "." +
         std::to_string(version.patch);
}

/** Parses "M.m.p" (each 0–255) from a NUL-padded field; false otherwise. */
bool parse_version(protocol::ByteView field, protocol::FirmwareVersion& out) {
  std::array<int, 3> parts{-1, -1, -1};
  std::size_t part = 0;
  std::size_t i = 0;
  for (; i < field.size() && field[i] != 0; ++i) {
    const std::uint8_t c = field[i];
    if (c == '.') {
      if (parts[part] < 0 || part == 2) {
        return false;
      }
      part += 1;
      continue;
    }
    if (c < '0' || c > '9') {
      return false;
    }
    parts[part] = std::max(parts[part], 0) * 10 + (c - '0');
    if (parts[part] > 255) {
      return false;
    }
  }
  if (part != 2 || parts[2] < 0 || i == field.size()) {
    return false;
  }
  out.major = static_cast<std::uint8_t>(parts[0]);
  out.minor = static_cast<std::uint8_t>(parts[1]);
  out.patch = static_cast<std::uint8_t>(parts[2]);
  return true;
}

void require_psa() {
  if (psa_crypto_init() != PSA_SUCCESS) {
    throw SimulationError("PSA Crypto did not start");
  }
}

}  // namespace

const SigningScalar kRfc6979TestKey{
    0xc9, 0xaf, 0xa9, 0xd8, 0x45, 0xba, 0x75, 0x16, 0x6b, 0x5c, 0x21, 0x57, 0x67, 0xb1, 0xd6, 0x93,
    0x4e, 0x50, 0xc3, 0xdb, 0x36, 0xe8, 0x9b, 0x12, 0x7b, 0x8a, 0x62, 0x2b, 0x12, 0x0f, 0x67, 0x21};

protocol::Sha256Digest sha256_of(protocol::ByteView bytes) {
  require_psa();
  protocol::Sha256Digest digest{};
  std::size_t length = 0;
  if (psa_hash_compute(PSA_ALG_SHA_256, bytes.data(), bytes.size(), digest.data(), digest.size(),
                       &length) != PSA_SUCCESS ||
      length != digest.size()) {
    throw SimulationError("PSA could not hash");
  }
  return digest;
}

Bytes make_test_image(const TestImageSpec& spec) {
  // Segment data: the app description, then filler, a multiple of 4 bytes.
  const std::size_t fixed = kHeaderSize + kSegmentHeaderSize + 1 + kHashSize;
  std::size_t data = spec.size > fixed + kAppDescSize ? spec.size - fixed : kAppDescSize;
  data = (data + 3) / 4 * 4;
  Bytes image(kHeaderSize + kSegmentHeaderSize + data, 0);
  image[0] = kEspImageMagic;
  image[1] = 1;     // one segment
  image[2] = 2;     // SPI mode DIO
  image[3] = 0x3F;  // 8 MB, 80 MHz
  put_u32(image, 4, 0x40375000u);
  image[8] = 0xEE;  // no write-protect pin
  put_u16(image, 12, spec.chip_id);
  put_u16(image, 17, 99);  // max_chip_rev_full
  image[23] = 1;           // hash appended
  put_u32(image, kHeaderSize, 0x3C000020u);
  put_u32(image, kHeaderSize + 4, static_cast<std::uint32_t>(data));
  const std::size_t desc = kHeaderSize + kSegmentHeaderSize;
  put_u32(image, desc, kEspAppDescMagic);
  put_text(image, desc + 16, 32, version_text(spec.version));
  put_text(image, desc + 48, 32, "hsn-bench");
  put_text(image, desc + 80, 16, "00:00:00");
  put_text(image, desc + 96, 16, "Nov 18 2026");
  put_text(image, desc + 112, 32, "v6.1.1");
  std::uint32_t state = spec.seed * 2654435761u + 1u;
  for (std::size_t i = desc + kAppDescSize; i < image.size(); ++i) {
    state = state * 1664525u + 1013904223u;
    image[i] = static_cast<std::uint8_t>(state >> 24);
  }
  std::uint8_t checksum = kChecksumSeed;
  for (std::size_t i = desc; i < image.size(); ++i) {
    checksum ^= image[i];
  }
  while ((image.size() + 1) % 16 != 0) {
    image.push_back(0);
  }
  image.push_back(checksum);
  const protocol::Sha256Digest hash = sha256_of(protocol::ByteView(image.data(), image.size()));
  image.insert(image.end(), hash.begin(), hash.end());
  return image;
}

Bytes make_test_image(const protocol::FirmwareVersion& version, std::size_t size,
                      std::uint32_t seed) {
  TestImageSpec spec;
  spec.version = version;
  spec.size = size;
  spec.seed = seed;
  return make_test_image(spec);
}

std::optional<protocol::FirmwareVersion> version_in_image(protocol::ByteView image) {
  constexpr std::size_t desc = kHeaderSize + kSegmentHeaderSize;
  protocol::FirmwareVersion version;
  if (image.size() < desc + kAppDescSize || image[0] != kEspImageMagic ||
      get_u32(image, desc) != kEspAppDescMagic ||
      !parse_version(image.subspan(desc + 16, 32), version)) {
    return std::nullopt;
  }
  return version;
}

ImageCheck check_test_image(protocol::ByteView slot) {
  ImageCheck result;
  if (slot.size() < kHeaderSize || slot[0] != kEspImageMagic) {
    return result;
  }
  const std::uint16_t chip =
      static_cast<std::uint16_t>(slot[12] | (static_cast<std::uint16_t>(slot[13]) << 8));
  const std::size_t segments = slot[1];
  if (chip != kEspChipIdEsp32s3 || segments < 1 || segments > kMaxSegments) {
    return result;
  }
  std::size_t at = kHeaderSize;
  std::uint8_t checksum = kChecksumSeed;
  std::size_t first_data = 0;
  std::size_t first_length = 0;
  for (std::size_t s = 0; s < segments; ++s) {
    if (at + kSegmentHeaderSize > slot.size()) {
      return result;
    }
    const std::size_t length = get_u32(slot, at + 4);
    at += kSegmentHeaderSize;
    if (length > slot.size() - at) {
      return result;
    }
    if (s == 0) {
      first_data = at;
      first_length = length;
    }
    for (std::size_t i = 0; i < length; ++i) {
      checksum ^= slot[at + i];
    }
    at += length;
  }
  while ((at + 1) % 16 != 0) {
    at += 1;
  }
  if (at >= slot.size() || slot[at] != checksum) {
    return result;
  }
  at += 1;
  if (slot[23] == 1) {
    if (slot.size() - at < kHashSize) {
      return result;
    }
    const protocol::Sha256Digest hash = sha256_of(slot.first(at));
    if (!std::equal(hash.begin(), hash.end(), slot.begin() + static_cast<std::ptrdiff_t>(at))) {
      return result;
    }
    at += kHashSize;
  }
  if (first_length < kAppDescSize || get_u32(slot, first_data) != kEspAppDescMagic ||
      !parse_version(slot.subspan(first_data + 16, 32), result.version)) {
    result.version = protocol::FirmwareVersion{};
    return result;
  }
  result.ok = true;
  result.bytes = at;
  return result;
}

HubSigningKey::HubSigningKey(const SigningScalar& scalar) {
  require_psa();
  psa_key_attributes_t attributes = PSA_KEY_ATTRIBUTES_INIT;
  psa_set_key_type(&attributes, PSA_KEY_TYPE_ECC_KEY_PAIR(PSA_ECC_FAMILY_SECP_R1));
  psa_set_key_bits(&attributes, 256);
  psa_set_key_algorithm(&attributes, PSA_ALG_DETERMINISTIC_ECDSA(PSA_ALG_SHA_256));
  psa_set_key_usage_flags(&attributes, PSA_KEY_USAGE_SIGN_HASH);
  const psa_status_t status = psa_import_key(&attributes, scalar.data(), scalar.size(), &key_);
  psa_reset_key_attributes(&attributes);
  if (status != PSA_SUCCESS) {
    key_ = PSA_KEY_ID_NULL;
    throw SimulationError("PSA refused the hub's signing key");
  }
  std::array<std::uint8_t, 65> exported{};
  std::size_t length = 0;
  if (psa_export_public_key(key_, exported.data(), exported.size(), &length) != PSA_SUCCESS ||
      length != exported.size() || exported[0] != 0x04) {
    throw SimulationError("PSA could not give the hub's public key");
  }
  std::copy(exported.begin() + 1, exported.end(), public_.begin());
  if (psa::compute_hub_identity(public_, identity_) != protocol::Error::none) {
    throw SimulationError("PSA could not compute the hub identity");
  }
}

HubSigningKey::~HubSigningKey() {
  if (key_ != PSA_KEY_ID_NULL) {
    static_cast<void>(psa_destroy_key(key_));
  }
}

protocol::ImageSignature HubSigningKey::sign_digest(const protocol::Sha256Digest& digest) const {
  protocol::ImageSignature signature{};
  std::size_t length = 0;
  if (psa_sign_hash(key_, PSA_ALG_DETERMINISTIC_ECDSA(PSA_ALG_SHA_256), digest.data(),
                    digest.size(), signature.data(), signature.size(), &length) != PSA_SUCCESS ||
      length != signature.size()) {
    throw SimulationError("PSA could not sign");
  }
  return signature;
}

protocol::Sha256Digest HubSigningKey::signed_digest(const protocol::ImageHeader& header) {
  const Bytes bytes = header_bytes(header);
  Bytes message(protocol::kImageSignatureLabel.begin(), protocol::kImageSignatureLabel.end());
  message.insert(message.end(), bytes.begin(),
                 bytes.begin() + static_cast<std::ptrdiff_t>(protocol::kImageHeaderSignedSize));
  return sha256_of(protocol::ByteView(message.data(), message.size()));
}

void HubSigningKey::sign(protocol::ImageHeader& header) const {
  header.signature = sign_digest(signed_digest(header));
}

protocol::ImageHeader HubSigningKey::header_for(protocol::ByteView image, bool own_build) const {
  protocol::ImageHeader header;
  header.flags.own_build = own_build;
  header.roles = static_cast<std::uint8_t>(protocol::image_role_bit(protocol::Role::sensor) |
                                           protocol::image_role_bit(protocol::Role::siren) |
                                           protocol::image_role_bit(protocol::Role::gateway));
  header.target = protocol::kImageTargetEsp32s3;
  header.version = check_test_image(image).version;
  header.image_bytes = static_cast<std::uint32_t>(image.size());
  header.image_sha256 = sha256_of(image);
  header.hub_identity = identity_;
  sign(header);
  return header;
}

Bytes header_bytes(const protocol::ImageHeader& header) {
  Bytes bytes(protocol::kImageHeaderSize);
  const auto size =
      protocol::encode_image_header(header, protocol::MutableByteView(bytes.data(), bytes.size()));
  if (!size.ok() || size.value() != protocol::kImageHeaderSize) {
    throw SimulationError("an image header did not encode");
  }
  return bytes;
}

Bytes image_file(const protocol::ImageHeader& header, protocol::ByteView image) {
  Bytes file = header_bytes(header);
  file.insert(file.end(), image.begin(), image.end());
  return file;
}

}  // namespace hsn::host
