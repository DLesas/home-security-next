/**
 * Tokens, linking, invites and expiry (m2-design.md section 5, "Linking"; D61, D62, D99, D120,
 * D121): owner A3's step 2.
 */
import { describe, expect, test } from "bun:test";
import { nodeSha256 } from "@hsn/protocol";
import {
  LINKING,
  parseLinkFragment,
  parseLinkQr,
  parseTypedCode,
  secretLookup,
  secretPsk,
  typedLookup,
  typedPsk,
} from "@hsn/protocol/app";
import { connId, tokenId } from "../../../src/core/model/ids.ts";
import { ClientKind, type LinkTokenRow, TokenKind } from "../../../src/core/model/rows.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import { mono } from "../../../src/core/model/time.ts";
import {
  ANNA,
  ANNA_LAPTOP,
  BEN,
  BEN_LAPTOP,
  bodyOf,
  codeOf,
  Committed,
  CONSOLE_CLIENT,
  decisionsOf,
  entropy,
  household,
  Hub,
  linkResults,
  linkSecrets,
  MINUTE,
  FACTS,
  nowWrites,
  onlyReply,
  role,
  SECOND,
  WALL_AT_START,
  writesTo,
  containsAll,
  client,
} from "./support/hub.ts";
import { HUB_DEVICE, bootId } from "../../../src/core/model/ids.ts";

const SECRET = new Uint8Array(16).map((_, i) => 0xc0 + i);

function booted(h = household()): Hub {
  const hub = new Hub();
  hub.boot(h);
  return hub;
}

function linkCreate(
  hub: Hub,
  client = ANNA_LAPTOP,
  body: Parameters<typeof makeBody>[0] = {},
  bytes = entropy(SECRET),
) {
  const conn = hub.connect(client);
  const { effects } = hub.request(
    conn,
    client,
    { op: "link.create", body: makeBody(body) },
    { bytes },
  );
  return { conn, effects, reply: onlyReply(effects, conn) };
}

/** `hsn op link.create` for a new person, as the installer runs it: the code's lifetime. */
function computerCode(hub: Hub): unknown {
  const effects = hub.command({
    kind: "op",
    operation: { op: "link.create", body: { kind: { newPerson: {} }, form: "code" } },
  });
  const respond = effects.find((e) => e.kind === "respond");
  const result = respond?.kind === "respond" && respond.reply.ok ? respond.reply.result : undefined;
  return result?.kind === "op" ? (result.body as { expiresInMs?: number }).expiresInMs : undefined;
}

function makeBody(options: {
  readonly kind?: "ownDevice" | { readonly newPerson: { readonly name?: string } };
  readonly form?: "qr" | "code" | "url";
  readonly invite?: boolean;
}) {
  return {
    kind: options.kind ?? { newPerson: { name: "Cleo" } },
    form: options.form ?? "qr",
    ...(options.invite === undefined ? {} : { invite: options.invite }),
  };
}

const STATIC_KEY = new Uint8Array(32).fill(0x77);
let nextLinkConn = 900;

function complete(
  hub: Hub,
  token: number,
  options: {
    readonly listener?: "lan" | "console";
    readonly key?: Uint8Array;
    readonly person?: string;
  } = {},
) {
  const conn = connId(nextLinkConn++);
  const effects = hub.input({
    kind: "linkCompleted",
    conn,
    token: tokenId(token),
    staticKey: options.key ?? STATIC_KEY,
    listener: options.listener ?? "lan",
    link: {
      name: "Cleo's laptop",
      kind: "web",
      ...(options.person === undefined ? {} : { person: { name: options.person } }),
    },
  });
  return { conn, effects };
}

