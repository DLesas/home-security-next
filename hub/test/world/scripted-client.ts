/**
 * Scripted people and clients for the core's scenario tests (m2-design.md section 10, "Core unit
 * and scenario tests"): a client's requests enter as `clientRequest` events, already
 * authenticated and decrypted as the shell gives them, with no cryptography. A client numbers its
 * requests per connection and its changes by `seq`, as section 5 has a real one do, and can
 * retry a change with the same `seq`, replay one with an old `seq`, or reconnect.
 */
import { APP_OPS, type AppMessage, type AppOp } from "@hsn/protocol/app";
import type { Effect } from "../../src/core/model/effects.ts";
import type { AppListener, ConnCloseReason, HubEvent } from "../../src/core/model/events.ts";
import { type ClientId, type ConnId, connId, type PersonId } from "../../src/core/model/ids.ts";

let nextConn = 1;

/** One linked browser or phone, or the console (person null). */
export class ScriptedClient {
  readonly client: ClientId;
  readonly person: PersonId | null;
  readonly listener: AppListener;
  /** The connection now open, or undefined. */
  conn: ConnId | undefined;
  /** Everything the hub sent this client's connections, in order. */
  readonly received: AppMessage[] = [];
  #nextId = 1;
  #lastSeq = 0;
  #lastChange: { readonly id: number; readonly seq: number; readonly op: AppOp } | undefined;

  constructor(client: ClientId, person: PersonId | null, listener: AppListener = "lan") {
    this.client = client;
    this.person = person;
    this.listener = listener;
  }

  /** A new session, proven (section 5): `clientConnected`. */
  connect(app = "1.0.0", proto = 1): HubEvent {
    this.conn = connId(nextConn++);
    this.#nextId = 1;
    return {
      kind: "clientConnected",
      conn: this.conn,
      client: this.client,
      listener: this.listener,
      proto,
      app,
    };
  }

  /** A request: a change takes the next `seq`, a read none (section 5). */
  request(op: AppOp): HubEvent {
    const id = this.#nextId++;
    const change = APP_OPS[op.op].change;
    const seq = change ? ++this.#lastSeq : undefined;
    if (seq !== undefined) this.#lastChange = { id, seq, op };
    return this.#event({ id, seq, op });
  }

  /** The last change again, with the same `seq`, as after a lost reply (section 5). */
  retryLastChange(): HubEvent | undefined {
    const last = this.#lastChange;
    if (last === undefined) return undefined;
    return this.#event({ id: this.#nextId++, seq: last.seq, op: last.op });
  }

  /** A change with a `seq` already used and no longer kept: answered `seqTooLow`. */
  replay(op: AppOp, seq: number): HubEvent {
    return this.#event({ id: this.#nextId++, seq, op });
  }

  close(reason: ConnCloseReason = "remote"): HubEvent | undefined {
    const conn = this.conn;
    this.conn = undefined;
    return conn === undefined ? undefined : { kind: "clientClosed", conn, reason };
  }

  /** Takes what a step sent this client's connection. */
  take(effects: readonly Effect[]): readonly AppMessage[] {
    const mine = effects.flatMap((e) =>
      e.kind === "appSend" && e.conn === this.conn ? [e.message] : [],
    );
    this.received.push(...mine);
    return mine;
  }

  #event(request: {
    readonly id: number;
    readonly seq: number | undefined;
    readonly op: AppOp;
  }): HubEvent {
    const conn = this.conn ?? connId(0);
    return { kind: "clientRequest", conn, client: this.client, request };
  }
}

/** A member of the household with their clients (section 7, "People and clients"). */
export class ScriptedPerson {
  readonly person: PersonId;
  readonly name: string;
  readonly clients: ScriptedClient[] = [];

  constructor(person: PersonId, name: string) {
    this.person = person;
    this.name = name;
  }

  /** Another linked client of this person. */
  addClient(client: ClientId, listener: AppListener = "lan"): ScriptedClient {
    const scripted = new ScriptedClient(client, this.person, listener);
    this.clients.push(scripted);
    return scripted;
  }
}
