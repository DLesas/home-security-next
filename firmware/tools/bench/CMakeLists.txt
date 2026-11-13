# hsn_bench: the bench in real time, with the real roles, for the real hub (hub-design.md
# section 11, "Conformance with the firmware, through the bridge to the bench"). See README.md.
add_executable(hsn_bench main.cpp)
target_link_libraries(hsn_bench PRIVATE hsn_host hsn_role_sensor hsn_role_siren hsn_role_gateway)
# It builds roles, so it is built without RTTI, like the core that emits Role's vtable.
target_compile_options(hsn_bench PRIVATE -fno-rtti)
hsn_warnings(hsn_bench)
hsn_sanitizers(hsn_bench)
