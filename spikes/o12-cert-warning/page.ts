// Runs in the browser. Each check is something the web app needs, or is recorded for information.
import { x25519 } from "@noble/curves/ed25519.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { sha256 } from "@noble/hashes/sha2.js";

type Result = { name: string; needed: boolean; ok: boolean; detail: string };
const results: Result[] = [];
async function check(name: string, needed: boolean, fn: () => Promise<string> | string) {
  try { results.push({ name, needed, ok: true, detail: await fn() }); }
  catch (e) { results.push({ name, needed, ok: false, detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }); }
}
const withTimeout = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms))]);

function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("o12", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("keys");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("keys", mode);
      const req = fn(tx.objectStore("keys"));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    };
  });
}

async function run() {
  await check("Random numbers (crypto.getRandomValues)", true, () => {
    const b = crypto.getRandomValues(new Uint8Array(32));
    if (b.every((x) => x === 0)) throw new Error("all zero");
    return "32 bytes";
  });

  await check("Key agreement and encryption in JavaScript (X25519, ChaCha20-Poly1305, SHA-256)", true, () => {
    const a = x25519.utils.randomSecretKey(), b = x25519.utils.randomSecretKey();
    const s1 = x25519.getSharedSecret(a, x25519.getPublicKey(b));
    const s2 = x25519.getSharedSecret(b, x25519.getPublicKey(a));
    if (s1.join() !== s2.join()) throw new Error("shared secrets differ");
    const key = sha256(s1), nonce = crypto.getRandomValues(new Uint8Array(12));
    const msg = new TextEncoder().encode("disarm");
    const sealed = chacha20poly1305(key, nonce).encrypt(msg);
    const opened = chacha20poly1305(key, nonce).decrypt(sealed);
    if (new TextDecoder().decode(opened) !== "disarm") throw new Error("round trip failed");
    return "round trip ok";
  });

  await check("Request to the hub (fetch, same address)", true, async () => {
    const r = await withTimeout(fetch("/echo", { method: "POST", body: "ping" }), 5000, "fetch");
    const t = await r.text();
    if (t !== "ping") throw new Error(`unexpected reply ${t}`);
    return "echo ok";
  });

  await check("Live connection to the hub (WebSocket, same address)", true, async () => {
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    const reply = await withTimeout(new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => ws.send("ping");
      ws.onmessage = (m) => { resolve(String(m.data)); ws.close(); };
      ws.onerror = () => reject(new Error("WebSocket error before any reply"));
    }), 5000, "WebSocket");
    if (reply !== "ping") throw new Error(`unexpected reply ${reply}`);
    return `echo ok over ${url.split(":")[0]}`;
  });

  await check("Store this browser's key (IndexedDB), and find it again after a reload", true, async () => {
    const existing = await withTimeout(idb<Uint8Array | undefined>("readonly", (s) => s.get("device-key")), 5000, "IndexedDB read");
    if (existing) return `key from an earlier visit found (${existing.length} bytes)`;
    await withTimeout(idb("readwrite", (s) => s.put(crypto.getRandomValues(new Uint8Array(32)), "device-key")), 5000, "IndexedDB write");
    const back = await idb<Uint8Array | undefined>("readonly", (s) => s.get("device-key"));
    if (!back || back.length !== 32) throw new Error("could not read the key back");
    return "first visit: key stored and read back";
  });

  await check("Small settings store (localStorage)", true, () => {
    const visits = Number(localStorage.getItem("o12-visits") ?? "0") + 1;
    localStorage.setItem("o12-visits", String(visits));
    return `visit number ${visits}`;
  });

  await check("Browser treats the page as secure (isSecureContext)", false, () => {
    if (!window.isSecureContext) throw new Error("isSecureContext is false");
    return "true";
  });

  await check("Camera interface present, for scanning a QR code", false, () => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("navigator.mediaDevices.getUserMedia is missing");
    return "present (permission not requested)";
  });

  await check("Browser's built-in crypto (crypto.subtle), not used by our design", false, async () => {
    if (!crypto.subtle) throw new Error("crypto.subtle is missing");
    const k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, k.privateKey, new Uint8Array(4));
    return "present and working";
  });

  await check("Service worker, not used by our design", false, async () => {
    if (!("serviceWorker" in navigator)) throw new Error("navigator.serviceWorker is missing");
    const reg = await withTimeout(navigator.serviceWorker.register("/sw.js"), 5000, "registration");
    await reg.unregister();
    return "registered";
  });

  await check("Clipboard interface, for copying a linking code", false, () => {
    if (!navigator.clipboard?.writeText) throw new Error("navigator.clipboard is missing");
    return "present";
  });

  const report = { at: new Date().toISOString(), url: location.origin, userAgent: navigator.userAgent, results };
  const list = document.getElementById("results")!;
  for (const r of results) {
    const li = document.createElement("li");
    li.textContent = `${r.ok ? "PASS" : "FAIL"}${r.needed ? "" : " (not needed)"}: ${r.name} — ${r.detail}`;
    li.className = r.ok ? "pass" : r.needed ? "fail" : "info";
    list.appendChild(li);
  }
  const neededFailed = results.filter((r) => r.needed && !r.ok).length;
  document.getElementById("verdict")!.textContent = neededFailed === 0
    ? "Everything the web app needs works here."
    : `${neededFailed} needed check(s) failed here.`;
  try { await fetch("/report", { method: "POST", body: JSON.stringify(report) }); document.getElementById("sent")!.textContent = "Result sent to the test server."; }
  catch { document.getElementById("sent")!.textContent = "Could not send the result to the test server."; }
}
run();
