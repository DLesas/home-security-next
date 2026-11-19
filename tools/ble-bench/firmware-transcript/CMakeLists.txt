# The firmware's side of tools/ble-bench/test/firmware-compare.test.ts (see transcript.cpp). It
# builds the firmware's host libraries from firmware/ as they are, out of tree, and one program on
# them. The fetched dependencies are taken from an existing firmware build's _deps folder, so
# nothing is downloaded: tools/ble-bench/README.md, "Comparing with the firmware".
cmake_minimum_required(VERSION 3.28)
project(ble_bench_transcript LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_subdirectory(${CMAKE_CURRENT_LIST_DIR}/../../../firmware firmware EXCLUDE_FROM_ALL)

add_executable(ble_bench_transcript transcript.cpp)
target_link_libraries(ble_bench_transcript PRIVATE hsn_host hsn_role_sensor)
target_compile_options(ble_bench_transcript PRIVATE -fno-rtti)