describe("making a token (section 5)", () => {
  test("a QR code carries a 128-bit secret; the shell gets its key, the row its lookup", () => {
    const hub = booted();
    const { effects, reply } = linkCreate(hub);
    const body = bodyOf(reply);
    expect(body).toMatchObject({ token: 1, expiresInMs: DEFAULT_RULES.people.appCodeExpiryMs });
    const qr = parseLinkQr(String(body.qr));
    expect(qr?.secret).toEqual(SECRET);
    expect(qr?.addresses).toEqual(FACTS.addresses);
    expect(qr?.fingerprint).toEqual(FACTS.certificateSha256);
    expect(qr?.port).toBe(8444);
    const secret = linkSecrets(effects);
    expect(secret).toEqual([
      {
        kind: "linkSecret",
        token: tokenId(1),
        purpose: "link",
        // The person's name was given, so message 2 asks for none (step 1, wave 2).
        askName: false,
        lookup: secretLookup(nodeSha256, SECRET),
        psk: secretPsk(nodeSha256, SECRET),
      },
    ]);
    const row = writesTo(effects, "link_tokens")[0];
    const stored = row?.op === "upsert" && row.table === "link_tokens" ? row.row : undefined;
    expect(stored?.typed).toBe(false);
    expect(Buffer.from(stored?.lookup ?? []).toString("hex")).toBe(
      secretLookup(nodeSha256, SECRET),
    );
    expect(stored?.kind).toBe(TokenKind.NewPerson);
    expect(stored?.createdByClient).toBe(ANNA_LAPTOP);
    // Written now, before the code is shown (section 3).
    containsAll(
      nowWrites(effects).map((op) => op.table),
      ["link_tokens", "link_secrets"],
    );
  });

  test("a link address carries the identity and the secret in its fragment", () => {
    const hub = booted();
    const { reply } = linkCreate(hub, ANNA_LAPTOP, { form: "url" });
    const url = String(bodyOf(reply).url);
    expect(url.startsWith(`https://${FACTS.addresses[0]}:8444/#`)).toBe(true);
    expect(parseLinkFragment(url.split("#")[1] ?? "")?.secret).toEqual(SECRET);
  });

  test("a typed code: token id and 35-bit secret from the entropy; its lookup is the token id", () => {
    const hub = booted();
    // Token id bytes 0x0a 0xbc 0xde → 0xabcde; secret bytes, top 5 bits cleared.
    const bytes = entropy([0x0a, 0xbc, 0xde], [0xff, 1, 2, 3, 4]);
    const { effects, reply } = linkCreate(hub, ANNA_LAPTOP, { form: "code" }, bytes);
    const code = String(bodyOf(reply).code);
    expect(code).toMatch(/^[0-9A-Z*~$=]{4}-[0-9A-Z*~$=]{4}-[0-9A-Z*~$=]{4}$/u);
    const parsed = parseTypedCode(code);
    expect(parsed?.tokenId).toBe(0xabcde);
    expect(parsed?.secret).toBe(0x07_0102_0304n);
    expect(linkSecrets(effects)[0]?.psk).toEqual(typedPsk(nodeSha256, 0x07_0102_0304n));
    const row = writesTo(effects, "link_tokens")[0];
    const stored = row?.op === "upsert" && row.table === "link_tokens" ? row.row : undefined;
    expect(stored?.typed).toBe(true);
    expect(new TextDecoder().decode(stored?.lookup)).toBe(typedLookup(0xabcde));
  });

  test("a typed code's token id is chosen among those not in use", () => {
    const hub = booted();
    const same = entropy([0x0a, 0xbc, 0xde], [1, 1, 1, 1, 1], [0x01, 0x02, 0x03], [2, 2, 2, 2, 2]);
    linkCreate(hub, ANNA_LAPTOP, { form: "code" }, same);
    const second = linkCreate(hub, ANNA_LAPTOP, { form: "code" }, same);
    expect(parseTypedCode(String(bodyOf(second.reply).code))?.tokenId).toBe(0x10203);
  });

  test("lifetimes: 24 hours for an invite, 10 minutes for any other code but the installer's first", () => {
    const hub = booted();
    expect(bodyOf(linkCreate(hub, ANNA_LAPTOP, { invite: true }).reply).expiresInMs).toBe(
      DEFAULT_RULES.people.inviteExpiryMs,
    );
    expect(computerCode(hub)).toBe(DEFAULT_RULES.people.appCodeExpiryMs);
  });

  test("the installer's first code (the hub computer's, while the hub has no person) lasts 7 days", () => {
    const hub = booted(household({ people: [], clients: [client(1, null)] }));
    expect(computerCode(hub)).toBe(DEFAULT_RULES.people.installerCodeExpiryMs);
  });

  test("a new person needs manage users; another device of one's own does not", () => {
    const hub = booted(
      household({ userManagement: true, roles: [role(ANNA, true, true), role(BEN, false, false)] }),
    );
    expect(codeOf(linkCreate(hub, BEN_LAPTOP).reply)).toBe("unauthorized");
    const own = linkCreate(hub, BEN_LAPTOP, { kind: "ownDevice" });
    expect(codeOf(own.reply)).toBe("ok");
    const row = writesTo(own.effects, "link_tokens")[0];
    expect(row?.op === "upsert" && row.table === "link_tokens" ? row.row.personId : undefined).toBe(
      BEN,
    );
  });

  test("the console belongs to no person: it has no own device to link", () => {
    const hub = booted();
    const conn = hub.connect(CONSOLE_CLIENT, "console");
    const reply = onlyReply(
      hub.request(conn, CONSOLE_CLIENT, {
        op: "link.create",
        body: { kind: "ownDevice", form: "code" },
      }).effects,
      conn,
    );
    expect(reply.ok ? undefined : reply.error.code).toBe("invalid");
  });

  test("before the shell's facts a QR code cannot be made (unavailable); a typed code can", () => {
    const hub = new Hub();
    hub.boot(household(), 1, false);
    expect(codeOf(linkCreate(hub).reply)).toBe("unavailable");
    expect(hub.state.people.tokens.size).toBe(0);
    expect(codeOf(linkCreate(hub, ANNA_LAPTOP, { form: "code" }).reply)).toBe("ok");
  });
});

