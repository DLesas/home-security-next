#!/bin/sh
# Makes pairing's vectors from ESP-IDF's own sources, on this Mac, with nothing downloaded:
#
#   packages/protocol/vectors/pairing-srp.json
#   packages/protocol/vectors/pairing-security2.json
#   packages/protocol/vectors/pairing-board-script.json
#   packages/protocol/vectors/pairing-security2-counter.json
#
# Usage: sh packages/protocol/src/pairing/esp-idf/make-vectors.sh <build directory> [<output directory>]
#
# It builds TF-PSA-Crypto (the crypto half of the Mbed TLS that ESP-IDF vendors, with its
# pre-generated files) for the host, then compiles harness.c and client.c with ESP-IDF's
# protocomm.c, security2.c, esp_srp.c, esp_srp_mpi.c, the generated protobuf-c files and protobuf-c,
# over the stand-in headers in host/, and runs it. ESP-IDF's files are compiled as they are; the
# build directory holds everything made. ESP-IDF is taken from $IDF_PATH, or ~/esp/esp-idf.
set -eu

if [ $# -lt 1 ]; then
  echo "usage: $0 <build directory> [<output directory>]" >&2
  exit 2
fi
HERE=$(cd "$(dirname "$0")" && pwd)
IDF=${IDF_PATH:-$HOME/esp/esp-idf}
BUILD=$1
OUT=${2:-$HERE/../../../vectors}
mkdir -p "$BUILD" "$OUT"
BUILD=$(cd "$BUILD" && pwd)
OUT=$(cd "$OUT" && pwd)

PC=$IDF/components/protocomm
MB=$IDF/components/mbedtls/mbedtls
TF=$MB/tf-psa-crypto
PB=$IDF/components/protobuf-c/protobuf-c

VERSION=$(git -C "$IDF" describe --tags --exact-match)
COMMIT=$(git -C "$IDF" rev-parse HEAD)
MB_COMMIT=$(git -C "$MB" rev-parse HEAD)
PB_COMMIT=$(git -C "$PB" rev-parse HEAD)

# 1. TF-PSA-Crypto for the host. ESP-IDF's copy includes "mbedtls/bignum.h", which ESP-IDF's
#    port supplies; host/mbedtls/ stands in for it.
cmake -S "$TF" -B "$BUILD/tfpsa" -G "Unix Makefiles" -DGEN_FILES=OFF -DENABLE_TESTING=OFF \
  -DENABLE_PROGRAMS=OFF -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_FLAGS="-I$HERE/host" >/dev/null
cmake --build "$BUILD/tfpsa" -j 8 >/dev/null

# 2. ESP-IDF's published test salt and verifier, copied from its own test file.
{
  echo "/* Copied by make-vectors.sh from $PC/test_apps/main/test_srp.c. */"
  awk '/^static const char sec2_salt\[\] = \{/,/^\};/' "$PC/test_apps/main/test_srp.c" |
    sed 's/sec2_salt/PUBLISHED_SALT/'
  awk '/^static const char sec2_verifier\[\] = \{/,/^\};/' "$PC/test_apps/main/test_srp.c" |
    sed 's/sec2_verifier/PUBLISHED_VERIFIER/'
} >"$BUILD/published.h"

# 3. The harness, with ESP-IDF's sources.
cc -std=gnu11 -O1 -w -DCONFIG_ESP_PROTOCOMM_SUPPORT_SECURITY_VERSION_2=1 \
  -I"$HERE/host" -I"$HERE" -I"$BUILD" \
  -I"$PC/include/common" -I"$PC/include/security" -I"$PC/include/crypto/srp6a" \
  -I"$PC/src/common" -I"$PC/src/security" -I"$PC/src/crypto/srp6a" -I"$PC/proto-c" -I"$PB" \
  -I"$TF/include" -I"$TF/drivers/builtin/include" -I"$MB/include" \
  "$HERE/harness.c" "$HERE/client.c" "$PC/src/crypto/srp6a/esp_srp_mpi.c" \
  "$PC/src/common/protocomm.c" "$PC"/proto-c/*.pb-c.c "$PB/protobuf-c/protobuf-c.c" \
  "$BUILD/tfpsa/core/libtfpsacrypto.a" "$BUILD/tfpsa/drivers/builtin/libbuiltin.a" \
  "$BUILD/tfpsa/drivers/everest/libeverest.a" "$BUILD/tfpsa/drivers/p256-m/libp256-m.a" \
  "$BUILD/tfpsa/drivers/pqcp/libpqcp.a" "$BUILD/tfpsa/platform/libplatform.a" \
  "$BUILD/tfpsa/utilities/libutilities.a" "$BUILD/tfpsa/core/libtfpsacrypto.a" \
  -o "$BUILD/harness"

# 4. Run it.
"$BUILD/harness" "$OUT" "$VERSION" "$COMMIT" "$MB_COMMIT" "$PB_COMMIT"
