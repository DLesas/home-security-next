/**
 * Network names and addresses as the apps' listener checks them (m2-design.md section 5): an IP
 * address's bytes from its text, for the certificate's names and for comparing a `Host` header
 * with them, whatever way an IPv6 address was written. Pure, and never throws.
 */

const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/u;

function ipv4Bytes(text: string): Uint8Array | undefined {
  return IPV4.test(text) ? Uint8Array.from(text.split(".").map(Number)) : undefined;
}

function groupsOf(part: string): number[] | undefined {
  if (part === "") return [];
  const groups: number[] = [];
  const words = part.split(":");
  for (const [i, word] of words.entries()) {
    if (i === words.length - 1 && word.includes(".")) {
      const v4 = ipv4Bytes(word);
      if (v4 === undefined) return undefined;
      groups.push(((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0));
      continue;
    }
    if (!/^[0-9a-fA-F]{1,4}$/u.test(word)) return undefined;
    groups.push(Number.parseInt(word, 16));
  }
  return groups;
}

function ipv6Bytes(text: string): Uint8Array | undefined {
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = groupsOf(halves[0] ?? "");
  const tail = halves.length === 2 ? groupsOf(halves[1] ?? "") : [];
  if (head === undefined || tail === undefined) return undefined;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const groups = [...head, ...new Array<number>(Math.max(0, missing)).fill(0), ...tail];
  return Uint8Array.from(groups.flatMap((g) => [g >> 8, g & 0xff]));
}

/** An IP address's 4 or 16 bytes from its text, or undefined for anything else (a name). */
export function ipBytes(text: string): Uint8Array | undefined {
  if (text.includes(":")) return ipv6Bytes(text.replace(/%.*$/u, ""));
  return ipv4Bytes(text);
}

/** A comparable key for a name or an address: its bytes as hex, or the name in lower case. */
export function hostKey(text: string): string {
  const bytes = ipBytes(text);
  return bytes === undefined
    ? `name:${text.toLowerCase()}`
    : `ip:${Buffer.from(bytes).toString("hex")}`;
}

/**
 * A `Host` header's host and port (RFC 9110, 7.2): `name:port`, `1.2.3.4:port` or `[v6]:port`;
 * undefined when it names no port or is not one of these forms.
 */
export function splitHost(
  header: string,
): { readonly host: string; readonly port: number } | undefined {
  const bracketed = /^\[([0-9a-fA-F:.]+)\]:(\d{1,5})$/u.exec(header);
  const plain = /^([A-Za-z0-9.-]+):(\d{1,5})$/u.exec(header);
  const match = bracketed ?? plain;
  if (match === null) return undefined;
  const port = Number(match[2]);
  return port > 0 && port <= 0xffff ? { host: match[1] ?? "", port } : undefined;
}

/** The host names the certificate carries for a computer called `hostname` (section 5). */
export function hostNames(hostname: string): readonly string[] {
  const base = hostname.toLowerCase().replace(/\.local\.?$/u, "");
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/u.test(base)) return [];
  return [base, `${base}.local`];
}
