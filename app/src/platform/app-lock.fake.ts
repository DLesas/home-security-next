/** Scriptable local authentication for tests with no native module or phone. */
import type { Outcome } from "./split";
import {
  type CheckFault,
  type CheckWords,
  type LockAbility,
  NO_ABILITY,
  type PersonCheck,
} from "./app-lock-types";

/** Supplies a capability and a sequence of authentication answers, recording each prompt. */
export function fakeCheck(ability: LockAbility = NO_ABILITY) {
  const answers: Outcome<undefined, CheckFault>[] = [];
  const state = { ability, asked: 0, words: [] as CheckWords[], unavailable: false };
  const check: PersonCheck = {
    /** Returns simulated capabilities or a platform read failure. */
    ability: () =>
      Promise.resolve(
        state.unavailable ? { ok: false, fault: "failed" } : { ok: true, value: state.ability },
      ),
    /** Records the prompt and consumes the next scripted result. */
    check: (words) => {
      state.asked += 1;
      state.words.push(words);
      return Promise.resolve(answers.shift() ?? { ok: true, value: undefined });
    },
  };
  return {
    check,
    state,
    /** Queues the next result in place of the default successful check. */
    answer: (outcome: Outcome<undefined, CheckFault>) => {
      answers.push(outcome);
    },
  };
}
