/**
 * The phone's release check (m3-design.md section 2, "Cleartext to a local relay"; m4-design.md
 * section 2's rules), run for a release build after `expo prebuild` with `HSN_RELEASE` set. It
 * fails when the configuration point still holds a placeholder or no Apple team, or when the
 * generated Android manifest allows cleartext traffic, which only a development build may (the
 * other two refusals are `app.config.ts`'s and the relay `Connect`'s). Run from `app/` as
 * `bun scripts/release-check.ts [<Android manifest>]`; it prints each problem and exits 1.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEPLOYMENT,
  type Deployment,
  deploymentProblems,
} from "../../packages/deployment/src/deployment.ts";

/** Where `expo prebuild` writes Android's manifest, from `app/`. */
export const ANDROID_MANIFEST = join("android", "app", "src", "main", "AndroidManifest.xml");

/** True when a manifest lets the app open cleartext connections. */
export function allowsCleartext(manifest: string): boolean {
  return /android:usesCleartextTraffic\s*=\s*"true"/u.test(manifest);
}

/** Everything that stops a release, in words; empty when it may go. */
export function releaseProblems(
  deployment: Deployment,
  androidManifest: string | undefined,
): readonly string[] {
  const problems = deploymentProblems(deployment, { release: true }).map(
    (p) => `${p.field}: ${p.problem}`,
  );
  if (androidManifest === undefined)
    problems.push(`${ANDROID_MANIFEST}: missing (run expo prebuild first)`);
  else if (allowsCleartext(androidManifest))
    problems.push(`${ANDROID_MANIFEST}: allows cleartext traffic`);
  return problems;
}

if (import.meta.main) {
  const path = process.argv[2] ?? ANDROID_MANIFEST;
  const problems = releaseProblems(
    DEPLOYMENT,
    existsSync(path) ? readFileSync(path, "utf8") : undefined,
  );
  for (const problem of problems) console.error(problem);
  process.exit(problems.length === 0 ? 0 : 1);
}
