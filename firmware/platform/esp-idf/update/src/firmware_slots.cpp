#include "hsn/esp/firmware_slots.hpp"

#include <array>
#include <cstring>

#include "bootloader_common.h"
#include "esp_app_desc.h"
#include "esp_flash_partitions.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "hsn/device/services/update.hpp"
#include "nvs.h"
#include "psa/crypto.h"

namespace hsn::esp {
namespace {

constexpr const char* kTag = "hsn.slots";
/** The two otadata copies sit one flash sector apart (m3-updates-design.md section 2: 2 × 4 KB). */
constexpr std::size_t kOtadataCopy = 0x1000;

const esp_partition_t* part(const void* handle) {
  return static_cast<const esp_partition_t*>(handle);
}

/** The slot an otadata sequence number selects: (seq − 1) mod 2, as the bootloader reads it. */
int slot_of(std::uint32_t sequence) {
  return static_cast<int>((sequence - 1) % 2);
}

int slot_index(const esp_partition_t* partition) {
  return partition->subtype == ESP_PARTITION_SUBTYPE_APP_OTA_0 ? 0 : 1;
}

using HeaderBytes = std::array<std::uint8_t, protocol::kImageHeaderSize>;

/** Each slot's selected header stays available after UpdateService clears its staging record. */
const char* header_key(const esp_partition_t* partition) {
  return slot_index(partition) == 0 ? "ota0-header" : "ota1-header";
}

/** Reads an NVS blob without creating a namespace or modifying flash. */
esp_err_t read_blob(const char* space, const char* key, protocol::MutableByteView bytes,
                    std::size_t& size) {
  nvs_handle_t handle = 0;
  const esp_err_t opened = nvs_open(space, NVS_READONLY, &handle);
  if (opened != ESP_OK) {
    return opened;
  }
  size = bytes.size();
  const esp_err_t result = nvs_get_blob(handle, key, bytes.data(), &size);
  nvs_close(handle);
  return result;
}

/** Reads the verified update record's header from the platform's StoreKey::update blob. */
std::optional<HeaderBytes> staged_header() {
  static_assert(static_cast<std::uint8_t>(device::StoreKey::update) == 0x05);
  std::array<std::uint8_t, device::kMaxRecordSize> bytes{};
  std::size_t size = 0;
  if (read_blob("hsn", "k05", protocol::MutableByteView(bytes), size) != ESP_OK ||
      size < sizeof(device::UpdateRecord) + 1 || bytes[0] != device::kUpdateRecordVersion) {
    return std::nullopt;
  }
  device::UpdateRecord record;
  std::memcpy(&record, bytes.data() + 1, sizeof(record));
  if (record.stage != static_cast<std::uint8_t>(device::UpdateRecordStage::verified)) {
    return std::nullopt;
  }
  return record.header;
}

/** Keeps the selected header in a slot-specific record, outside the pairing namespace. */
void remember_header(const esp_partition_t* partition, const HeaderBytes& header) {
  nvs_handle_t handle = 0;
  esp_err_t result = nvs_open("hsn-ota", NVS_READWRITE, &handle);
  if (result == ESP_OK) {
    result = nvs_set_blob(handle, header_key(partition), header.data(), header.size());
    if (result == ESP_OK) {
      result = nvs_commit(handle);
    }
    nvs_close(handle);
  }
  if (result != ESP_OK) {
    ESP_LOGW(kTag, "could not keep selected image header: %s", esp_err_to_name(result));
  }
}

/** Proves the saved header identifies the actual slot, even after a cable flash or torn write. */
std::optional<protocol::ImageId> matching_id(const esp_partition_t* partition,
                                             const HeaderBytes& bytes) {
  protocol::ImageHeader header;
  if (protocol::decode_image_header(protocol::ByteView(bytes), header) != protocol::Error::none ||
      header.image_bytes == 0 || header.image_bytes > partition->size ||
      psa_crypto_init() != PSA_SUCCESS) {
    return std::nullopt;
  }
  const void* image = nullptr;
  esp_partition_mmap_handle_t mapping = 0;
  if (esp_partition_mmap(partition, 0, header.image_bytes, ESP_PARTITION_MMAP_DATA, &image,
                         &mapping) != ESP_OK) {
    return std::nullopt;
  }
  protocol::Sha256Digest digest{};
  std::size_t length = 0;
  const psa_status_t result =
      psa_hash_compute(PSA_ALG_SHA_256, static_cast<const std::uint8_t*>(image), header.image_bytes,
                       digest.data(), digest.size(), &length);
  esp_partition_munmap(mapping);
  if (result != PSA_SUCCESS || length != digest.size() || digest != header.image_sha256) {
    return std::nullopt;
  }
  return protocol::image_id_of(header);
}

/** Reports an installed slot's identity only when a retained header and the payload agree. */
std::optional<protocol::ImageId> selected_id(const esp_partition_t* partition) {
  HeaderBytes header{};
  std::size_t size = 0;
  if (read_blob("hsn-ota", header_key(partition), protocol::MutableByteView(header), size) !=
          ESP_OK ||
      size != header.size()) {
    return std::nullopt;
  }
  return matching_id(partition, header);
}

protocol::FirmwareVersion version_of(const esp_partition_t* partition) {
  esp_app_desc_t description{};
  protocol::FirmwareVersion version;
  if (esp_ota_get_partition_description(partition, &description) != ESP_OK ||
      !parse_version(description.version, sizeof(description.version), version)) {
    return protocol::FirmwareVersion{};
  }
  return version;
}

}  // namespace

bool EspFirmwareSlots::begin() {
  running_ = esp_ota_get_running_partition();
  other_ = running_ != nullptr ? esp_ota_get_next_update_partition(part(running_)) : nullptr;
  if (other_ == nullptr) {
    ESP_LOGE(kTag, "no other application slot: is the partition table the board's?");
  }
  return running_ != nullptr && other_ != nullptr;
}

device::BootImage EspFirmwareSlots::running() {
  device::BootImage image;
  const esp_app_desc_t* app = esp_app_get_description();
  if (!parse_version(app->version, sizeof(app->version), image.version)) {
    image.version = protocol::FirmwareVersion{};
  }
  if (running_ == nullptr) {
    return image;
  }
  esp_ota_img_states_t state = ESP_OTA_IMG_UNDEFINED;
  if (esp_ota_get_state_partition(part(running_), &state) == ESP_OK) {
    image.on_trial = state == ESP_OTA_IMG_PENDING_VERIFY;
  }
  image.id = selected_id(part(running_));
  if (image.on_trial && !image.id.has_value()) {
    // The selector may have landed just before power failed, before its header copy did.
    const auto header = staged_header();
    if (header.has_value()) {
      image.id = matching_id(part(running_), *header);
      if (image.id.has_value()) {
        remember_header(part(running_), *header);
      }
    }
  }
  // The newest intact otadata entry, whatever its state.
  const esp_partition_t* otadata =
      esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_OTA, nullptr);
  if (otadata == nullptr || other_ == nullptr) {
    return image;
  }
  std::array<esp_ota_select_entry_t, 2> entries{};
  int newest = -1;
  for (std::size_t i = 0; i < entries.size(); ++i) {
    if (esp_partition_read(otadata, i * kOtadataCopy, &entries[i], sizeof(entries[i])) != ESP_OK) {
      continue;
    }
    const esp_ota_select_entry_t& entry = entries[i];
    const bool intact =
        entry.ota_seq != UINT32_MAX && entry.crc == bootloader_common_ota_select_crc(&entry);
    if (intact &&
        (newest < 0 || entry.ota_seq > entries[static_cast<std::size_t>(newest)].ota_seq)) {
      newest = static_cast<int>(i);
    }
  }
  if (newest < 0) {
    return image;  // blank otadata: the first serial flash, ota_0
  }
  const esp_ota_select_entry_t& last = entries[static_cast<std::size_t>(newest)];
  const bool abandoned =
      last.ota_state == ESP_OTA_IMG_INVALID || last.ota_state == ESP_OTA_IMG_ABORTED;
  if (abandoned && slot_of(last.ota_seq) != slot_index(part(running_))) {
    image.rolled_back = true;
    image.failed = version_of(part(other_));
    image.failed_id = selected_id(part(other_));
  }
  return image;
}

