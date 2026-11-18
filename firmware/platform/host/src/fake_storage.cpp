#include "hsn/host/fake_storage.hpp"

namespace hsn::host {

device::HalResult<std::size_t> FakeStorage::read(device::StoreKey key,
                                                 protocol::MutableByteView out) {
  tick();
  if (fail_reads) {
    return device::HalError::io;
  }
  const auto found = records.find(key);
  if (found == records.end()) {
    return device::HalError::not_found;
  }
  if (found->second.size() > out.size()) {
    return device::HalError::invalid;
  }
  for (std::size_t i = 0; i < found->second.size(); ++i) {
    out[i] = found->second[i];
  }
  return found->second.size();
}

bool FakeStorage::write_fails() {
  if (fail_writes) {
    return true;
  }
  if (fail_next_writes > 0) {
    fail_next_writes -= 1;
    return true;
  }
  return false;
}

bool FakeStorage::powered(FlashOp op, Operation& operation) {
  const FlashFate fate = flash_operation(op);
  if (fate == FlashFate::lost) {
    return false;
  }
  if (fate == FlashFate::interrupted) {
    operation.failed = true;
    operation.interrupted = true;
    operations.push_back(operation);
    return false;
  }
  return true;
}

device::HalError FakeStorage::write(device::StoreKey key, protocol::ByteView value) {
  tick();
  Operation operation;
  operation.at = clock_.now();
  operation.kind = Operation::Kind::write;
  operation.key = key;
  operation.value.assign(value.begin(), value.end());
  if (value.size() > device::kMaxRecordSize) {
    operation.failed = true;
    operations.push_back(operation);
    return device::HalError::invalid;
  }
  if (!powered(FlashOp::record_write, operation)) {
    return device::HalError::io;
  }
  if (write_fails()) {
    operation.failed = true;
    operations.push_back(operation);
    return device::HalError::io;
  }
  records[key] = operation.value;
  operations.push_back(operation);
  return device::HalError::none;
}

device::HalError FakeStorage::erase(device::StoreKey key) {
  tick();
  Operation operation;
  operation.at = clock_.now();
  operation.kind = Operation::Kind::erase;
  operation.key = key;
  if (!powered(FlashOp::record_erase, operation)) {
    return device::HalError::io;
  }
  if (write_fails()) {
    operation.failed = true;
    operations.push_back(operation);
    return device::HalError::io;
  }
  records.erase(key);
  operations.push_back(operation);
  return device::HalError::none;
}

device::HalError FakeStorage::erase_all_but_role() {
  tick();
  Operation operation;
  operation.at = clock_.now();
  operation.kind = Operation::Kind::erase_all_but_role;
  if (!powered(FlashOp::record_erase_all, operation)) {
    return device::HalError::io;
  }
  if (write_fails()) {
    operation.failed = true;
    operations.push_back(operation);
    return device::HalError::io;
  }
  for (auto it = records.begin(); it != records.end();) {
    it = it->first == device::StoreKey::role ? std::next(it) : records.erase(it);
  }
  operations.push_back(operation);
  return device::HalError::none;
}

std::size_t FakeStorage::write_count(device::StoreKey key) const {
  std::size_t count = 0;
  for (const Operation& operation : operations) {
    if (operation.kind == Operation::Kind::write && operation.key == key && !operation.failed) {
      count += 1;
    }
  }
  return count;
}

std::size_t FakeStorage::change_count() const {
  std::size_t count = 0;
  for (const Operation& operation : operations) {
    if (!operation.failed) {
      count += 1;
    }
  }
  return count;
}

}  // namespace hsn::host
