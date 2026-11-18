/**
 * Opening serial ports on sight (hub-design.md section 3, "Serial links"; protocol.md §10): a
 * port with Espressif's USB vendor number, and every path given with `--serial <path>` (the
 * bench's pseudo-terminals). The ports are listed once at start and again only when a watched
 * folder changes (`/dev`, and the folder of each `--serial` path), never on a timer, because
 * listing ports on Linux asks udev and costs a Pi real time ‡.
 */
import type { FSWatcher } from "node:fs";
import { dirname } from "node:path";
import { err, ok, okAsync, type Result, type ResultAsync } from "neverthrow";
import type { HubError } from "../../core/model/errors.ts";
import { stopWatching, watchFolder } from "../safe/fs.ts";
import { listSerialPorts } from "../safe/serial.ts";
import { watchWindowsSerial, WINDOWS_SERIAL } from "../safe/serial-windows.ts";
import type { LinkError } from "../../ports/links.ts";

/** Espressif's USB vendor number (protocol.md §10), as `serialport` lists it. */
export const ESPRESSIF_VENDOR_ID = "303a";

/** Where new serial devices appear (Linux and macOS). */
export const DEVICE_FOLDER = "/dev";

/** What the watcher opens and how it reports failures. */
export interface UsbWatchOptions {
  /** The paths given with `--serial`, opened whether or not they are Espressif's. */
  readonly extraPaths: readonly string[];
  /** The folders to watch; `/dev` and each extra path's folder by default. */
  readonly folders?: readonly string[];
  /** Lists the system's ports; `listSerialPorts` by default (tests give their own). */
  readonly list?: typeof listSerialPorts;
  /** Told of every failure: a list, a watch or an open that failed. Recorded by the caller. */
  readonly failed: (error: HubError) => void;
  /** The Windows watcher has armed its first registry notice. */
  readonly started?: () => void;
}

/** What the watcher needs of the serial links (`SerialLinks`). */
export interface PortOpener {
  has(path: string): boolean;
  open(path: string): Result<unknown, LinkError>;
}

/** Opens serial ports as they appear (section 3). */
export class UsbWatch {
  readonly #serial: PortOpener;
  readonly #options: UsbWatchOptions;
  readonly #watchers: FSWatcher[] = [];
  #scanning: Promise<void> | undefined;
  #again = false;
  #windows: { close(): Promise<void> } | undefined;
  #closed: Promise<void> | undefined;
  #stopped = false;

  constructor(serial: PortOpener, options: UsbWatchOptions) {
    this.#serial = serial;
    this.#options = options;
  }

  /** Starts watching and opens what is there now. */
  start(): Result<void, HubError>[] {
    if (WINDOWS_SERIAL && this.#options.folders === undefined) {
      let armed = false;
      return [
        watchWindowsSerial(
          () => {
            armed = true;
            this.#options.started?.();
            this.scan();
          },
          () => {
            this.scan();
          },
          (error) => {
            if (this.#stopped) return;
            this.#options.failed(error);
            if (!armed) this.scan();
          },
        ).match(
          (watcher) => {
            this.#windows = watcher;
            return ok(undefined);
          },
          (error) => {
            this.scan();
            return err(error);
          },
        ),
      ];
    }
    const folders = this.#options.folders ?? [
      DEVICE_FOLDER,
      ...this.#options.extraPaths.map((p) => dirname(p)),
    ];
    const watched = [...new Set(folders)].map((folder) =>
      watchFolder(
        folder,
        () => {
          this.scan();
        },
        this.#options.failed,
      ).map((watcher) => {
        this.#watchers.push(watcher);
      }),
    );
    // What is there now, watched or not: `--serial` paths open with `--no-usb-watch` too.
    this.scan();
    return watched;
  }

  stop(): void {
    if (WINDOWS_SERIAL) {
      this.#stopped = true;
      this.#closed = this.#windows?.close();
    }
    for (const watcher of this.#watchers.splice(0)) {
      stopWatching(watcher).match(
        () => undefined,
        (error) => {
          this.#options.failed(error);
        },
      );
    }
  }

  /** Lists the ports once and opens the new ones; a scan asked for during one runs after it. */
  scan(): void {
    if (this.#stopped) return;
    if (this.#scanning !== undefined) {
      this.#again = true;
      return;
    }
    this.#scanning = this.#scanOnce()
      .match(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        this.#scanning = undefined;
        if (this.#again) {
          this.#again = false;
          this.scan();
        }
      });
  }

  /** Waits for the scans in progress, if any (for tests and a clean stop). */
  async settled(): Promise<void> {
    if (this.#closed !== undefined) await this.#closed;
    while (this.#scanning !== undefined) await this.#scanning;
  }

  #scanOnce(): ResultAsync<void, never> {
    const list = this.#options.list ?? listSerialPorts;
    return list()
      .orElse((error) => {
        this.#options.failed(error);
        return okAsync([]);
      })
      .andThen((ports) => {
        if (this.#stopped) return okAsync(undefined);
        const wanted = new Set([
          ...ports.filter((p) => p.vendorId === ESPRESSIF_VENDOR_ID).map((p) => p.path),
          ...this.#options.extraPaths,
        ]);
        for (const path of wanted) {
          if (this.#serial.has(path)) continue;
          this.#serial.open(path).match(
            () => undefined,
            (error) => {
              // A `--serial` path that does not exist yet is opened when it appears.
              this.#options.failed(error);
            },
          );
        }
        return okAsync(undefined);
      });
  }
}
