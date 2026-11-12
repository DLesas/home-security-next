#pragma once

namespace hsn::device {

/**
 * Whether the board runs on external power: USB on a sensor, the supply on a siren or gateway.
 * Shared by every role and by Device, which needs it in setup-only mode before any role exists;
 * the role I/O interfaces do not repeat it. A change also arrives as an InputEvent for
 * Input::external_power.
 */
class Power {
public:
  /**
   * Returns true while external power is present. A short read, never blocking.
   */
  virtual bool external_power() = 0;

protected:
  Power() = default;
  Power(const Power&) = default;
  Power& operator=(const Power&) = default;
  ~Power() = default;
};

}  // namespace hsn::device