std::uint32_t EspFirmwareSlots::capacity() {
  return other_ != nullptr ? static_cast<std::uint32_t>(part(other_)->size) : 0;
}

device::HalError EspFirmwareSlots::erase(std::uint32_t offset) {
  if (other_ == nullptr || offset % device::kSlotSectorSize != 0 || offset >= capacity()) {
    return device::HalError::invalid;
  }
  return esp_partition_erase_range(part(other_), offset, device::kSlotSectorSize) == ESP_OK
             ? device::HalError::none
             : device::HalError::io;
}

device::HalError EspFirmwareSlots::write(std::uint32_t offset, protocol::ByteView bytes) {
  if (other_ == nullptr || bytes.size() > device::kSlotSectorSize || offset > capacity() ||
      bytes.size() > capacity() - offset) {
    return device::HalError::invalid;
  }
  return esp_partition_write(part(other_), offset, bytes.data(), bytes.size()) == ESP_OK
             ? device::HalError::none
             : device::HalError::io;
}

device::HalError EspFirmwareSlots::read(std::uint32_t offset, protocol::MutableByteView out) {
  if (other_ == nullptr || out.size() > device::kSlotSectorSize || offset > capacity() ||
      out.size() > capacity() - offset) {
    for (std::uint8_t& byte : out) {
      byte = 0;
    }
    return device::HalError::invalid;
  }
  return esp_partition_read(part(other_), offset, out.data(), out.size()) == ESP_OK
             ? device::HalError::none
             : device::HalError::io;
}

