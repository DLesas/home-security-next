# Fetched dependencies, each pinned by an exact archive and its SHA-256.
include(FetchContent)

# TF-PSA-Crypto 1.1.0, the PSA Crypto library that Mbed TLS 4.1.0 bundles (its tf-psa-crypto
# submodule at commit 29160dd877d29658279fd683b2ae57b320ddcf09, tag v1.1.0) and so the one
# ESP-IDF v6.1 ships. The release archive of that tag is used rather than a git checkout because
# it carries the generated sources; generating them from git needs Python packages (jinja2,
# jsonschema) that this machine does not have. Only the library is built.
set(ENABLE_PROGRAMS OFF CACHE BOOL "TF-PSA-Crypto: build no programs" FORCE)
set(ENABLE_TESTING OFF CACHE BOOL "TF-PSA-Crypto: build no tests" FORCE)
set(GEN_FILES OFF CACHE BOOL "TF-PSA-Crypto: use the release's generated files" FORCE)
set(TF_PSA_CRYPTO_FATAL_WARNINGS OFF CACHE BOOL "TF-PSA-Crypto: warnings are not ours to fix" FORCE)
set(USE_SHARED_TF_PSA_CRYPTO_LIBRARY OFF CACHE BOOL "TF-PSA-Crypto: static only" FORCE)
FetchContent_Declare(tfpsacrypto
  URL https://github.com/Mbed-TLS/TF-PSA-Crypto/releases/download/tf-psa-crypto-1.1.0/tf-psa-crypto-1.1.0.tar.bz2
  URL_HASH SHA256=a0b011b7f2c427cc8ee70116bb2d859543014534ae4d7020a69613aec10dc1b4
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE
  EXCLUDE_FROM_ALL)

# doctest 2.5.3, commit 2d0a9359a60c51affe2a9bebb1be1dca47868151. Header only: SOURCE_SUBDIR points
# at a folder without a CMakeLists.txt, so its own build is not configured.
FetchContent_Declare(doctest
  URL https://github.com/doctest/doctest/archive/2d0a9359a60c51affe2a9bebb1be1dca47868151.tar.gz
  URL_HASH SHA256=e64542c4ea68e9f381ccf6eae924cfdd652567c87c142d76fe92644fb4608149
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE
  SOURCE_SUBDIR header-only)

# nlohmann/json 3.12.0 (commit 55f93686c01528224f448c19128836e7df245f72), tests only. Header only.
FetchContent_Declare(nlohmann_json
  URL https://github.com/nlohmann/json/releases/download/v3.12.0/json.tar.xz
  URL_HASH SHA256=42f6e95cad6ec532fd372391373363b62a14af6d771056dbfc86160e6dfff7aa
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE
  SOURCE_SUBDIR header-only)

FetchContent_MakeAvailable(tfpsacrypto doctest nlohmann_json)

add_library(hsn_doctest INTERFACE)
target_include_directories(hsn_doctest SYSTEM INTERFACE ${doctest_SOURCE_DIR})

add_library(hsn_json INTERFACE)
target_include_directories(hsn_json SYSTEM INTERFACE ${nlohmann_json_SOURCE_DIR}/include)
