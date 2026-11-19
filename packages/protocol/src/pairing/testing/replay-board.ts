/**
 * A scripted board built from `pairing-board-script.json`: it answers each write with what
 * ESP-IDF's protocomm answered to the same bytes, in the script's order, and behaves as
 * protocomm_nimble.c does around it (a refused write is a failed write, which leaves the
 * characteristic's earlier answer to be read; `proto-ver` answers its text whatever is written).
 * A write that is not the script's next is refused and recorded as unexpected. Links come and go
 * while the board keeps its place in the script, as a board's state outlives one connection.
 * For tests; the bench's full boards are P6's.
 */
import { fromHex, toHex } from "../../bytes.ts";
import { PROTOCOMM } from "../constants.ts";
import {
  type LinkFault,
  type PairingLink,
  type PairingOutcome,
  pairingCharacteristic,
} from "../setup-session.ts";

export interface ScriptStep {
  readonly endpoint: "proto-ver" | "prov-session" | "hsn-setup";
  readonly request: string;
  readonly answer: string | null;
}

/** One operation on a link, as the board saw it. */
export type BoardOp =
  | {
      readonly op: "write";
      readonly endpoint: string;
      readonly data: string;
      readonly response: boolean;
    }
  | { readonly op: "read"; readonly endpoint: string };

/** What a test makes the link do at an operation, before the board sees it. */
export type Interference = LinkFault | "hang" | { readonly answer: Uint8Array };

export interface ReplayLink extends PairingLink {
  readonly ops: BoardOp[];
  readonly closed: boolean;
  /** The board, or the radio, ends the connection. */
  drop(fault: LinkFault): void;
}

export interface ReplayBoard {
  connect(): ReplayLink;
  /** Writes refused because they were not the script's next. */
  readonly unexpected: string[];
  /** Steps of the script not yet taken. */
  remaining(): number;
  /** Called before each operation, with its index on its link: a fault, a hang, or other bytes. */
  interfere?: (op: BoardOp, index: number) => Interference | undefined;
}

const ENDPOINT_OF = new Map<string, string>(
  Object.values(PROTOCOMM.endpoints).map((e) => [pairingCharacteristic(e.uuid16), e.name]),
);

export function replayBoard(steps: readonly ScriptStep[], versionText: string): ReplayBoard {
  const script = steps.filter((s) => s.endpoint !== "proto-ver");
  let at = 0;
  const unexpected: string[] = [];
  const board: ReplayBoard = {
    unexpected,
    remaining: () => script.length - at,
    connect() {
      const cached = new Map<string, Uint8Array>();
      const ops: BoardOp[] = [];
      let closed = false;
      let listener: ((fault: LinkFault | null) => void) | undefined;
      const end = (fault: LinkFault | null): void => {
        if (closed) return;
        closed = true;
        listener?.(fault);
      };
      const before = (op: BoardOp): Interference | undefined => {
        ops.push(op);
        return board.interfere?.(op, ops.length - 1);
      };
      const hang = <T>(): Promise<T> => new Promise<T>(() => undefined);
      return {
        ops,
        get closed() {
          return closed;
        },
        drop: (fault) => {
          end(fault);
        },
        onClosed(closedWith) {
          listener = closedWith;
        },
        close: () => {
          end(null);
        },
        write(characteristic, data, response): Promise<PairingOutcome<void, LinkFault>> {
          const endpoint = ENDPOINT_OF.get(characteristic) ?? characteristic;
          const how = before({ op: "write", endpoint, data: toHex(data), response });
          if (how === "hang") return hang();
          if (closed) return Promise.resolve({ ok: false, fault: "lost" });
          if (typeof how === "string") return Promise.resolve({ ok: false, fault: how });
          if (endpoint === "proto-ver") {
            cached.set(endpoint, new TextEncoder().encode(versionText));
            return Promise.resolve({ ok: true, value: undefined });
          }
          const step = script[at];
          if (step?.endpoint !== endpoint || step.request !== toHex(data)) {
            unexpected.push(`${endpoint} ${toHex(data).slice(0, 16)}`);
            return Promise.resolve({ ok: false, fault: "failed" });
          }
          at++;
          if (step.answer === null) return Promise.resolve({ ok: false, fault: "failed" });
          cached.set(endpoint, fromHex(step.answer));
          return Promise.resolve({ ok: true, value: undefined });
        },
        read(characteristic): Promise<PairingOutcome<Uint8Array, LinkFault>> {
          const endpoint = ENDPOINT_OF.get(characteristic) ?? characteristic;
          const how = before({ op: "read", endpoint });
          if (how === "hang") return hang();
          if (closed) return Promise.resolve({ ok: false, fault: "lost" });
          if (typeof how === "string") return Promise.resolve({ ok: false, fault: how });
          if (how !== undefined) return Promise.resolve({ ok: true, value: how.answer });
          return Promise.resolve({ ok: true, value: cached.get(endpoint) ?? new Uint8Array(0) });
        },
      };
    },
  };
  return board;
}
