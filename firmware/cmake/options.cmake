# Compile options for our own targets. Fetched code keeps its own options.

# Warnings are errors in everything we write, tests included.
function(hsn_warnings target)
  target_compile_options(${target} PRIVATE
    -Wall -Wextra -Wpedantic -Wconversion -Wsign-conversion -Wshadow -Werror)
endfunction()

# Sanitizers, when HSN_SANITIZE is on. Executables also need them at link time. UBSan's vptr
# check needs RTTI, which the firmware libraries are built without: GCC would then emit typeinfo
# references from the tests that the libraries never define. It is turned off for every target
# so that all of them agree.
function(hsn_sanitizers target)
  if(HSN_SANITIZE)
    target_compile_options(${target} PRIVATE
      -fsanitize=address,undefined -fno-sanitize=vptr -fno-sanitize-recover=all
      -fno-omit-frame-pointer)
    target_link_options(${target} PRIVATE -fsanitize=address,undefined -fno-sanitize=vptr)
  endif()
endfunction()

# Code that runs on the devices: no exceptions, no RTTI, and a stack frame limit that makes a
# large local buffer a build error. Sanitizers inflate frames, so the limit applies without them.
function(hsn_firmware_library target)
  hsn_warnings(${target})
  hsn_sanitizers(${target})
  target_compile_options(${target} PRIVATE -fno-exceptions -fno-rtti)
  if(NOT HSN_SANITIZE)
    target_compile_options(${target} PRIVATE -Wframe-larger-than=512)
  endif()
endfunction()
