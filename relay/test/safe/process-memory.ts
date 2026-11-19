/** Reads another process's resident memory without starting a shell on Windows. */
import { dlopen, FFIType } from "bun:ffi";
import { Result } from "neverthrow";

const calls = {
  OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
  K32GetProcessMemoryInfo: {
    args: [FFIType.u64, FFIType.ptr, FFIType.u32],
    returns: FFIType.i32,
  },
  CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
} as const;

const load = Result.fromThrowable(() => dlopen("kernel32.dll", calls).symbols);
let windows: ReturnType<typeof load> | undefined;

/** Samples the working set of a running child via PSAPI. */
function workingSet(pid: number): number {
  const loaded = (windows ??= load());
  if (loaded.isErr()) return Number.NaN;
  const { OpenProcess, K32GetProcessMemoryInfo, CloseHandle } = loaded.value;
  const handle = OpenProcess(0x1000, 0, pid); // PROCESS_QUERY_LIMITED_INFORMATION
  if (handle === 0n) return Number.NaN;
  // PROCESS_MEMORY_COUNTERS on 64-bit Windows: two DWORDs, then eight SIZE_Ts.
  const counters = new BigUint64Array(9);
  counters[0] = BigInt(counters.byteLength);
  const sampled = Result.fromThrowable(K32GetProcessMemoryInfo)(
    handle,
    counters,
    counters.byteLength,
  );
  CloseHandle(handle);
  return sampled.unwrapOr(0) === 0 ? Number.NaN : Number(counters[2]); // WorkingSetSize
}

/** Samples resident bytes, or NaN if the process has exited or could not be measured. */
export function residentBytes(pid: number | undefined): number {
  if (pid === undefined) return Number.NaN;
  if (process.platform === "win32") return workingSet(pid);
  const sampled = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)]);
  return sampled.success ? Number(sampled.stdout.toString().trim()) * 1024 : Number.NaN;
}
