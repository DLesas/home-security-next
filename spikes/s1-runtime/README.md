# Spike S1: Node against Bun

Throwaway code. Results and conclusions are in [docs/spikes/S1-runtime.md](../../docs/spikes/S1-runtime.md).

- `src/` is a small hub-shaped service with one entry file per runtime.
- `measure.mjs` starts each variant and records start time, memory and which checks pass.
- `breakdown.mjs` shows where the memory goes.
- `ccm-vectors.ts` checks `src/ccm.ts` against Node's built-in AES-CCM.
- `run-linux.sh` and `followup-linux.sh` run inside a `node:26-bookworm` container.
- `results-*.json` and `out-linux/` hold the raw results.
