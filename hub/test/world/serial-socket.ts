/** Windows browser bench ports. A marker file names a loopback byte stream, not a COM device. */
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname } from "node:path";
import { err, ok, okAsync, Result, ResultAsync } from "neverthrow";
import type { SerialBytes } from "../../src/shell/links/serial.ts";
import { linkError } from "../../src/shell/safe/link-error.ts";
import type { LinkError } from "../../src/ports/links.ts";

const ORIGIN = "test/world/serial-socket";

/** Opens a bench byte stream when its marker appears in the watched folder. */
function openBenchPort(path: string): Result<SerialBytes, LinkError> {
  return Result.fromThrowable(
    () => Number(readFileSync(path, "utf8").trim()),
    (error) => linkError("writeFailed", ORIGIN, `open bench port ${path}`, error),
  )().andThen((number) => {
    if (!Number.isInteger(number) || number < 1 || number > 65_535)
      return err(linkError("writeFailed", ORIGIN, `invalid bench port ${path}`));
    const stream = connect(number, "127.0.0.1");
    stream.setNoDelay();
    const closed = new Promise<void>((resolve) => {
      stream.once("close", () => {
        resolve();
      });
    });
    return ok({
      path,
      stream,
      closed,
      write: (bytes: Uint8Array) =>
        ResultAsync.fromPromise(
          new Promise<void>((resolve, reject) => {
            stream.write(bytes, (error) => {
              if (error) reject(error);
              else resolve();
            });
          }),
          (error) => linkError("writeFailed", ORIGIN, `write to bench port ${path}`, error),
        ),
      close: () => {
        stream.destroy();
        return ok(undefined);
      },
    });
  });
}

/** Uses the normal file-change scanner with the bench's marker paths. */
export function serialSocketFixture(ports: readonly string[]) {
  return {
    open: openBenchPort,
    watch: { folders: [...new Set(ports.map((port) => dirname(port)))], list: () => okAsync([]) },
  };
}
