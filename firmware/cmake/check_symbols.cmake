# Fails when a static library references heap, exception or abort symbols.
# Usage: cmake -DNM=<nm> -DLIBRARY=<lib.a> -P check_symbols.cmake

# A -P script gets old policies unless it declares its own; every if() below also quotes the
# values it tests, so no value is ever expanded a second time.
cmake_minimum_required(VERSION 3.28)

if("${NM}" STREQUAL "" OR "${LIBRARY}" STREQUAL "")
  message(FATAL_ERROR "NM and LIBRARY are required")
endif()

execute_process(COMMAND "${NM}" -g "${LIBRARY}"
  OUTPUT_VARIABLE listing RESULT_VARIABLE result ERROR_VARIABLE errors)
if(NOT "${result}" EQUAL 0)
  message(FATAL_ERROR "nm failed on ${LIBRARY}: ${errors}")
endif()

# Lines look like "<address> T name" or "                 U name"; the name is the last token.
string(REGEX MATCHALL "[^\n]+" lines "${listing}")
set(defined 0)
set(found "")
foreach(line IN LISTS lines)
  if(NOT "${line}" MATCHES "^[ 0-9a-fA-F]* ([A-Za-z]) ([^ ]+)$")
    continue()
  endif()
  set(kind "${CMAKE_MATCH_1}")
  set(name "${CMAKE_MATCH_2}")
  # U is undefined; GNU nm shows weak undefined references as w or v.
  if(NOT "${kind}" MATCHES "^[Uwv]$")
    math(EXPR defined "${defined} + 1")
    continue()
  endif()
  # Leading underscores differ between Mach-O and ELF, so they are allowed in any number.
  if("${name}" MATCHES "^_*Z(nw|na|dl|da)"                                       # operator new, delete
     OR "${name}" MATCHES "^_*(malloc|calloc|realloc|free|aligned_alloc|posix_memalign|abort)$"
     OR "${name}" MATCHES "__cxa_(throw|allocate_exception|begin_catch|end_catch|rethrow|pure_virtual)"
     OR "${name}" MATCHES "__gxx_personality|_Unwind_"
     OR "${name}" MATCHES "throw")                                                # std::__throw_*
    list(APPEND found "${name}")
  endif()
endforeach()

if("${defined}" EQUAL 0)
  message(FATAL_ERROR "${LIBRARY} defines no symbols; the check would prove nothing")
endif()
if(NOT "${found}" STREQUAL "")
  list(REMOVE_DUPLICATES found)
  string(REPLACE ";" "\n  " found "${found}")
  # NOTICE prints the report as it is; FATAL_ERROR text is re-wrapped by some CMake versions,
  # which the probe test's expected-output pattern could not match.
  message(NOTICE "${LIBRARY} references forbidden symbols:\n  ${found}")
  message(FATAL_ERROR "symbol check failed")
endif()
message(STATUS "${LIBRARY}: ${defined} defined symbols, no heap, exception or abort references")
