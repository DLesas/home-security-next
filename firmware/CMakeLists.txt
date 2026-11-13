# Host build of the firmware libraries and their tests. The ESP-IDF build will wrap the same
# libraries (core/ and platform/psa/) as components.
cmake_minimum_required(VERSION 3.28)
project(hsn_firmware LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(HSN_SANITIZE "Build our code and tests with AddressSanitizer and UndefinedBehaviorSanitizer" OFF)

include(cmake/options.cmake)
include(cmake/dependencies.cmake)

add_subdirectory(core)
add_subdirectory(platform/psa)
add_subdirectory(roles)
add_subdirectory(platform/host)
add_subdirectory(tools/bench)

enable_testing()
add_subdirectory(tests)
