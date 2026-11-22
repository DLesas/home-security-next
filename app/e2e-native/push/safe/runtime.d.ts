import type {} from "../../../../relay/src/shell/storage/sql.d.ts";

// This host harness runs on Bun, whose WebSocket accepts bytes over either buffer type.
declare global {
  interface WebSocket {
    send(data: string | Uint8Array): void;
  }
}
