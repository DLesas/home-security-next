// Deliberately breaks the core's rules, so the symbol check is shown to catch heap and exception
// use. Built only for the test that expects the check to fail.
#include <stdexcept>

int* hsn_symbol_probe_allocate(int value) {
  if (value < 0) {
    throw std::invalid_argument("negative");
  }
  return new int(value);
}
