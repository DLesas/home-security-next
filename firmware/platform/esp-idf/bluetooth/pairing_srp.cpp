#include "pairing_srp.hpp"

#include <cstdlib>

#include "esp_srp.h"

namespace {
thread_local int* salt_size = nullptr;
}

struct mbedtls_mpi;
extern "C" char* __real_esp_mpi_to_bin(mbedtls_mpi* mpi, int* length);

/** Captures the actual first MPI output length omitted by esp_srp_gen_salt_verifier. */
extern "C" char* __wrap_esp_mpi_to_bin(mbedtls_mpi* mpi, int* length) {
  char* out = __real_esp_mpi_to_bin(mpi, length);
  if (salt_size != nullptr) {
    *salt_size = *length;
    salt_size = nullptr;
  }
  return out;
}

namespace hsn::esp {

bool make_credentials(const PairCode& code, protocomm_security2_params_t& credentials) {
  return draw_salt([&] {
    char* salt = nullptr;
    char* verifier = nullptr;
    int verifier_size = 0;
    int actual_salt_size = -1;
    // v6.1.1 converts the salt first and calculates the verifier over that exact byte count.
    salt_size = &actual_salt_size;
    const esp_err_t result = esp_srp_gen_salt_verifier("hsn", 3, code.data(), 8, &salt, kSaltBytes,
                                                       &verifier, &verifier_size);
    salt_size = nullptr;
    if (result == ESP_OK && usable_salt(salt, actual_salt_size) && verifier_size > 0 &&
        verifier_size <= 384) {
      credentials = {salt, kSaltBytes, verifier, static_cast<std::uint16_t>(verifier_size)};
      return 1;
    }
    const bool truncated = result == ESP_OK && actual_salt_size >= 0 &&
                           actual_salt_size <= kSaltBytes && !usable_salt(salt, actual_salt_size);
    std::free(salt);
    std::free(verifier);
    return truncated ? 0 : -1;
  });
}

void free_credentials(protocomm_security2_params_t& credentials) {
  std::free(const_cast<char*>(credentials.salt));
  std::free(const_cast<char*>(credentials.verifier));
  credentials = {};
}

}  // namespace hsn::esp