describe("spending a token (D121: works once, no approval)", () => {
  test("a valid code links at once: person and client made, token void, all written now", () => {
    const hub = booted();
    linkCreate(hub);
    const { conn, effects } = complete(hub, 1);
    const client = hub.state.people.clients.get(10 as never);
    expect(client).toMatchObject({
      name: "Cleo's laptop",
      kind: ClientKind.Web,
      linkedByClient: ANNA_LAPTOP,
    });
    expect(hub.state.people.people.get(3 as never)?.name).toBe("Cleo");
    expect(hub.state.people.tokens.size).toBe(0);
    expect(linkSecrets(effects)).toEqual([
      {
        kind: "linkSecret",
        token: tokenId(1),
        purpose: "link",
        askName: false,
        lookup: null,
        psk: null,
      },
    ]);
    const tables = nowWrites(effects).map((op) => op.table);
    containsAll(tables, ["people", "clients", "link_tokens", "link_secrets"]);
    const used = writesTo(effects, "link_tokens")[0];
    expect(
      used?.op === "upsert" && used.table === "link_tokens" ? used.row.usedMs : null,
    ).not.toBeNull();
    containsAll(
      decisionsOf(effects).map((d) => d.row.kind),
      ["person_added", "client_linked"],
    );
    expect(linkResults(effects)).toEqual([
      { kind: "linkResult", conn, result: { client: 10, person: 3 } },
    ]);
  });

  test("the same code a second time is refused: no client, no LinkResult", () => {
    const hub = booted();
    linkCreate(hub);
    complete(hub, 1);
    const clients = hub.state.people.clients.size;
    const second = complete(hub, 1, { key: new Uint8Array(32).fill(0x78) });
    expect(hub.state.people.clients.size).toBe(clients);
    expect(linkResults(second.effects)).toEqual([]);
  });

  test("another device of one's own joins its person, with no new person", () => {
    const hub = booted();
    linkCreate(hub, BEN_LAPTOP, { kind: "ownDevice" });
    const { effects } = complete(hub, 1);
    expect(linkResults(effects)[0]?.result).toEqual({ client: 10, person: BEN });
    expect(hub.state.people.people.size).toBe(2);
  });

  test("a new person takes the name the new client gives when the maker gave none", () => {
    const hub = booted();
    linkCreate(hub, ANNA_LAPTOP, { kind: { newPerson: {} } });
    complete(hub, 1, { person: "Dora" });
    expect(hub.state.people.people.get(3 as never)?.name).toBe("Dora");
  });

  test("a static key that is already a client's is refused", () => {
    const hub = booted();
    linkCreate(hub);
    complete(hub, 1, { key: new Uint8Array(32).fill(9) });
    expect(hub.state.people.clients.size).toBe(4);
    expect(hub.state.people.tokens.size).toBe(1);
  });

  test("a typed code is void after 5 failed tries; 4 leave it usable", () => {
    const hub = booted();
    linkCreate(hub, ANNA_LAPTOP, { form: "code" }, entropy([1, 2, 3], [1, 2, 3, 4, 5]));
    for (let i = 0; i < DEFAULT_RULES.people.typedMaxFailures - 1; i++)
      hub.input({
        kind: "linkFailed",
        token: tokenId(1),
        reason: "badPsk",
        address: "192.168.1.30",
      });
    expect(hub.state.people.tokens.get(tokenId(1))?.row.failures).toBe(4);
    const last = hub.input({
      kind: "linkFailed",
      token: tokenId(1),
      reason: "badPsk",
      address: "192.168.1.30",
    });
    expect(hub.state.people.tokens.size).toBe(0);
    expect(linkSecrets(last)).toEqual([
      {
        kind: "linkSecret",
        token: tokenId(1),
        purpose: "link",
        askName: false,
        lookup: null,
        psk: null,
      },
    ]);
    complete(hub, 1);
    expect(hub.state.people.clients.size).toBe(4);
  });

  test("a 128-bit token has no limit on failed tries", () => {
    const hub = booted();
    linkCreate(hub);
    for (let i = 0; i < 20; i++)
      hub.input({
        kind: "linkFailed",
        token: tokenId(1),
        reason: "badPsk",
        address: "192.168.1.30",
      });
    expect(hub.state.people.tokens.size).toBe(1);
  });

  test("a token expires on the monotonic clock: void at 10 minutes, refused after", () => {
    const hub = booted();
    linkCreate(hub);
    hub.advance(10 * 60 * 1000 - 1);
    expect(hub.state.people.tokens.size).toBe(1);
    const expired = hub.advance(1);
    expect(hub.state.people.tokens.size).toBe(0);
    expect(linkSecrets(expired)[0]?.psk).toBeNull();
    complete(hub, 1);
    expect(hub.state.people.clients.size).toBe(4);
  });

  test("link.cancel: by its maker or with manage users; void at once", () => {
    const hub = booted(
      household({
        userManagement: true,
        roles: [role(ANNA, false, false), role(BEN, false, false)],
      }),
    );
    const own = linkCreate(hub, ANNA_LAPTOP, { kind: "ownDevice" });
    const token = Number(bodyOf(own.reply).token);
    const ben = hub.connect(BEN_LAPTOP);
    expect(
      codeOf(
        onlyReply(
          hub.request(ben, BEN_LAPTOP, { op: "link.cancel", body: { token } }).effects,
          ben,
        ),
      ),
    ).toBe("unauthorized");
    const anna = hub.connect(ANNA_LAPTOP);
    const { effects } = hub.request(anna, ANNA_LAPTOP, { op: "link.cancel", body: { token } });
    expect(codeOf(onlyReply(effects, anna))).toBe("ok");
    expect(linkSecrets(effects)[0]?.psk).toBeNull();
    expect(hub.state.people.tokens.size).toBe(0);
  });
});

