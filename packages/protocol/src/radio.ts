/** Radio maths (section 2): data rates and LoRa time on air. */

/** Spreading factor for each data rate index, DR0 to DR5. */
const SPREADING_FACTOR_BY_DATA_RATE = [12, 11, 10, 9, 8, 7] as const;

export const DATA_RATE_COUNT = SPREADING_FACTOR_BY_DATA_RATE.length;

/**
 * Event listen time (section 8 †): how long a sensor listens for the hub's answer after a door,
 * cover, button or started report, by the data rate the report was sent at, DR0 to DR5, in
 * milliseconds. The hub's latest moment for an event reply comes from it, so hub and sensor
 * read the one table; the firmware holds the same values as `kEventListenMs`.
 */
export const EVENT_LISTEN_MS = [3000, 2600, 2200, 1900, 1700, 1500] as const;

/** The event listen time for a data rate index, or `undefined` for an index not in the table. */
export function eventListenMs(dataRate: number): number | undefined {
  return Number.isInteger(dataRate) ? EVENT_LISTEN_MS[dataRate] : undefined;
}

/** Data rate indexes, as every data rate field carries them. */
export const DataRate = { DR0: 0, DR1: 1, DR2: 2, DR3: 3, DR4: 4, DR5: 5 } as const;
export type DataRate = (typeof DataRate)[keyof typeof DataRate];

/** The spreading factor for a data rate index, or `undefined` for an index not in the table. */
export function spreadingFactor(dataRate: number): number | undefined {
  return Number.isInteger(dataRate) ? SPREADING_FACTOR_BY_DATA_RATE[dataRate] : undefined;
}

/** Site channels as sent in settings and pairing data. */
export const SiteChannel = { Mhz868_1: 0, Mhz868_3: 1, Mhz868_5: 2 } as const;
export type SiteChannel = (typeof SiteChannel)[keyof typeof SiteChannel];

/** One bit per data rate index, as in gateway settings and pairing data. */
export function dataRateMask(dataRates: readonly number[]): number {
  return dataRates.reduce((mask, dataRate) => {
    if (spreadingFactor(dataRate) === undefined) throw new RangeError(`no data rate ${dataRate}`);
    return mask | (1 << dataRate);
  }, 0);
}

/** The data rate indexes set in a mask, lowest first; bits past DR5 are ignored. */
export function dataRatesInMask(mask: number): number[] {
  return SPREADING_FACTOR_BY_DATA_RATE.flatMap((_, dataRate) =>
    mask & (1 << dataRate) ? [dataRate] : [],
  );
}

// LoRa settings from section 2, as used by the time-on-air formula in spike S2.
const BANDWIDTH_KHZ = 125;
/** Coding rate 4/5. */
const CODING_RATE = 1;
const PREAMBLE_SYMBOLS = 8;
const CRC_BITS = 16;
const EXPLICIT_HEADER_BITS = 20;
const LOW_DATA_RATE_OPTIMISATION_FROM_SF = 11;
const MAX_RADIO_PAYLOAD = 255;

/**
 * Milliseconds a LoRa packet of `length` bytes takes to send at a spreading factor (SX1261/2
 * datasheet 6.1.4): 125 kHz, coding rate 4/5, 8-symbol preamble, explicit header, CRC on,
 * low data rate optimisation for SF11 and SF12. Unrounded.
 */
export function timeOnAirMs(spreadingFactor: number, length: number): number {
  if (!Number.isInteger(spreadingFactor) || spreadingFactor < 7 || spreadingFactor > 12) {
    throw new RangeError("spreading factor must be from 7 to 12");
  }
  if (!Number.isInteger(length) || length < 0 || length > MAX_RADIO_PAYLOAD) {
    throw new RangeError("LoRa payload must be from 0 to 255 bytes");
  }
  const lowDataRate = spreadingFactor >= LOW_DATA_RATE_OPTIMISATION_FROM_SF;
  const bitsPerBlock = 4 * (lowDataRate ? spreadingFactor - 2 : spreadingFactor);
  const payloadBits = 8 * length + CRC_BITS - 4 * spreadingFactor + 8 + EXPLICIT_HEADER_BITS;
  const payloadSymbols = Math.ceil(Math.max(payloadBits, 0) / bitsPerBlock) * (CODING_RATE + 4);
  const symbols = PREAMBLE_SYMBOLS + 4.25 + 8 + payloadSymbols;
  return (symbols * 2 ** spreadingFactor) / BANDWIDTH_KHZ;
}
