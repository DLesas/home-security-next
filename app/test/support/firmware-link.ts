import {
  decodeTransferFrame,
  encodeTransferFrame,
  type TransferFrameToSend,
  TransferKind,
} from "@hsn/protocol/update";
import type { GattLink } from "../../src/platform/ble";

/** Models a peripheral that can send any valid frame and records only non-secret replies. */
export function firmwareLink() {
  const replies: { kind: TransferKind; reason?: number }[] = [];
  let receive: ((bytes: Uint8Array) => void) | undefined;
  let watches = 0;
  let closed = false;
  const link: GattLink = {
    mtu: 185,
    write: (_characteristic, data) => {
      const decoded = decodeTransferFrame(data);
      if (!decoded.ok) return Promise.resolve({ ok: false, fault: "failed" });
      const frame = decoded.value;
      replies.push(
        frame.kind === TransferKind.Gone
          ? { kind: frame.kind, reason: frame.reason }
          : { kind: frame.kind },
      );
      return Promise.resolve({ ok: true, value: undefined });
    },
    read: () => Promise.resolve({ ok: false, fault: "failed" }),
    watch: (_characteristic, listener) => {
      watches++;
      receive = listener;
      return () => {
        receive = undefined;
      };
    },
    onClosed: () => undefined,
    close: () => {
      closed = true;
    },
  };
  return {
    link,
    replies,
    /** Emits a wire frame through the phone's actual notification handler. */
    notify(frame: TransferFrameToSend) {
      const encoded = encodeTransferFrame(frame);
      if (!encoded.ok || receive === undefined) return false;
      receive(encoded.value);
      return true;
    },
    watches: () => watches,
    closed: () => closed,
  };
}
