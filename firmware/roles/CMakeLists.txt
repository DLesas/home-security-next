# The three roles, each its own library against hsn_core only (design section 7). The same rules
# as the core apply, and the rule checks in tests/ cover each role's sources.
foreach(role sensor siren gateway)
  add_library(hsn_role_${role} STATIC ${role}/src/${role}_role.cpp)
  target_include_directories(hsn_role_${role} PUBLIC ${role}/include)
  target_link_libraries(hsn_role_${role} PUBLIC hsn_core)
  hsn_firmware_library(hsn_role_${role})
endforeach()