describe("the console's token (section 5, `hsn open`)", () => {
  test("hsn open gets a 2-minute 128-bit token as the console's address", () => {
    const hub = booted();
    const effects = hub.command({ kind: "consoleToken" }, entropy(SECRET));
    const respond = effects.find((e) => e.kind === "respond");
    const result =
      respond?.kind === "respond" && respond.reply.ok ? respond.reply.result : undefined;
    expect(result).toMatchObject({ kind: "consoleToken", expiresInMs: 2 * 60 * 1000 });
    expect(result?.kind === "consoleToken" ? result.url : "").toBe(
      `http://127.0.0.1:8445/#console=${Buffer.from(SECRET).toString("base64url")}`,
    );
    expect(linkSecrets(effects)[0]?.psk).toEqual(secretPsk(nodeSha256, SECRET));
  });

  test("it links a console client on the console listener only", () => {
    const hub = booted();
    hub.command({ kind: "consoleToken" }, entropy(SECRET));
    complete(hub, 1, { listener: "lan" });
    expect(hub.state.people.clients.size).toBe(4);
    const { effects } = complete(hub, 1, { listener: "console" });
    expect(linkResults(effects)[0]?.result).toEqual({ client: 10, person: null });
    expect(hub.state.people.clients.get(10 as never)?.kind).toBe(ClientKind.Console);
  });
});

