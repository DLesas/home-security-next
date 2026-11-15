/**
 * The two app listeners on real loopback sockets (m2-design.md section 5, "Listeners" and
 * "Defences"; section 10, "Shell tests": TLS, loopback only, `Host` and `Origin`, headers,
 * limits): HTTPS with the hub's own certificate on the home network's port, plain HTTP on
 * 127.0.0.1 only for the console, 421 for a foreign `Host`, 403 for a foreign `Origin`, the
 * content security policy from the build's `csp.json` on every response, files only by `GET` and
 * `HEAD` and only inside the build, text messages and oversized messages closing the socket.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { connect as tlsConnect } from "node:tls";
import { join } from "node:path";
import { contentSecurityPolicy, EMPTY_STYLE_HASH, webCspFile } from "@hsn/protocol/app";
import { homeAddresses } from "../../../src/shell/hub-facts.ts";
import { CLOSE } from "../../../src/shell/app/channel.ts";
import { loadPolicy } from "../../../src/shell/app/policy.ts";
import { expectNoKeyLeaks } from "../setup/support/leak-guard.ts";
import {
  openHub,
  rawRequest,
  stopHubs,
  TEST_POLICY,
  upgradeLines,
  webBuild,
  WsClient,
} from "./support.ts";

let web: string;

beforeAll(async () => {
  web = mkdtempSync(join(tmpdir(), "hsn-a2-web-"));
  await webBuild(web);
});

afterEach(() => {
  stopHubs();
});

afterAll(() => {
  rmSync(web, { recursive: true, force: true });
  expectNoKeyLeaks();
});

function get(path: string, host: string): readonly string[] {
  return [`GET ${path} HTTP/1.1`, `Host: ${host}`, "Connection: close"];
}

describe("the home network's listener", () => {
  test("serves HTTPS with the hub's own certificate, and nothing in plain HTTP", async () => {
    const side = openHub({ webRoot: web });
    const peer = await new Promise<Uint8Array>((resolve, reject) => {
      const socket = tlsConnect(
        { host: "127.0.0.1", port: side.lanPort, rejectUnauthorized: false },
        () => {
          resolve(new Uint8Array(socket.getPeerCertificate(true).raw));
          socket.destroy();
        },
      );
      socket.on("error", reject);
    });
    expect(Buffer.from(peer).equals(Buffer.from(side.tls.certificate))).toBe(true);
    // Plain HTTP to the TLS port gets no HTTP answer.
    const plain = await new Promise<string>((resolve) => {
      const socket = netConnect({ host: "127.0.0.1", port: side.lanPort }, () => {
        socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${side.lanPort}\r\n\r\n`);
      });
      let text = "";
      socket.on("data", (chunk: Buffer) => {
        text += chunk.toString("latin1");
      });
      socket.on("close", () => {
        resolve(text);
      });
      socket.on("error", () => {
        resolve(text);
      });
    });
    expect(plain.startsWith("HTTP/1.1 200")).toBe(false);
  });

  test("a client that trusts the certificate verifies it for the hub's address", async () => {
    const side = openHub({ webRoot: web });
    const authorized = await new Promise<boolean>((resolve) => {
      const socket = tlsConnect(
        {
          host: "127.0.0.1",
          port: side.lanPort,
          ca: `-----BEGIN CERTIFICATE-----\n${Buffer.from(side.tls.certificate).toString("base64")}\n-----END CERTIFICATE-----\n`,
        },
        () => {
          resolve(socket.authorized);
          socket.destroy();
        },
      );
      socket.on("error", () => {
        resolve(false);
      });
    });
    expect(authorized).toBe(true);
  });
});

describe("the console's listener", () => {
  test("listens on 127.0.0.1 only", async () => {
    const side = openHub({ webRoot: web });
    const ok = await rawRequest(side.consolePort, false, get("/", `127.0.0.1:${side.consolePort}`));
    expect(ok.status).toBe(200);
    const other = homeAddresses().find((a) => !a.includes(":"));
    if (other === undefined) return;
    const reached = await new Promise<boolean>((resolve) => {
      const socket = netConnect({ host: other, port: side.consolePort }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => {
        resolve(false);
      });
    });
    expect(reached).toBe(false);
  });
});

describe("Host", () => {
  test.each([
    ["lan", true],
    ["console", false],
  ] as const)(
    "on the %s listener, a foreign name or port is 421, its own names are not",
    async (listener, tls) => {
      const side = openHub({ webRoot: web });
      const port = listener === "lan" ? side.lanPort : side.consolePort;
      const good =
        listener === "lan"
          ? [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]
          : [`127.0.0.1:${port}`, `localhost:${port}`];
      for (const host of good)
        expect((await rawRequest(port, tls, get("/", host))).status).toBe(200);
      for (const host of [
        `evil.example:${port}`,
        `127.0.0.1:${port + 1}`,
        "127.0.0.1",
        `10.9.9.9:${port}`,
        "",
      ]) {
        const answer = await rawRequest(port, tls, get("/", host));
        expect(answer.status).toBe(421);
        expect(answer.headers["content-security-policy"]).toBe(TEST_POLICY);
      }
      // The upgrade is refused by Host before Origin is looked at.
      const upgrade = await rawRequest(
        port,
        tls,
        upgradeLines(`evil.example:${port}`, `http://evil.example:${port}`),
      );
      expect(upgrade.status).toBe(421);
    },
  );
});

describe("Origin", () => {
  test.each([
    ["lan", true, "https"],
    ["console", false, "http"],
  ] as const)(
    "on the %s listener, only the listener's own origin may open the channel",
    async (listener, tls, scheme) => {
      const side = openHub({ webRoot: web });
      const port = listener === "lan" ? side.lanPort : side.consolePort;
      const host = `127.0.0.1:${port}`;
      for (const origin of [
        undefined,
        "null",
        `https://evil.example`,
        `${scheme === "https" ? "http" : "https"}://${host}`,
        `${scheme}://localhost:${port}`,
        `${scheme}://${host}.evil`,
      ]) {
        const refused = await rawRequest(port, tls, upgradeLines(host, origin));
        expect(refused.status).toBe(403);
        expect(refused.headers["content-security-policy"]).toBe(TEST_POLICY);
      }
      const upgraded = await rawRequest(port, tls, upgradeLines(host, `${scheme}://${host}`));
      expect(upgraded.status).toBe(101);
      expect(upgraded.headers["content-security-policy"]).toBe(TEST_POLICY);
    },
  );
});

describe("the files", () => {
  test("every response carries the policy and the other headers, and no cookie", async () => {
    const side = openHub({ webRoot: web });
    const host = `127.0.0.1:${side.consolePort}`;
    for (const path of ["/", "/_expo/static/js/web/entry-1.js", "/missing.js", "/people"]) {
      const answer = await rawRequest(side.consolePort, false, get(path, host));
      expect(answer.headers["content-security-policy"]).toBe(TEST_POLICY);
      expect(answer.headers["x-content-type-options"]).toBe("nosniff");
      expect(answer.headers["referrer-policy"]).toBe("no-referrer");
      expect(answer.headers["set-cookie"]).toBeUndefined();
    }
  });

  test("a route of the app gets index.html; a missing file or a path out of the folder is 404", async () => {
    const side = openHub({ webRoot: web });
    const host = `127.0.0.1:${side.consolePort}`;
    const route = await rawRequest(side.consolePort, false, get("/people/2", host));
    expect(route.status).toBe(200);
    expect(route.headers["content-type"]).toContain("text/html");
    const script = await rawRequest(
      side.consolePort,
      false,
      get("/_expo/static/js/web/entry-1.js", host),
    );
    expect(script.headers["content-type"]).toContain("text/javascript");
    for (const path of [
      "/missing.js",
      "/../../etc/hosts.js",
      "/%2e%2e/%2e%2e/etc/hosts.js",
      "/a/../../x.js",
      "//etc/passwd",
      "/.%2fx.js",
      "/x%00.js",
    ]) {
      expect((await rawRequest(side.consolePort, false, get(path, host))).status).toBe(404);
    }
    // A path that climbs is a route of the app inside the folder, never a file outside it.
    for (const path of ["/../../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd"]) {
      const answer = await rawRequest(side.consolePort, false, get(path, host), "127.0.0.1", true);
      expect(answer.text).toContain("<title>hsn</title>");
    }
  });

  test("only GET and HEAD reach the files", async () => {
    const side = openHub({ webRoot: web });
    const host = `127.0.0.1:${side.consolePort}`;
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
      const answer = await rawRequest(side.consolePort, false, [
        `${method} / HTTP/1.1`,
        `Host: ${host}`,
        "Content-Length: 0",
        "Connection: close",
      ]);
      expect(answer.status).toBe(405);
    }
    const head = await rawRequest(side.consolePort, false, [
      `HEAD / HTTP/1.1`,
      `Host: ${host}`,
      "Connection: close",
    ]);
    expect(head.status).toBe(200);
  });

  test("the policy is the build's csp.json, made by contentSecurityPolicy", () => {
    const policy = loadPolicy(web)._unsafeUnwrap();
    expect(policy).toBe(
      contentSecurityPolicy(webCspFile.parse({ styles: [EMPTY_STYLE_HASH], scripts: [] })),
    );
    expect(policy).toContain(`style-src 'self' ${EMPTY_STYLE_HASH}`);
    expect(policy).toContain("frame-ancestors 'none'");
  });

  test("a csp.json that is not the schema's is refused, so the build is not served under another policy", async () => {
    const broken = mkdtempSync(join(tmpdir(), "hsn-a2-bad-"));
    await Bun.write(
      join(broken, "csp.json"),
      JSON.stringify({ styles: ["'unsafe-inline'"], scripts: [] }),
    );
    expect(loadPolicy(broken).isErr()).toBe(true);
    rmSync(broken, { recursive: true, force: true });
  });
});

describe("the channel's framing", () => {
  test("a text message closes the socket", async () => {
    const side = openHub();
    const ws = await WsClient.open(side, "console");
    ws.sendText("hello");
    expect((await ws.waitClosed())?.code).toBe(CLOSE.unsupportedData);
  });

  test("a message over 65,535 bytes closes the socket", async () => {
    const side = openHub();
    const ws = await WsClient.open(side, "console");
    ws.send(new Uint8Array(65_536));
    expect((await ws.waitClosed())?.code).toBeDefined();
    expect(side.events).toEqual([]);
  });
});

describe("a new certificate", () => {
  test("is served on the same port to new connections; open sessions stay open", async () => {
    const { makeCertificate } = await import("../../../src/shell/app/certificate.ts");
    const { noteKey } = await import("../setup/support/leak-guard.ts");
    const side = openHub({ webRoot: web });
    const names = { dns: ["localhost"], ips: ["127.0.0.1", "192.168.50.5"] };
    const ws = await WsClient.open(side, "lan");
    const next = makeCertificate(names, Date.now(), new Uint8Array(16).fill(5))._unsafeUnwrap();
    noteKey(next.privateKey);
    expect(side.listeners.useCertificate(next, names).isOk()).toBe(true);
    expect(side.listeners.lanPort).toBe(side.lanPort);
    const peer = await new Promise<Uint8Array>((resolve, reject) => {
      const socket = tlsConnect(
        { host: "127.0.0.1", port: side.lanPort, rejectUnauthorized: false },
        () => {
          resolve(new Uint8Array(socket.getPeerCertificate(true).raw));
          socket.destroy();
        },
      );
      socket.on("error", reject);
    });
    expect(Buffer.from(peer).equals(Buffer.from(next.certificate))).toBe(true);
    // The new address is now a name the listener answers to.
    const host = `192.168.50.5:${side.lanPort}`;
    expect((await rawRequest(side.lanPort, true, get("/", host))).status).toBe(200);
    expect(ws.closedWith).toBeUndefined();
  });
});
