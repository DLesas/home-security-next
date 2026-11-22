// Spike S5, step 3: the lock screen's Disarm, from JavaScript started in the background. Throwaway.
//
// `disarm {target: "mine"}` as `first` of an IK session through the relay's phone path, one and a
// half round trips (m2-design section 5, m4-design section 3), with the protocol package's own Noise,
// as `hub/test/relay/phone.ts`'s `disarmFirst` does it. Every step is journaled with its time.
import {
  clientHello,
  hubHello,
  NOISE_PATTERNS,
  parseIdentity,
  sessionPrologue,
  startHandshake,
  x25519StaticKey,
} from "@hsn/protocol/app";
import { phoneStreamUrl } from "@hsn/protocol/relay";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const encodeJson = (v) => encoder.encode(JSON.stringify(v));
const decodeJson = (b) => {
  try {
    return JSON.parse(decoder.decode(b));
  } catch {
    return undefined;
  }
};

function fromBase64(text) {
  const bin = globalThis.atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A queue of a socket's messages, with a deadline per read. */
function inbox(socket) {
  const queue = [];
  const waiting = [];
  let closed;
  socket.onmessage = (e) => {
    const item = { kind: "message", data: new Uint8Array(e.data) };
    const w = waiting.shift();
    if (w) w(item);
    else queue.push(item);
  };
  socket.onclose = (e) => {
    closed = { kind: "closed", code: e.code };
    for (const w of waiting.splice(0)) w(closed);
  };
  return (ms) =>
    new Promise((resolve) => {
      if (queue.length > 0) return resolve(queue.shift());
      if (closed) return resolve(closed);
      const timer = setTimeout(() => resolve({ kind: "timeout" }), ms);
      waiting.push((item) => {
        clearTimeout(timer);
        resolve(item);
      });
    });
}

/**
 * Disarms through the relay. `p` is the scene's provisioning (the phone's record); `seq` the
 * next `seq`, already written. `mark(step, detail)` journals each step.
 */
export async function disarmFirst(p, seq, mark) {
  const identity = parseIdentity(p.identity);
  if (identity === undefined) return { failed: "identity" };
  const secret = fromBase64(p.clientPrivate);
  const key = x25519StaticKey(secret);
  if (!key.ok) return { failed: "client key" };
  const first = { t: "req", id: 1, seq, op: "disarm", body: { target: "mine" } };
  const hello = clientHello.parse({ proto: [2, 2], app: "2.0.0", first });
  const started = startHandshake({
    pattern: NOISE_PATTERNS.session,
    initiator: true,
    prologue: sessionPrologue(identity),
    staticKey: { publicKey: fromBase64(p.clientPublic), dh: (theirs) => key.value.dh(theirs) },
    remoteStatic: fromBase64(p.hubStatic),
  });
  if (!started.ok) return { failed: "handshake" };
  const m1 = await started.value.writeMessage(encodeJson(hello));
  if (!m1.ok) return { failed: "message 1" };
  mark("js.message1");
  const url = phoneStreamUrl(p.relayUrl, { identity: p.identity, path: "session" });
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  const next = inbox(socket);
  const opened = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 10_000);
    socket.onopen = () => {
      clearTimeout(timer);
      resolve(true);
    };
    socket.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
  });
  if (!opened) return { failed: "socket" };
  mark("js.socketOpen");
  socket.send(m1.value.slice().buffer);
  const second = await next(10_000);
  if (second.kind !== "message") return { failed: `message 2: ${second.kind}` };
  mark("js.message2");
  const read = await started.value.readMessage(second.data);
  const back = read.ok ? hubHello.safeParse(decodeJson(read.value)) : undefined;
  const transport = started.value.split();
  if (back?.success !== true || !transport.ok) {
    socket.close();
    return { failed: "hub hello" };
  }
  const companion = transport.value.encrypt(encodeJson({ t: "req", id: 2, op: "pong", body: {} }));
  if (!companion.ok) return { failed: "companion" };
  socket.send(companion.value.slice().buffer);
  mark("js.companionSent");
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    const m = await next(Math.max(1, end - Date.now()));
    if (m.kind !== "message") break;
    const o = transport.value.decrypt(m.data);
    const frame = o.ok ? decodeJson(o.value) : undefined;
    if (frame?.t === "res" && frame.id === 1) {
      mark("js.reply", { ok: frame.ok === true, disarmed: frame.body?.disarmed ?? null });
      socket.close(1000);
      return { reply: frame };
    }
  }
  socket.close(1000);
  return { failed: "no reply to first" };
}
