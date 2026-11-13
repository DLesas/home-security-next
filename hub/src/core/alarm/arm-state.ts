/**
 * Changing one sensor's arming state (hub-design.md section 8, "Arming and the countdown"). Every
 * change goes out as `armedChanged`, on which the sensors module bumps the sensor's settings
 * version and writes its `sensor_config` row now, with the armed state read from this module's
 * view, before the CLI is answered and before any reply carries it (section 5).
 *
 * SPEC-QUESTION: `sensor_config` is one row holding the arming and the sensors module's settings
 * and version, and every write is a full row (section 2). The alarm runs before sensors, so it
 * cannot write the row with the bumped version; the reading taken is that sensors writes it on
 * `armedChanged`.
 */
import type { DeviceId, Seq } from "../model/ids.ts";
import { ArmState } from "../model/rows.ts";
import type { Changed } from "./out.ts";
import type { AlarmSlice, SensorArming } from "./state.ts";

/** `sensor` in `arm`; arming from disarmed records when (section 8: "every armed sensor records when it was armed"). */
export function setArm(
  slice: AlarmSlice,
  sensor: DeviceId,
  arming: SensorArming,
  arm: ArmState,
  cause: Seq | undefined,
  at: SensorArming["armedMono"],
): Changed {
  const disarmed = arm === ArmState.Disarmed;
  const fromDisarmed = arming.arm === ArmState.Disarmed;
  const next: SensorArming = {
    ...arming,
    arm,
    armedBoot: disarmed ? null : fromDisarmed ? slice.boot : arming.armedBoot,
    armedMono: disarmed ? null : fromDisarmed ? at : arming.armedMono,
  };
  return {
    slice: { ...slice, sensors: new Map(slice.sensors).set(sensor, next) },
    out: [{ kind: "armedChanged", sensor, arm, cause }],
  };
}
