# The firmware's portable libraries for the ESP32-S3: hsn_core, hsn_role_sensor, hsn_role_siren,
# hsn_role_gateway and hsn_psa, built by the same CMake files and from the same sources as the host
# build, with the same rules (cmake/options.cmake: -Wall -Wextra -Wpedantic -Wconversion
# -Wsign-conversion -Wshadow -Werror, -fno-exceptions -fno-rtti, -Wframe-larger-than=512). Nothing
# here lists a source file again, so a file added to the core or a role is built for the board too.
#
# What differs from the host build, and why:
# - The libraries are added after idf_component_register, so they inherit ESP-IDF's directory-level
#   compile options (the Xtensa flags such as -mlongcalls, -ffunction-sections, the optimisation
#   level). ESP-IDF v6 adds -std=gnu++26 among them; the core is C++17 exactly (firmware/README.md),
#   so -std=c++17 is added to each library after it, and the last -std wins.
# - PSA Crypto is ESP-IDF's own Mbed TLS 4.1. Its component builds TF-PSA-Crypto (1.1.0, the
#   version the host fetches) as a target named `tfpsacrypto`, the very name platform/psa links,
#   so hsn_psa links ESP-IDF's copy with its hardware AES and SHA drivers. The mbedtls component's
#   interface (its configuration and everything it reaches, ESP-IDF's libc headers among them) is
#   added to hsn_psa as system headers, through an imported target: they are the platform's
#   headers, as libc and the crypto headers are on the host, and ESP-IDF's libc headers use
#   #include_next, which -Wpedantic -Werror would otherwise refuse. hsn_psa's own code keeps every
#   warning.
# - The host's fault injection (HSN_PSA_FAULT_INJECTION) is taken off hsn_psa: on the target every
#   PSA call is the call itself, and fault_injection.cpp compiles to nothing.
idf_component_register(REQUIRES mbedtls)

get_filename_component(hsn_firmware_dir "${CMAKE_CURRENT_LIST_DIR}/../../../.." ABSOLUTE)
include("${hsn_firmware_dir}/cmake/options.cmake")

if(NOT TARGET tfpsacrypto)
  message(FATAL_ERROR "ESP-IDF's mbedtls component no longer builds a tfpsacrypto target")
endif()

add_subdirectory("${hsn_firmware_dir}/core" "${CMAKE_CURRENT_BINARY_DIR}/core")
add_subdirectory("${hsn_firmware_dir}/roles" "${CMAKE_CURRENT_BINARY_DIR}/roles")
add_subdirectory("${hsn_firmware_dir}/platform/psa" "${CMAKE_CURRENT_BINARY_DIR}/psa")

# An imported target's include directories are system include directories; the generator
# expression collects mbedtls's include directories over its whole link closure.
add_library(hsn_idf_crypto INTERFACE IMPORTED)
set_target_properties(hsn_idf_crypto PROPERTIES
  INTERFACE_INCLUDE_DIRECTORIES "$<TARGET_PROPERTY:idf::mbedtls,INTERFACE_INCLUDE_DIRECTORIES>"
  INTERFACE_LINK_LIBRARIES idf::mbedtls)
target_link_libraries(hsn_psa PUBLIC hsn_idf_crypto)

foreach(property COMPILE_DEFINITIONS INTERFACE_COMPILE_DEFINITIONS)
  get_target_property(definitions hsn_psa ${property})
  if(definitions)
    list(REMOVE_ITEM definitions HSN_PSA_FAULT_INJECTION=1)
    set_target_properties(hsn_psa PROPERTIES ${property} "${definitions}")
  endif()
endforeach()

# ESP-IDF's directory options come before ours and relax some of them (-Wno-error=extra,
# -Wno-unused-parameter, -Wno-sign-compare, -Wno-error=unused-function and the like). CMake keeps
# only the first of two identical options, so repeating -Wextra -Werror would change nothing: the
# host's strictness is restored with options spelled differently, which come last.
set(hsn_restore_host_warnings
  -Werror=extra -Wunused-parameter -Wsign-compare -Werror=unused-function -Werror=unused-variable
  -Werror=unused-but-set-variable -Werror=deprecated-declarations)

set(hsn_libraries hsn_core hsn_role_sensor hsn_role_siren hsn_role_gateway hsn_psa)
foreach(library IN LISTS hsn_libraries)
  target_compile_options(${library} PRIVATE ${hsn_restore_host_warnings}
    $<$<COMPILE_LANGUAGE:CXX>:-std=c++17>)
endforeach()

# The core_symbols rule on this target too (firmware/README.md, "Rules of the core"): each core and
# role library, as the Xtensa compiler built it, references no heap, exception or abort symbol.
# A violation fails the board build, as it fails the host's CTest.
if(NOT CMAKE_NM)
  message(FATAL_ERROR "no nm for the target: the core's symbol rule cannot be checked")
endif()
set(hsn_rule_stamps "")
foreach(library hsn_core hsn_role_sensor hsn_role_siren hsn_role_gateway)
  set(stamp "${CMAKE_CURRENT_BINARY_DIR}/${library}.symbols-checked")
  add_custom_command(OUTPUT "${stamp}"
    COMMAND ${CMAKE_COMMAND} -DNM=${CMAKE_NM} -DLIBRARY=$<TARGET_FILE:${library}>
            -P "${hsn_firmware_dir}/cmake/check_symbols.cmake"
    COMMAND ${CMAKE_COMMAND} -E touch "${stamp}"
    DEPENDS ${library} "${hsn_firmware_dir}/cmake/check_symbols.cmake"
    COMMENT "Checking ${library} for heap, exception and abort symbols"
    VERBATIM)
  list(APPEND hsn_rule_stamps "${stamp}")
endforeach()
add_custom_target(hsn_firmware_rules ALL DEPENDS ${hsn_rule_stamps})

target_link_libraries(${COMPONENT_LIB} INTERFACE ${hsn_libraries})
