/**
 * What layer 1 counts by (docs/m4-design.md section 3, D142): "an address means an IPv4 address
 * or an IPv6 /64 ‡" (`PROTECTION_LIMITS.ipv6PrefixBits`). Pure.
 */
import { PROTECTION_LIMITS } from "./rules.ts";

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u;

function ipv4(text: string): string | undefined {
  const match = IPV4.exec(text);
  if (match === null) return undefined;
  const parts = match.slice(1).map(Number);
  return parts.every((p) => p <= 255) ? parts.join(".") : undefined;
}

/** Eight 16-bit groups of an IPv6 address (zone dropped), or undefined when it is not one. */
function ipv6Groups(text: string): number[] | undefined {
  const bare = text.replace(/%.*$/u, "");
  const halves = bare.split("::");
  if (halves.length > 2) return undefined;
  const part = (s: string) => (s === "" ? [] : s.split(":"));
  const head = part(halves[0] ?? "");
  const tail = halves.length === 2 ? part(halves[1] ?? "") : [];
  // An embedded IPv4 address at the end counts as two groups.
  const last = tail.length > 0 ? tail[tail.length - 1] : head[head.length - 1];
  const embedded = last === undefined ? undefined : ipv4(last);
  const groups: string[] = [];
  const expand = (list: string[]) =>
    list.flatMap((g) => {
      if (g === last && embedded !== undefined) {
        const [a = 0, b = 0, c = 0, d = 0] = embedded.split(".").map(Number);
        return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
      }
      return [g];
    });
  const headGroups = expand(head);
  const tailGroups = expand(tail);
  const missing = 8 - headGroups.length - tailGroups.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  groups.push(...headGroups, ...new Array<string>(halves.length === 2 ? missing : 0).fill("0"));
  groups.push(...tailGroups);
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/iu.test(g))) return undefined;
  return groups.map((g) => parseInt(g, 16));
}

/**
 * The key an address is counted under: an IPv4 address as it is (an IPv4-mapped IPv6 address as
 * its IPv4 one), an IPv6 address as its prefix of `PROTECTION_LIMITS.ipv6PrefixBits` bits,
 * written `a:b:c:d::/64`. Undefined for text that is no address, which the relay refuses.
 */
export function addressKey(ip: string): string | undefined {
  const v4 = ipv4(ip);
  if (v4 !== undefined) return v4;
  const groups = ipv6Groups(ip);
  if (groups === undefined) return undefined;
  const mapped =
    groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff
      ? `${(groups[6] ?? 0) >> 8}.${(groups[6] ?? 0) & 0xff}.${(groups[7] ?? 0) >> 8}.${(groups[7] ?? 0) & 0xff}`
      : undefined;
  if (mapped !== undefined) return mapped;
  const bits = PROTECTION_LIMITS.ipv6PrefixBits;
  const whole = Math.floor(bits / 16);
  const kept = groups.slice(0, whole);
  const rest = bits % 16;
  if (rest > 0) kept.push((groups[whole] ?? 0) & ((0xffff << (16 - rest)) & 0xffff));
  return `${kept.map((g) => g.toString(16)).join(":")}::/${bits}`;
}
