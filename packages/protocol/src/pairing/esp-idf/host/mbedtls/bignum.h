/* Host stand-in for ESP-IDF's components/mbedtls/port/include/mbedtls/bignum.h: the same
 * include of the private header, without the RSA accelerator's lock functions. */
#pragma once
#include "mbedtls/private/bignum.h"
