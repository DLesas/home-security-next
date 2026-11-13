# Whole-system tests with the real roles

Scenario tests that run the real sensor, siren and gateway roles together on one `Simulation` with the `TestHub`: M1a's "done when" with the real roles, and many sensors on one gateway (design section 8, "System tests").

Every `.cpp` here goes into `hsn_system_tests`, which links all three role libraries, `hsn_host` and `hsn_test_support` (include `sim_support.hpp` for the bench helpers), and is compiled without RTTI. The executable exists only once this folder has a `.cpp` file. Tests with the scripted devices instead of the roles go in `tests/system/`; tests of one role go in `tests/roles/<role>/`.

`system_site.hpp` builds a site (a `SystemSite`: the simulation, the test hub in gateway link mode, and `gateway()`, `sensor()`, `siren()` adding the real roles) and holds the questions the scenarios ask of the timeline and the hub. The day-long load cases are in the doctest test suite `long`; `hsn_system_tests -tse=long` leaves them out, `-ts=long --duration=true` runs only them and prints how long each took. Tests marked `BLOCKED:` are skipped: each is the test that should pass, with the evidence of what stops it.
