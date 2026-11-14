/**
 * The scripted people and clients (m2-design.md section 10): their requests number and `seq`
 * as section 5 says, and the whole core takes them without a fault while `app` is a stub.
 */
import { describe, expect, test } from "bun:test";
import { clientId, personId } from "../../src/core/model/ids.ts";
import { makeCore, MODULES } from "../../src/core/step.ts";
import { Driver, snapshot } from "../unit/setup/support/driver.ts";
import { ScriptedClient, ScriptedPerson } from "./scripted-client.ts";

describe("a scripted client (section 5)", () => {
  test("reads carry no seq; changes take the next; a retry keeps its seq", () => {
    const anna = new ScriptedPerson(personId(1), "Anna");
    const laptop = anna.addClient(clientId(7));
    laptop.connect();
    const read = laptop.request({ op: "hub.info", body: {} });
    const change = laptop.request({ op: "mode.switch", body: { mode: 1 } });
    const again = laptop.retryLastChange();
    const ids = [read, change, again].map((e) => (e?.kind === "clientRequest" ? e.request.id : 0));
    const seqs = [read, change, again].map((e) =>
      e?.kind === "clientRequest" ? e.request.seq : null,
    );
    expect(ids).toEqual([1, 2, 3]);
    expect(seqs).toEqual([undefined, 1, 1]);
    expect(laptop.replay({ op: "mode.switch", body: { mode: 2 } }, 1).kind).toBe("clientRequest");
  });

  test("the whole core takes a client's session, requests and close without a fault", () => {
    const driver = new Driver(makeCore(MODULES));
    driver.boot(snapshot());
    const console = new ScriptedClient(clientId(1), null, "console");
    driver.input(console.connect());
    const effects = driver.input(console.request({ op: "snapshot", body: {} }));
    expect(console.take(effects)).toEqual([]);
    const closed = console.close();
    if (closed !== undefined) driver.input(closed);
    expect(console.conn).toBeUndefined();
  });
});
