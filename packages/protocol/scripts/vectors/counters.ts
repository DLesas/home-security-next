/** Counter vectors: resume points, the hub's window, the strict rule and the restore jump. */
import {
  checkReplayWindow,
  checkStrictlyHigher,
  EMPTY_REPLAY_WINDOW,
  encodeReplayWindow,
  newSendCounter,
  type ReplayWindow,
  restoreSendCounter,
  ResumeStep,
  resumeSendCounter,
  type SendCounter,
  takeSendCounter,
  toHex,
} from "../../src/index.ts";
import type { Json, JsonObject } from "./json.ts";

function takeJson(state: SendCounter): Json {
  const taken = takeSendCounter(state);
  const before = { step: state.step, next: state.next, resumePoint: state.resumePoint };
  if (!taken.ok) return { ...before, error: taken.error.code };
  return {
    ...before,
    counter: taken.value.counter,
    saveResumePoint: taken.value.saveResumePoint ?? null,
    nextAfter: taken.value.state.next,
    resumePointAfter: taken.value.state.resumePoint,
  };
}

const takeCases: readonly SendCounter[] = [
  newSendCounter(ResumeStep.Sensor),
  { step: ResumeStep.Sensor, next: 63, resumePoint: 64 },
  { step: ResumeStep.Sensor, next: 64, resumePoint: 64 },
  { step: ResumeStep.Sensor, next: 65, resumePoint: 128 },
  newSendCounter(ResumeStep.SirenOrGateway),
  { step: ResumeStep.SirenOrGateway, next: 1024, resumePoint: 1024 },
  { step: ResumeStep.Sensor, next: 0xffffffbf, resumePoint: 0xffffffc0 },
  { step: ResumeStep.Sensor, next: 0xffffffc0, resumePoint: 0xffffffc0 },
  { step: ResumeStep.SirenOrGateway, next: 0xfffffbff, resumePoint: 0xfffffc00 },
  { step: ResumeStep.SirenOrGateway, next: 0xfffffc00, resumePoint: 0xfffffc00 },
];

type PowerEvent = { readonly send: number } | { readonly powerLoss: true };

/** Plays sends and power losses from pairing, recording what each event produced. */
function powerLossSequence(step: ResumeStep, events: readonly PowerEvent[]): Json {
  let state = newSendCounter(step);
  let stored = state.resumePoint;
  const played = events.map((event): Json => {
    if ("powerLoss" in event) {
      state = resumeSendCounter(step, stored);
      return { event: "powerLoss", resumeFrom: stored };
    }
    const counters: number[] = [];
    const saved: number[] = [];
    for (let i = 0; i < event.send; i++) {
      const taken = takeSendCounter(state);
      if (!taken.ok) throw new Error("ran out of counters");
      if (taken.value.saveResumePoint !== undefined) {
        stored = taken.value.saveResumePoint;
        saved.push(stored);
      }
      counters.push(taken.value.counter);
      state = taken.value.state;
    }
    return {
      event: "send",
      count: event.send,
      firstCounter: counters[0] ?? null,
      lastCounter: counters.at(-1) ?? null,
      savedResumePoints: saved,
    };
  });
  return { step, initialResumePoint: step, events: played };
}

function restoreJson(backedUpResumePoint: number): Json {
  const restored = restoreSendCounter(ResumeStep.Hub, backedUpResumePoint);
  return restored.ok
    ? { step: ResumeStep.Hub, backedUpResumePoint, next: restored.value.next }
    : { step: ResumeStep.Hub, backedUpResumePoint, error: restored.error.code };
}

function windowSequence(name: string, counters: readonly number[]): Json {
  let window: ReplayWindow = EMPTY_REPLAY_WINDOW;
  const steps = counters.map((counter): Json => {
    const check = checkReplayWindow(window, counter);
    if (!check.accepted) return { counter, accepted: false, rejection: check.reason };
    window = check.state;
    return {
      counter,
      accepted: true,
      highest: window.highest,
      state: toHex(encodeReplayWindow(window)),
    };
  });
  return { name, steps };
}

function strictSequence(name: string, counters: readonly number[]): Json {
  let last = 0;
  const steps = counters.map((counter): Json => {
    const before = last;
    const check = checkStrictlyHigher(last, counter);
    if (!check.accepted)
      return { lastAccepted: before, counter, accepted: false, rejection: check.reason };
    last = check.state;
    return { lastAccepted: before, counter, accepted: true };
  });
  return { name, steps };
}

export function counterVectorFile(): JsonObject {
  return {
    take: takeCases.map(takeJson),
    powerLoss: [
      powerLossSequence(ResumeStep.Sensor, [
        { send: 30 },
        { powerLoss: true },
        { send: 100 },
        { powerLoss: true },
        { send: 1 },
      ]),
      powerLossSequence(ResumeStep.SirenOrGateway, [
        { send: 1023 },
        { send: 1 },
        { powerLoss: true },
        { powerLoss: true },
        { send: 2 },
      ]),
    ],
    restore: [1024, 0xfe000000, 0xff000000].map(restoreJson),
    replayWindow: [
      windowSequence("in order, then a repeat", [1, 2, 3, 3]),
      windowSequence("window edges after a jump", [100, 36, 35, 36, 99, 101, 37, 36]),
      windowSequence(
        "jump of exactly 64 keeps the old highest; 65 drops it",
        [1000, 1064, 1000, 1001, 1129, 1064, 1065],
      ),
      windowSequence(
        "highest possible counter",
        [0xffffffbf, 0xffffffff, 0xffffffbf, 0xffffffc0, 0xffffffbe],
      ),
    ],
    strictlyHigher: [
      strictSequence("siren commands", [1, 1, 5, 3, 0xffffffff, 5, 0xffffffff]),
      // Within one gateway connection, at either end. The rule starts again from 0 on each new
      // connection, while the sender's own counter carries on.
      strictSequence("gateway connection, hub receiving", [2049, 2050, 2050, 2049, 2052, 2051]),
      strictSequence("gateway connection, gateway receiving", [17, 18, 20, 19, 20, 21]),
    ],
  };
}
