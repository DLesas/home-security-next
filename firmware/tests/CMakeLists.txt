add_executable(hsn_tests
  main.cpp
  support.cpp
  bytes_test.cpp
  counters_test.cpp
  framing_test.cpp
  messages_test.cpp
  packet_test.cpp
  radio_units_test.cpp
  random_test.cpp
  vectors_test.cpp)
target_link_libraries(hsn_tests PRIVATE hsn_psa hsn_doctest hsn_json)
target_compile_definitions(hsn_tests PRIVATE
  HSN_VECTORS_DIR="${PROJECT_SOURCE_DIR}/../packages/protocol/vectors")
hsn_warnings(hsn_tests)
hsn_sanitizers(hsn_tests)
add_test(NAME hsn_tests COMMAND hsn_tests)

# hsn_core must not reference the heap, exceptions or abort.
add_test(NAME core_symbols
  COMMAND ${CMAKE_COMMAND} -DNM=${CMAKE_NM} -DLIBRARY=$<TARGET_FILE:hsn_core>
          -P ${PROJECT_SOURCE_DIR}/cmake/check_symbols.cmake)

# The same check must reject a library that allocates and throws.
add_library(hsn_symbol_probe STATIC EXCLUDE_FROM_ALL probes/symbol_probe.cpp)
add_test(NAME core_symbols_probe_build
  COMMAND ${CMAKE_COMMAND} --build ${CMAKE_BINARY_DIR} --target hsn_symbol_probe)
set_tests_properties(core_symbols_probe_build PROPERTIES FIXTURES_SETUP symbol_probe)
add_test(NAME core_symbols_check_catches_violations
  COMMAND ${CMAKE_COMMAND} -DNM=${CMAKE_NM} -DLIBRARY=$<TARGET_FILE:hsn_symbol_probe>
          -P ${PROJECT_SOURCE_DIR}/cmake/check_symbols.cmake)
# The pass condition is the expected violation report, not any failure: a broken script must
# not pass. CTest then ignores the exit code, which is non-zero by design.
set_tests_properties(core_symbols_check_catches_violations PROPERTIES
  PASS_REGULAR_EXPRESSION "references forbidden symbols:.*Znw.*cxa_throw"
  FIXTURES_REQUIRED symbol_probe)

# hsn_core sources use only allowed headers and constructs.
add_test(NAME core_sources
  COMMAND ${CMAKE_COMMAND} -DSOURCE_DIR=${PROJECT_SOURCE_DIR}/core
          -P ${PROJECT_SOURCE_DIR}/cmake/check_core_sources.cmake)

# The same check must reject a source that breaks the rules.
add_test(NAME core_sources_check_catches_violations
  COMMAND ${CMAKE_COMMAND} -DSOURCE_DIR=${CMAKE_CURRENT_SOURCE_DIR}/probes/core_rule_violation
          -P ${PROJECT_SOURCE_DIR}/cmake/check_core_sources.cmake)
set_tests_properties(core_sources_check_catches_violations PROPERTIES
  PASS_REGULAR_EXPRESSION "include <vector> is not allowed.*'double' is not allowed")
