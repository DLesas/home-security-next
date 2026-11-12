// Runtime-neutral checks: does each thing the hub needs load and work?
import crypto from "node:crypto";

export type Check = { name: string; ok: boolean; detail: string };

async function attempt(name: string, fn: () => Promise<string> | string): Promise<Check> {
  try {
    return { name, ok: true, detail: await fn() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name, ok: false, detail: msg.split("\n")[0].slice(0, 200) };
  }
}

// Minimal protobuf writer, enough to build a one-node ONNX model in memory.
function varint(n: number): number[] {
  const out: number[] = [];
  while (n > 127) { out.push((n & 127) | 128); n >>>= 7; }
  out.push(n);
  return out;
}
const fieldVarint = (field: number, v: number) => [...varint((field << 3) | 0), ...varint(v)];
const fieldBytes = (field: number, b: number[]) => [...varint((field << 3) | 2), ...varint(b.length), ...b];
const fieldStr = (field: number, s: string) => fieldBytes(field, [...Buffer.from(s, "utf8")]);

function identityModel(): Uint8Array {
  const dim = fieldBytes(1, fieldVarint(1, 4));                       // TensorShapeProto.dim { dim_value: 4 }
  const tensorType = [...fieldVarint(1, 1), ...fieldBytes(2, dim)];   // elem_type FLOAT, shape
  const typeProto = fieldBytes(1, tensorType);
  const valueInfo = (name: string) => [...fieldStr(1, name), ...fieldBytes(2, typeProto)];
  const node = [...fieldStr(1, "x"), ...fieldStr(2, "y"), ...fieldStr(4, "Identity")];
  const graph = [
    ...fieldBytes(1, node), ...fieldStr(2, "g"),
    ...fieldBytes(11, valueInfo("x")), ...fieldBytes(12, valueInfo("y")),
  ];
  const opset = fieldVarint(2, 13);
  return Uint8Array.from([...fieldVarint(1, 8), ...fieldBytes(7, graph), ...fieldBytes(8, opset)]);
}

