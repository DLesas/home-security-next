/**
 * A stand-in for the hub on the lockstep socket, for testing the C++ side's socket handling
 * (tests/lockstep/socket_test.cpp): run as `bun fake_hub.ts --data <dir> --bench-lockstep
 * <socket>`, it connects, and answers each line with an `idle` written in 100-byte pieces with
 * pauses between them, so the controller gets every line in many reads. The answer to `start`
 * carries a record of 600,000 characters; every answer's `to` is the length of the line it
 * answers, so the controller sees whether its long line arrived whole.
 */
// A module, so it may await at the top level.
export {};

const socketPath = process.argv[process.argv.indexOf("--bench-lockstep") + 1] ?? "";
let buffer = "";
const pieces: string[] = [];
let writing = false;

function idle(to: number, big: boolean): string {
  const records = big
    ? [{ kind: "hubEvent", row: { code: "padding", message: "x".repeat(600_000), detail: null } }]
    : [];
  return `${JSON.stringify({ type: "idle", to, boot: 1, frames: [], closed: [], records, replies: [], wake: null })}\n`;
}

function send(socket: { write(data: string): number }): void {
  if (writing) return;
  writing = true;
  const next = (): void => {
    const piece = pieces.shift();
    if (piece === undefined) {
      writing = false;
      return;
    }
    const written = socket.write(piece);
    if (written < piece.length) pieces.unshift(piece.slice(written));
    setTimeout(next, 1);
  };
  next();
}

await Bun.connect({
  unix: socketPath,
  socket: {
    data(socket, data) {
      buffer += data.toString();
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const message = JSON.parse(line) as { type: string };
        if (message.type === "stop") process.exit(0);
        if (message.type !== "start" && message.type !== "advance") continue;
        const answer = idle(line.length, message.type === "start");
        for (let i = 0; i < answer.length; i += 100) pieces.push(answer.slice(i, i + 100));
        send(socket);
      }
    },
    close() {
      process.exit(0);
    },
  },
});
