/**
 * Wave 0's pure parts (`wave0.ts`), apart so that `bun test` can check them without React
 * Native's modules. Development builds only, as `wave0.ts`.
 */

/** Every route of `src/app/`, as a person reaches it. */
export const ROUTES = [
  "/",
  "/devices",
  "/device/1",
  "/device/add",
  "/device/update",
  "/groups",
  "/modes",
  "/history",
  "/notifications",
  "/settings",
  "/this-phone",
  "/link-home",
  "/people",
  "/schedules",
  "/site",
  "/backup",
  "/updates",
  "/link",
  "/status",
  "/setup",
  "/restore",
] as const;

/** `base` to the power `exponent`, modulo `modulus`: square and multiply, as SRP's client does. */
export function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if ((e & 1n) === 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}

/** A number of `bits` bits, odd, from `fill`'s bytes. */
export function bigOfBits(bits: number, fill: (bytes: Uint8Array<ArrayBuffer>) => void): bigint {
  const bytes = new Uint8Array(new ArrayBuffer(bits / 8));
  fill(bytes);
  return BigInt(`0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`) | 1n;
}

/** `open`: the routes shown, none walked; `all`: every route; else a comma-separated list. */
export function routesToWalk(asked: string): readonly string[] {
  if (asked === "open") return [];
  if (asked === "all") return ROUTES;
  return asked.split(",").filter((route) => route.startsWith("/"));
}

/**
 * The socket check's request: `url`, or `url@host:port` to send that `Host`; the `Origin` is
 * always `https://` and the authority the hub is told.
 */
export function socketRequest(entry: string): {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
} {
  const [url = entry, authority] = entry.split("@");
  const own = url.replace(/^wss:\/\//u, "").replace(/\/.*$/u, "");
  return {
    url,
    headers:
      authority === undefined
        ? { Origin: `https://${own}` }
        : { Origin: `https://${authority}`, Host: authority },
  };
}
