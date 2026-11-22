// Spike S5, step 3: what runs when the Disarm action is tapped with the app closed. Throwaway.
// iOS: the module's `onDisarm` event (or `pendingDisarm` when JavaScript started after the tap).
// Android: React Native's headless task `HsnDisarm`, started by the module's action receiver.
import { Platform } from "react-native";
import HsnPush from "../modules/hsn-push";
import { disarmFirst } from "./disarm";

const jsStartMs = Date.now();
let running = false;

function mark(step, detail = {}) {
  HsnPush.log(step, { ...detail, sinceJsStartMs: Date.now() - jsStartMs });
}

export async function runDisarm(event) {
  if (running) return;
  running = true;
  mark("js.disarm.start", { tapMs: event?.tapMs ?? 0, state: HsnPush.appState() });
  const p = HsnPush.provision();
  if (!p.ok || p.identity !== event?.hub || !/^ws:\/\/127\.0\.0\.1:\d+$/u.test(p.relayUrl)) {
    mark("js.disarm.noProvision");
    await HsnPush.finishDisarm(false, "Could not reach the hub. Open the app to disarm.");
    running = false;
    return;
  }
  // The next seq is written before the request is sent (m3-design section 2).
  const seq = HsnPush.nextSeq(p.lastSeq);
  let result;
  try {
    result = await disarmFirst(p, seq, mark);
  } catch (e) {
    result = { failed: `threw: ${String(e)}` };
  }
  const ok = result.reply?.ok === true;
  mark("js.disarm.end", { ok, failed: result.failed ?? null, tapMs: event?.tapMs ?? 0 });
  await HsnPush.finishDisarm(ok, ok ? "Disarmed." : "Could not reach the hub. Open the app to disarm.");
  running = false;
}

export function startBackground() {
  mark("js.start", { platform: Platform.OS, state: HsnPush.appState() });
  if (Platform.OS === "ios") {
    HsnPush.addListener("onDisarm", (event) => {
      HsnPush.pendingDisarm();
      void runDisarm(event);
    });
    const pending = HsnPush.pendingDisarm();
    if (pending) void runDisarm(pending);
  }
}
