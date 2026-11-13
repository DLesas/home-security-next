# The three roles, each its own library against hsn_core only (design section 7). The same rules
# as the core apply, and the rule checks in tests/ cover each role's sources. A role's library is
# every .cpp under roles/<role>/src/, so its owner adds files there without editing this file.
foreach(role sensor siren gateway)
  file(GLOB_RECURSE hsn_role_sources CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/${role}/src/*.cpp)
  if(NOT hsn_role_sources)
    message(FATAL_ERROR "roles/${role}/src/ has no .cpp files")
  endif()
  add_library(hsn_role_${role} STATIC ${hsn_role_sources})
  target_include_directories(hsn_role_${role} PUBLIC ${role}/include)
  target_link_libraries(hsn_role_${role} PUBLIC hsn_core)
  hsn_firmware_library(hsn_role_${role})
endforeach()