describe('tokens across a restart (section 5, "Expiry and an untrusted clock")', () => {
  function token(createdMono: number, expiresAfterMs: number): LinkTokenRow {
    return {
      id: tokenId(5),
      lookup: new Uint8Array([1, 2, 3, 4]),
      kind: TokenKind.NewPerson,
      personId: null,
      personName: null,
      createdByClient: ANNA_LAPTOP,
      createdBoot: bootId(1),
      createdMono: mono(createdMono),
      expiresAfterMs,
      typed: false,
      failures: 0,
      usedMs: null,
    };
  }

  /** The last commit of boot 1 was 4 minutes after the token was made, 1 s before this start. */
  function restart(trusted: boolean) {
    const markWall = WALL_AT_START;
    const snapshot = household({
      linkTokens: [token(SECOND, 10 * 60 * 1000)],
      deviceState: [
        {
          deviceId: HUB_DEVICE,
          boot: bootId(1),
          lastSeenMono: mono(SECOND + 4 * MINUTE),
          lastSeenMs: markWall,
          clockOk: trusted,
          window: null,
          reading: null,
          rssi: null,
          snrQ: null,
          bestGatewayId: null,
          estimates: null,
          uptimeS: null,
        },
      ],
    });
    const hub = new Hub();
    const effects = hub.input(
      {
        kind: "boot",
        snapshot,
        boot: { id: bootId(2), previousExit: "clean", cause: undefined },
      },
      undefined,
    );
    return { hub, effects };
  }

  test("with a known downtime a token keeps what it had left, measured from the restart", () => {
    const { hub, effects } = restart(true);
    const live = hub.state.people.tokens.get(tokenId(5));
    // 10 minutes less 4 before the commit, less the downtime (1 s of wall time here).
    expect(live).toBeDefined();
    const row = writesTo(effects, "link_tokens")[0];
    const carried = row?.op === "upsert" && row.table === "link_tokens" ? row.row : undefined;
    expect(carried?.createdBoot).toBe(bootId(2));
    expect(carried?.expiresAfterMs).toBe(6 * 60 * 1000 - 1000);
    expect(live?.expiresAt).toBe(mono(SECOND + (6 * 60 - 1) * SECOND));
    expect(linkSecrets(effects)).toEqual([]);
  });

  test("with the downtime unknown every token of the earlier run counts as expired", () => {
    const { hub, effects } = restart(false);
    expect(hub.state.people.tokens.size).toBe(0);
    expect(linkSecrets(effects)).toEqual([
      {
        kind: "linkSecret",
        token: tokenId(5),
        purpose: "link",
        askName: false,
        lookup: null,
        psk: null,
      },
    ]);
  });

  test("a token's number is never reused: the next is above the highest ever stored", () => {
    const committed = new Committed(household());
    const hub = booted();
    committed.apply(linkCreate(hub).effects);
    committed.apply(complete(hub, 1).effects);
    const again = new Hub();
    again.boot(committed.snapshot(), 2);
    expect(again.state.people.nextToken).toBe(2);
    expect(LINKING.secretBytes).toBe(16);
  });
});

describe('the frozen changes of step 1 (section 11, "Step 1\'s questions")', () => {
  test("LinkResult goes as the link connection's handshake message", () => {
    const hub = booted();
    linkCreate(hub);
    const { conn, effects } = complete(hub, 1);
    expect(effects.filter((e) => e.kind === "appSend" && e.conn === conn)).toEqual([
      { kind: "appSend", conn, message: { kind: "handshake", body: { client: 10, person: 3 } } },
    ]);
  });

  test("a refused link's connection is closed (closeConn), and nothing is sent on it", () => {
    const hub = booted();
    linkCreate(hub);
    complete(hub, 1);
    const { conn, effects } = complete(hub, 1, { key: new Uint8Array(32).fill(0x79) });
    expect(effects.filter((e) => e.kind === "closeConn")).toEqual([
      { kind: "closeConn", conn, reason: "linkRefused" },
    ]);
    expect(effects.filter((e) => e.kind === "appSend")).toEqual([]);
  });

  test("the maker's name for a new person is kept in the token's row, across a restart", () => {
    const committed = new Committed(household());
    const hub = booted();
    const made = linkCreate(hub, ANNA_LAPTOP, { kind: { newPerson: { name: "Cleo" } } });
    committed.apply(made.effects);
    const row = writesTo(made.effects, "link_tokens")[0];
    expect(row?.op === "upsert" && row.table === "link_tokens" ? row.row.personName : null).toBe(
      "Cleo",
    );
  });

  test("failed tries are recorded; the 10th in an hour from one address is a warning", () => {
    const hub = booted();
    linkCreate(hub);
    const levels: string[] = [];
    for (let i = 0; i < DEFAULT_RULES.people.linkFailureWarningPerHour; i++) {
      const effects = hub.input({
        kind: "linkFailed",
        token: tokenId(1),
        reason: "badPsk",
        address: "192.168.1.66",
      });
      for (const e of effects)
        if (
          e.kind === "record" &&
          e.record.kind === "hubEvent" &&
          e.record.row.code === "link_failed"
        )
          levels.push(e.record.row.level);
    }
    expect(levels).toEqual([...Array<string>(9).fill("info"), "warning"]);
    // Another address counts on its own.
    const other = hub.input({
      kind: "linkFailed",
      token: tokenId(1),
      reason: "badPsk",
      address: "10.0.0.2",
    });
    const level = other.flatMap((e) =>
      e.kind === "record" && e.record.kind === "hubEvent" ? [e.record.row.level] : [],
    );
    expect(level).toEqual(["info"]);
  });
});

