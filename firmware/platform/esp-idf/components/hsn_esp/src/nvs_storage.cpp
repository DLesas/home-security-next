#include "hsn/esp/nvs_storage.hpp"

#include <array>

#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"

namespace hsn::esp {
namespace {

constexpr const char* kTag = "hsn.storage";
constexpr const char* kNamespace = "hsn";

/** "kNN": NVS keys are at most 15 characters. */
std::array<char, 4> key_name(std::uint8_t key) {
  constexpr char kHex[] = "0123456789abcdef";
  return {'k', kHex[key >> 4], kHex[key & 0x0F], '\0'};
}

std::array<char, 4> key_name(device::StoreKey key) {
  return key_name(static_cast<std::uint8_t>(key));
}

}  // namespace

device::HalError NvsStorage::begin() {
  esp_err_t result = nvs_flash_init();
  if (result == ESP_ERR_NVS_NO_FREE_PAGES || result == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    // NVS cannot use the partition as it is: it must be erased to be used at all. This loses every
    // record, which a board in the field should never see; it is logged.
    ESP_LOGW(kTag, "nvs partition erased: %s", esp_err_to_name(result));
    if (nvs_flash_erase() == ESP_OK) {
      result = nvs_flash_init();
    }
  }
  if (result != ESP_OK) {
    ESP_LOGE(kTag, "nvs not started: %s", esp_err_to_name(result));
    return device::HalError::io;
  }
  nvs_handle_t handle = 0;
  result = nvs_open(kNamespace, NVS_READWRITE, &handle);
  if (result != ESP_OK) {
    ESP_LOGE(kTag, "nvs namespace not opened: %s", esp_err_to_name(result));
    return device::HalError::io;
  }
  handle_ = handle;
  open_ = true;
  return device::HalError::none;
}

device::HalResult<std::size_t> NvsStorage::read(device::StoreKey key,
                                                protocol::MutableByteView out) {
  if (!open_) {
    return device::HalError::io;
  }
  const auto name = key_name(key);
  std::size_t length = out.size();
  const esp_err_t result = nvs_get_blob(handle_, name.data(), out.data(), &length);
  if (result == ESP_ERR_NVS_NOT_FOUND) {
    return device::HalError::not_found;
  }
  if (result == ESP_ERR_NVS_INVALID_LENGTH) {
    return device::HalError::invalid;
  }
  if (result != ESP_OK) {
    return device::HalError::io;
  }
  return length;
}

device::HalError NvsStorage::write(device::StoreKey key, protocol::ByteView value) {
  if (value.size() > device::kMaxRecordSize) {
    return device::HalError::invalid;
  }
  if (!open_) {
    return device::HalError::io;
  }
  const auto name = key_name(key);
  if (nvs_set_blob(handle_, name.data(), value.data(), value.size()) != ESP_OK) {
    return device::HalError::io;
  }
  return nvs_commit(handle_) == ESP_OK ? device::HalError::none : device::HalError::io;
}

device::HalError NvsStorage::erase(device::StoreKey key) {
  if (!open_) {
    return device::HalError::io;
  }
  const auto name = key_name(key);
  const esp_err_t result = nvs_erase_key(handle_, name.data());
  if (result != ESP_OK && result != ESP_ERR_NVS_NOT_FOUND) {
    return device::HalError::io;
  }
  return nvs_commit(handle_) == ESP_OK ? device::HalError::none : device::HalError::io;
}

device::HalError NvsStorage::erase_all_but_role() {
  if (!open_) {
    return device::HalError::io;
  }
  // Key by key, so the role is never absent: an erase of the whole namespace followed by writing
  // the role back would lose it to a power cut in between. Every key a StoreKey can name, the
  // role's apart; a key not stored costs a lookup in NVS's RAM index, no flash.
  bool failed = false;
  for (unsigned key = 1; key <= 0xFF; ++key) {
    const auto name = key_name(static_cast<std::uint8_t>(key));
    const esp_err_t result = nvs_erase_key(handle_, name.data());
    if (result != ESP_OK && result != ESP_ERR_NVS_NOT_FOUND) {
      failed = true;
    }
  }
  if (nvs_commit(handle_) != ESP_OK) {
    failed = true;
  }
  return failed ? device::HalError::io : device::HalError::none;
}

}  // namespace hsn::esp