device::HalError EspFirmwareSlots::select() {
  if (other_ == nullptr) {
    return device::HalError::invalid;
  }
  const esp_err_t result = esp_ota_set_boot_partition(part(other_));
  if (result == ESP_OK) {
    if (const auto header = staged_header(); header.has_value()) {
      remember_header(part(other_), *header);
    }
  }
  if (result == ESP_ERR_OTA_VALIDATE_FAILED) {
    return device::HalError::invalid;
  }
  return result == ESP_OK ? device::HalError::none : device::HalError::io;
}

device::HalError EspFirmwareSlots::confirm() {
  // As the fake does (fake_update.cpp): with nothing on trial, confirming changes nothing. ESP-IDF
  // would otherwise refuse a board still as first flashed, with otadata blank ("Running firmware
  // is factory", esp_ota_ops.c), and rewrite otadata for an image already valid.
  esp_ota_img_states_t state = ESP_OTA_IMG_UNDEFINED;
  if (running_ == nullptr || esp_ota_get_state_partition(part(running_), &state) != ESP_OK ||
      state != ESP_OTA_IMG_PENDING_VERIFY) {
    return device::HalError::none;
  }
  return esp_ota_mark_app_valid_cancel_rollback() == ESP_OK ? device::HalError::none
                                                            : device::HalError::io;
}

device::HalError EspFirmwareSlots::reject() {
  const esp_err_t result = esp_ota_mark_app_invalid_rollback();
  // No working image to go back to: none in the other slot, or otadata blank (ESP_FAIL, "factory").
  if (result == ESP_ERR_OTA_ROLLBACK_FAILED || result == ESP_FAIL) {
    return device::HalError::invalid;
  }
  return result == ESP_OK ? device::HalError::none : device::HalError::io;
}

}  // namespace hsn::esp
