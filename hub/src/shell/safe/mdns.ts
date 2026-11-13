/**
 * The mDNS library, `bonjour-service`, behind results (hub-design.md section 10; §10). Its
 * constructor binds a multicast socket, `publish` throws on a service missing its name, type or
 * port, and a running service reports later failures as `error` events, which `advertise`
 * hands to `onError`.
 */
import { Bonjour, type Service, type ServiceConfig } from "bonjour-service";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import type { HubError } from "../../core/model/errors.ts";
import { errorFrom } from "./thrown.ts";

type MdnsError = HubError & { readonly kind: "link" };

/**
 * One call into the library, or into a stand-in for it in a test: its throw is a link error
 * (section 10), so callers need no `try` of their own.
 */
export function mdnsCall<T>(origin: string, what: string, run: () => T): Result<T, MdnsError> {
  try {
    return ok(run());
  } catch (thrown) {
    return err(errorFrom("link", origin, what, thrown));
  }
}

/** Starts the library; `onError` receives the errors its socket reports later. */
export function startMdns(
  origin: string,
  onError: (error: MdnsError) => void,
): Result<Bonjour, MdnsError> {
  try {
    return ok(
      new Bonjour({}, (thrown: unknown) => {
        onError(errorFrom("link", origin, "mDNS", thrown));
      }),
    );
  } catch (thrown) {
    return err(errorFrom("link", origin, "start mDNS", thrown));
  }
}

/** Publishes one service; its later `error` events go to `onError`. */
export function advertise(
  mdns: Bonjour,
  service: ServiceConfig,
  origin: string,
  onError: (error: MdnsError) => void,
): Result<Service, MdnsError> {
  try {
    const published = mdns.publish(service);
    published.on("error", (thrown: unknown) => {
      onError(errorFrom("link", origin, `advertise ${service.type}`, thrown));
    });
    return ok(published);
  } catch (thrown) {
    return err(errorFrom("link", origin, `advertise ${service.type}`, thrown));
  }
}

/** Withdraws every service and closes the socket. */
export function stopMdns(mdns: Bonjour, origin: string): ResultAsync<void, MdnsError> {
  const stopped = new Promise<void>((resolve, reject) => {
    try {
      mdns.unpublishAll(() => {
        mdns.destroy(() => {
          resolve();
        });
      });
    } catch (thrown) {
      reject(thrown instanceof Error ? thrown : new Error("mDNS stop failed"));
    }
  });
  return ResultAsync.fromPromise(stopped, (thrown) =>
    errorFrom("link", origin, "stop mDNS", thrown),
  );
}
