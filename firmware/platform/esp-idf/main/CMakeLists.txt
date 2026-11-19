idf_component_register(SRCS app_main.cpp REQUIRES hsn_firmware hsn_esp)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Wshadow -Werror=extra -Werror)