export async function runChecks(): Promise<Check[]> {
  const checks: Check[] = [];

  checks.push(await attempt("AES-128-CCM, 8-byte tag (device packets)", () => {
    const key = crypto.randomBytes(16), nonce = crypto.randomBytes(13), aad = Buffer.from("hdr");
    const msg = Buffer.from("door open, counter 42");
    const enc = crypto.createCipheriv("aes-128-ccm", key, nonce, { authTagLength: 8 });
    enc.setAAD(aad, { plaintextLength: msg.length });
    const ct = Buffer.concat([enc.update(msg), enc.final()]);
    const tag = enc.getAuthTag();
    const dec = crypto.createDecipheriv("aes-128-ccm", key, nonce, { authTagLength: 8 });
    dec.setAuthTag(tag);
    dec.setAAD(aad, { plaintextLength: ct.length });
    const pt = Buffer.concat([dec.update(ct), dec.final()]);
    if (!pt.equals(msg)) throw new Error("round trip mismatch");
    // a flipped bit must be rejected
    const bad = crypto.createDecipheriv("aes-128-ccm", key, nonce, { authTagLength: 8 });
    const tampered = Buffer.from(ct); tampered[0] ^= 1;
    bad.setAuthTag(tag); bad.setAAD(aad, { plaintextLength: ct.length });
    let rejected = false;
    try { bad.update(tampered); bad.final(); } catch { rejected = true; }
    if (!rejected) throw new Error("tampered packet accepted");
    return `tag ${tag.length} bytes, tamper rejected`;
  }));

  checks.push(await attempt("ECDSA P-256 sign and verify (firmware signing)", () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const sig = crypto.sign("sha256", Buffer.from("image"), privateKey);
    if (!crypto.verify("sha256", Buffer.from("image"), publicKey, sig)) throw new Error("verify failed");
    return `signature ${sig.length} bytes`;
  }));

  checks.push(await attempt("Ed25519 verify (release signature)", () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    const sig = crypto.sign(null, Buffer.from("release"), privateKey);
    if (!crypto.verify(null, Buffer.from("release"), publicKey, sig)) throw new Error("verify failed");
    return "ok";
  }));

  checks.push(await attempt("X25519 and ChaCha20-Poly1305 (app channel)", () => {
    const a = crypto.generateKeyPairSync("x25519"), b = crypto.generateKeyPairSync("x25519");
    const s1 = crypto.diffieHellman({ privateKey: a.privateKey, publicKey: b.publicKey });
    const s2 = crypto.diffieHellman({ privateKey: b.privateKey, publicKey: a.publicKey });
    if (!s1.equals(s2)) throw new Error("shared secret mismatch");
    const c = crypto.createCipheriv("chacha20-poly1305", s1, crypto.randomBytes(12), { authTagLength: 16 });
    c.update("hi"); c.final();
    return "ok";
  }));

  checks.push(await attempt("mDNS advertise (bonjour-service)", async () => {
    const { Bonjour } = await import("bonjour-service");
    const bonjour = new Bonjour();
    const svc = bonjour.publish({ name: `s1-spike-${process.pid}`, type: "hsn-spike", port: 45999 });
    await new Promise((r) => setTimeout(r, 300));
    await new Promise<void>((r) => svc.stop?.(() => r()) ?? r());
    await new Promise<void>((r) => bonjour.destroy(() => r()));
    return "published and withdrawn";
  }));

  checks.push(await attempt("USB serial (serialport, native)", async () => {
    const { SerialPort } = await import("serialport");
    const ports = await SerialPort.list();
    return `native binding loaded, ${ports.length} port(s) listed`;
  }));

  checks.push(await attempt("ONNX Runtime (native), one inference", async () => {
    const ort = await import("onnxruntime-node");
    const session = await ort.InferenceSession.create(identityModel());
    const x = new ort.Tensor("float32", Float32Array.from([1, 2, 3, 4]), [4]);
    const out = await session.run({ x });
    const y = Array.from(out.y.data as Float32Array);
    if (y.join() !== "1,2,3,4") throw new Error(`unexpected output ${y.join()}`);
    return "identity model ran";
  }));

  checks.push(await attempt("WebGPU (Dawn bindings), adapter and compute shader", async () => {
    const { create } = await import("webgpu");
    const gpu = create([]);
    const adapter = await gpu.requestAdapter();
    if (!adapter) return "module loaded; no GPU adapter on this machine";
    const device = await adapter.requestDevice();
    const module = device.createShaderModule({ code: `
      @group(0) @binding(0) var<storage, read_write> d: array<f32>;
      @compute @workgroup_size(4) fn main(@builtin(global_invocation_id) id: vec3u) { d[id.x] = d[id.x] * 2.0; }` });
    const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
    const buf = device.createBuffer({ size: 16, usage: 0x80 | 0x04 | 0x08, mappedAtCreation: true }); // STORAGE|COPY_SRC|COPY_DST
    new Float32Array(buf.getMappedRange()).set([1, 2, 3, 4]); buf.unmap();
    const read = device.createBuffer({ size: 16, usage: 0x01 | 0x08 }); // MAP_READ|COPY_DST
    const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: buf } }] });
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(1); pass.end();
    enc.copyBufferToBuffer(buf, 0, read, 0, 16);
    device.queue.submit([enc.finish()]);
    await read.mapAsync(0x01);
    const out = Array.from(new Float32Array(read.getMappedRange()));
    const info = adapter.info;
    device.destroy();
    if (out.join() !== "2,4,6,8") throw new Error(`unexpected output ${out.join()}`);
    return `compute shader ran on ${info?.vendor ?? "?"} ${info?.architecture ?? ""} ${info?.device ?? ""}`.trim();
  }));

  return checks;
}
