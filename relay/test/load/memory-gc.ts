/** The memory test asks its separate relay process to collect, then samples that same process. */
process.on("message", (message) => {
  if (message !== "collect-memory") return;
  Bun.gc(true);
  process.send?.("memory-collected");
});
