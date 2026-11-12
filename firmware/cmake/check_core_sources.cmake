# Fails when a core source includes a header outside the allowed list or uses a forbidden
# construct (heap, exceptions, RTTI, floating point, allocating standard types).
# Usage: cmake -DSOURCE_DIR=<firmware/core> -P check_core_sources.cmake

# A -P script gets old policies unless it declares its own: quoted arguments are then expanded
# twice and IN_LIST is unknown. Every if() below also quotes the values it tests.
cmake_minimum_required(VERSION 3.28)

if("${SOURCE_DIR}" STREQUAL "")
  message(FATAL_ERROR "SOURCE_DIR is required")
endif()

set(allowed_system_headers array cstddef cstdint cstring limits optional tuple type_traits utility)
set(word_start "(^|[^A-Za-z0-9_])")
set(word_end "([^A-Za-z0-9_]|$)")
set(forbidden_words
  float double new delete malloc calloc realloc free throw try catch typeid dynamic_cast goto)
set(forbidden_std vector string function map unordered_map set list deque shared_ptr unique_ptr
  ostream istream cout cerr)

file(GLOB_RECURSE sources "${SOURCE_DIR}/*.hpp" "${SOURCE_DIR}/*.cpp")
list(LENGTH sources source_count)
if("${source_count}" EQUAL 0)
  message(FATAL_ERROR "no sources under ${SOURCE_DIR}")
endif()

set(problems "")
foreach(source IN LISTS sources)
  # Read whole lines: protect characters that CMake lists treat specially, then split on newlines.
  file(READ "${source}" content)
  string(REPLACE ";" "<semicolon>" content "${content}")
  string(REPLACE "[" "<open>" content "${content}")
  string(REPLACE "]" "<close>" content "${content}")
  string(REPLACE "\n" ";" lines "${content}")
  set(number 0)
  foreach(line IN LISTS lines)
    math(EXPR number "${number} + 1")
    if("${line}" MATCHES "^[ \t]*#[ \t]*include[ \t]*<([^>]+)>")
      if(NOT "${CMAKE_MATCH_1}" IN_LIST allowed_system_headers)
        list(APPEND problems "${source}:${number}: include <${CMAKE_MATCH_1}> is not allowed")
      endif()
      continue()
    endif()
    if("${line}" MATCHES "^[ \t]*#[ \t]*include[ \t]*\"([^\"]+)\"")
      set(header "${CMAKE_MATCH_1}")
      if(NOT "${header}" MATCHES "^hsn/protocol/[a-z_]+\\.hpp$" AND NOT "${header}" STREQUAL "codec.hpp")
        list(APPEND problems "${source}:${number}: include \"${header}\" is not allowed")
      endif()
      continue()
    endif()
    # Comments may use any word: skip comment lines and strip trailing comments.
    if("${line}" MATCHES "^[ \t]*(//|/\\*|\\*)")
      continue()
    endif()
    string(REGEX REPLACE "//.*$" "" code "${line}")
    foreach(word IN LISTS forbidden_words)
      if("${code}" MATCHES "${word_start}${word}${word_end}")
        list(APPEND problems "${source}:${number}: '${word}' is not allowed")
      endif()
    endforeach()
    foreach(type IN LISTS forbidden_std)
      if("${code}" MATCHES "std::${type}${word_end}")
        list(APPEND problems "${source}:${number}: std::${type} is not allowed")
      endif()
    endforeach()
  endforeach()
endforeach()

if(NOT "${problems}" STREQUAL "")
  string(REPLACE ";" "\n" problems "${problems}")
  # NOTICE prints the report as it is; FATAL_ERROR text is re-wrapped by some CMake versions,
  # which the probe test's expected-output pattern could not match.
  message(NOTICE "core rule violations:\n${problems}")
  message(FATAL_ERROR "core rule check failed")
endif()
message(STATUS "${source_count} core sources follow the include and construct rules")
