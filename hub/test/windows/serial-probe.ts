/** Native W1 probe: the production adapter opens a Windows COM port and gives it back twice. */
import { once } from "node:events";
import { closeTty, openTty } from "../../src/shell/safe/serial.ts";

const path = process.argv[2] ?? "";
for (let attempt = 0; attempt < 2; attempt++) {
  const port = openTty(path)._unsafeUnwrap();
  if ("fd" in port) {
    console.error("This probe needs the Windows COM adapter");
    process.exit(1);
  }
  const ready = await Promise.race([
    once(port.stream, "ready").then(() => true),
    Bun.sleep(5000).then(() => false),
  ]);
  closeTty(port)._unsafeUnwrap();
  await port.closed;
  if (!ready) {
    console.error(`The COM worker did not start for ${path}`);
    process.exit(1);
  }
  console.log(
    `${path}: open ${attempt + 1}, byte-clean DCB read back, worker stopped and handle closed`,
  );
}