describe('a removed person\'s codes (section 7, "Removing a person")', () => {
  /** Ben's own-device code, as though made by no client of his: only its person ties it to him. */
  function bensCode(hub: Hub): void {
    linkCreate(hub, BEN_LAPTOP, { kind: "ownDevice" });
    const tokens = new Map(hub.state.people.tokens);
    const live = tokens.get(tokenId(1));
    if (live !== undefined)
      tokens.set(tokenId(1), { ...live, row: { ...live.row, createdByClient: null } });
    hub.state = { ...hub.state, people: { ...hub.state.people, tokens } };
  }

  test("removing the person voids the codes made for them, whoever made them", () => {
    const hub = booted();
    bensCode(hub);
    const anna = hub.connect(ANNA_LAPTOP);
    const { effects } = hub.request(anna, ANNA_LAPTOP, {
      op: "person.remove",
      body: { person: 2, ifRevision: 0 },
    });
    expect(hub.state.people.tokens.size).toBe(0);
    expect(linkSecrets(effects)).toContainEqual({
      kind: "linkSecret",
      token: tokenId(1),
      purpose: "link",
      askName: false,
      lookup: null,
      psk: null,
    });
    const { effects: late } = complete(hub, 1);
    expect(hub.state.people.clients.size).toBe(4);
    expect(late.filter((e) => e.kind === "closeConn")).toHaveLength(1);
  });

  test("a code still live for a removed person is refused: no client, its connection closed", () => {
    const hub = booted();
    linkCreate(hub, BEN_LAPTOP, { kind: "ownDevice" });
    const people = new Map(hub.state.people.people);
    const ben = people.get(BEN);
    if (ben !== undefined) people.set(BEN, { ...ben, removedMs: WALL_AT_START });
    hub.state = { ...hub.state, people: { ...hub.state.people, people } };
    const { conn, effects } = complete(hub, 1);
    expect(hub.state.people.clients.size).toBe(4);
    expect(effects.filter((e) => e.kind === "closeConn")).toEqual([
      { kind: "closeConn", conn, reason: "linkRefused" },
    ]);
    expect(linkResults(effects)).toEqual([]);
  });
});

describe("ports come from the shell's facts, never a constant (section 2, `hubFacts`)", () => {
  const SECRET_B = new Uint8Array(16).fill(0x5e);

  function onPorts(): Hub {
    const hub = new Hub();
    hub.boot(household(), 1, false);
    hub.input({ kind: "hubFacts", ...FACTS, appsPort: 9444, consolePort: 9445 });
    return hub;
  }

  function consoleReply(hub: Hub) {
    const effects = hub.command({ kind: "consoleToken" }, entropy(SECRET_B));
    const respond = effects.find((e) => e.kind === "respond");
    return { effects, reply: respond?.kind === "respond" ? respond.reply : undefined };
  }

  test("the console's address names the console listener's real port", () => {
    const { reply } = consoleReply(onPorts());
    expect(reply?.ok === true && reply.result.kind === "consoleToken" ? reply.result.url : "").toBe(
      `http://127.0.0.1:9445/#console=${Buffer.from(SECRET_B).toString("base64url")}`,
    );
  });

  test("a QR code and a link address name the apps' listener's real port", () => {
    const hub = onPorts();
    const qr = parseLinkQr(String(bodyOf(linkCreate(hub).reply).qr));
    expect(qr?.port).toBe(9444);
    const url = String(bodyOf(linkCreate(hub, ANNA_LAPTOP, { form: "url" }).reply).url);
    expect(url.startsWith(`https://${FACTS.addresses[0]}:9444/#`)).toBe(true);
  });

  test("before the facts, the console token is refused and no token is made", () => {
    const hub = new Hub();
    hub.boot(household(), 1, false);
    const { effects, reply } = consoleReply(hub);
    expect(reply).toMatchObject({ ok: false, error: { code: "failed" } });
    expect(linkSecrets(effects)).toEqual([]);
    expect(hub.state.people.tokens.size).toBe(0);
  });
});
