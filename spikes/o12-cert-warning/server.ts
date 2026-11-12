// Serves the check page over HTTPS with a self-signed certificate (port 8443) and over plain HTTP (port 8080).
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const dir = import.meta.dir;
if (!existsSync(join(dir, "cert.pem"))) throw new Error("run make-cert.sh first");
const built = await Bun.build({ entrypoints: [join(dir, "page.ts")], target: "browser", minify: false });
if (!built.success) throw new Error(built.logs.join("\n"));
const pageJs = await built.outputs[0].text();
const html = await Bun.file(join(dir, "index.html")).text();

function handler(scheme: string) {
  return {
    async fetch(req: Request, server: { upgrade: (r: Request) => boolean }) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") return server.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
      if (url.pathname === "/") return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      if (url.pathname === "/page.js") return new Response(pageJs, { headers: { "content-type": "text/javascript", "cache-control": "no-store" } });
      if (url.pathname === "/sw.js") return new Response("self.addEventListener('fetch', () => {});", { headers: { "content-type": "text/javascript" } });
      if (url.pathname === "/echo") return new Response(await req.text());
      if (url.pathname === "/report") {
        const body = await req.text();
        appendFileSync(join(dir, "results.jsonl"), JSON.stringify({ scheme, ...JSON.parse(body) }) + "\n");
        console.log(`report received over ${scheme}`);
        return new Response("ok");
      }
      return new Response("not found", { status: 404 });
    },
    websocket: { message(ws: { send: (m: string) => void }, m: string | Buffer) { ws.send(String(m)); } },
  };
}

Bun.serve({ port: 8443, hostname: "0.0.0.0", tls: { key: Bun.file(join(dir, "key.pem")), cert: Bun.file(join(dir, "cert.pem")) }, ...handler("https") });
Bun.serve({ port: 8080, hostname: "0.0.0.0", ...handler("http") });
console.log("listening on https :8443 and http :8080");
