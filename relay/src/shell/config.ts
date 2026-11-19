/**
 * The relay program's configuration (docs/m4-design.md section 3, "Self-hosting"): a JSON file on
 * the host, not in the repository, named by `--config <path>`. Strict: a key it does not name is
 * refused, so a mistyped setting is never silently ignored.
 *
 * ```json
 * {
 *   "listen": { "hostname": "0.0.0.0", "port": 8480,
 *               "tls": { "cert": "/etc/hsn-relay/cert.pem", "key": "/etc/hsn-relay/key.pem" },
 *               "trustedProxies": ["127.0.0.1"] },
 *   "dataFolder": "/var/lib/hsn-relay",
 *   "roles": ["relay", "releases"],
 *   "push": { "url": "ws+unix:///run/hsn-push/push.sock:/v1/relay" },
 *   "releases": { "folder": "/var/lib/hsn-relay/releases", "socket": "/run/hsn-relay/releases.sock" },
 *   "refusedHubs": "/etc/hsn-relay/refused-hubs"
 * }
 * ```
 *
 * - `roles`: `["relay"]`, or `["relay", "releases"]`. The push service is B3's own process under
 *   its own account (`relay/src/push/main.ts`), reached at `push.url`: its local socket on the
 *   operated host, `<DEPLOYMENT.push.url>/v1/relay` for a self-hosted relay (the default when
 *   `push` is left out). `names` is not built.
 * - `releases.folder`: the signed files served. `releases.socket`: on the operated host, the local
 *   socket on which the push process hands over the release frames of its relay links
 *   (`releases/forwarding.ts`). `releases.upstream`: cache from a same-host `{socket}` or
 *   `{link: true}` over `push.url`. With a TLS push URL and no forwarding socket, use the link
 *   by default.
 * - `refusedHubs`: a file of hub identities the operator refuses (4403), one per line; read again
 *   on SIGHUP.
 */
import { DEPLOYMENT } from "@hsn/deployment";
import { relayLinkUrl } from "@hsn/protocol/relay";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { relayError, type RelayError } from "./errors.ts";
import { parseJson } from "./safe/attempt.ts";
import { readText } from "./safe/fs.ts";

const ORIGIN = "shell/config";

const path = z.string().min(1);

export const relayConfigSchema = z.strictObject({
  listen: z.strictObject({
    hostname: z.string().min(1),
    port: z.int().min(0).max(65_535),
    tls: z.strictObject({ cert: path, key: path }).optional(),
    trustedProxies: z.array(z.string().min(1)).optional(),
  }),
  dataFolder: path,
  roles: z.union([
    z.tuple([z.literal("relay")]),
    z.tuple([z.literal("relay"), z.literal("releases")]),
  ]),
  push: z.strictObject({ url: z.string().min(1), ca: path.optional() }).optional(),
  releases: z
    .strictObject({
      folder: path,
      socket: path.optional(),
      socketMode: z.int().min(0).max(0o777).optional(),
      upstream: z
        .union([z.strictObject({ socket: path }), z.strictObject({ link: z.literal(true) })])
        .optional(),
    })
    .optional(),
  refusedHubs: path.optional(),
});
export type RelayConfig = z.infer<typeof relayConfigSchema>;

/** The push service's link URL: the configured one, or the deployment's. */
export function pushUrl(config: RelayConfig): Result<string, RelayError> {
  const url = config.push?.url ?? relayLinkUrl(DEPLOYMENT.push.url);
  return url === undefined ? err(relayError("config", ORIGIN, "no push service URL")) : ok(url);
}

/** Reads `--config <path>` from the arguments, then the file. */
export function readConfig(args: readonly string[]): Result<RelayConfig, RelayError> {
  const at = args.indexOf("--config");
  const file = at === -1 ? undefined : args[at + 1];
  if (file === undefined || args.length !== 2) {
    return err(relayError("config", ORIGIN, "usage: relay --config <path>"));
  }
  return readText(file, "the configuration")
    .andThen((text) => parseJson(text, ORIGIN, "the configuration"))
    .andThen((json) => {
      const parsed = relayConfigSchema.safeParse(json);
      if (!parsed.success) {
        const where = parsed.error.issues[0]?.path.join(".") ?? "";
        return err(relayError("config", ORIGIN, "the configuration is not valid", { where }));
      }
      const config = parsed.data;
      const releases = config.releases;
      if (config.roles.length === 2 && releases === undefined) {
        return err(relayError("config", ORIGIN, "the releases role needs releases.folder"));
      }
      if (
        releases?.upstream !== undefined &&
        "link" in releases.upstream &&
        config.push === undefined
      ) {
        return err(relayError("config", ORIGIN, "releases.upstream.link needs push.url"));
      }
      if (
        releases !== undefined &&
        releases.upstream === undefined &&
        releases.socket === undefined &&
        config.push?.url.startsWith("wss://") === true
      ) {
        return ok<RelayConfig, RelayError>({
          ...config,
          releases: { ...releases, upstream: { link: true } },
        });
      }
      return ok(config);
    });
}

/** Hub identities, one per line; blank lines and `#` comments skipped. */
export function readRefusedHubs(file: string): Result<ReadonlySet<string>, RelayError> {
  return readText(file, "the refused hubs").map(
    (text) =>
      new Set(
        text
          .split("\n")
          .map((line) => line.replace(/#.*$/u, "").trim())
          .filter((line) => line.length > 0),
      ),
  );
}
