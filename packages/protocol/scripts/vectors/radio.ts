/** Time-on-air vectors (section 2), exact in microseconds. */
import { DATA_RATE_COUNT, spreadingFactor, timeOnAirMs } from "../../src/index.ts";
import type { Json, JsonObject } from "./json.ts";

/** The packet lengths in section 2's table, plus the shortest and longest radio packets. */
const LENGTHS = [0, 18, 21, 25, 26, 28, 30, 255];

export function timeOnAirVectorFile(): JsonObject {
  const cases: Json[] = [];
  for (let dataRate = 0; dataRate < DATA_RATE_COUNT; dataRate++) {
    const sf = spreadingFactor(dataRate);
    if (sf === undefined) throw new Error(`no spreading factor for DR${dataRate}`);
    for (const length of LENGTHS) {
      const milliseconds = timeOnAirMs(sf, length);
      cases.push({
        dataRate,
        spreadingFactor: sf,
        length,
        microseconds: Math.round(milliseconds * 1000),
        milliseconds,
      });
    }
  }
  return { cases };
}
