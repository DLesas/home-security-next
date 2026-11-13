/** Radio timing vectors: time on air (section 2), exact in microseconds, and event listen time. */
import { DATA_RATE_COUNT, eventListenMs, spreadingFactor, timeOnAirMs } from "../../src/index.ts";
import type { Json, JsonObject } from "./json.ts";

/** The packet lengths in section 2's table, plus the shortest and longest radio packets. */
const LENGTHS = [0, 18, 21, 25, 26, 28, 32, 50, 255];

function spreadingFactorOf(dataRate: number): number {
  const sf = spreadingFactor(dataRate);
  if (sf === undefined) throw new Error(`no spreading factor for DR${dataRate}`);
  return sf;
}

const dataRates = Array.from({ length: DATA_RATE_COUNT }, (_, dataRate) => dataRate);

export function timeOnAirVectorFile(): JsonObject {
  const cases = dataRates.flatMap((dataRate) =>
    LENGTHS.map((length): Json => {
      const sf = spreadingFactorOf(dataRate);
      const milliseconds = timeOnAirMs(sf, length);
      return {
        dataRate,
        spreadingFactor: sf,
        length,
        microseconds: Math.round(milliseconds * 1000),
        milliseconds,
      };
    }),
  );
  const eventListen = dataRates.map((dataRate): Json => {
    const milliseconds = eventListenMs(dataRate);
    if (milliseconds === undefined) throw new Error(`no event listen time for DR${dataRate}`);
    return { dataRate, spreadingFactor: spreadingFactorOf(dataRate), milliseconds };
  });
  return { cases, eventListen };
}
