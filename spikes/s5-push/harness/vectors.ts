/** Emit the relay's uniform envelope and controls for local simctl delivery. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import vectors from "../../../packages/protocol/vectors/relay-push.json";

const out = process.argv[2];
if (!out) process.exit(2);
mkdirSync(out, { recursive: true });

/** Give simctl the unmodified relay alert and optional step 2 instrumentation. */
function save(name: string, h: string, level?: string) {
  const aps = { alert: { "loc-key": "push.placeholder" }, "mutable-content": 1, sound: "default" };
  writeFileSync(join(out, name + ".apns"), JSON.stringify({ aps, h, ...(level && { s5: { level } }) }));
}

const h = vectors.seal[0]!.h;
for (const [i, v] of vectors.seal.entries()) save("v" + i, v.h);
const [version, id, sealed] = h.split(".");
const bytes = Buffer.from(sealed!, "base64url");
bytes[12] = bytes[12]! ^ 1;
save("changed-byte", [version, id, bytes.toString("base64url")].join("."));
for (const level of ["critical", "timeSensitive"]) save(level, h, level);
