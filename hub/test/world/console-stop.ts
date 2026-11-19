/** Test preload for a Windows hub launched outside WinSW. Deliver its console interrupt handler. */
process.on("message", (message) => {
  if (message === "console-stop") process.emit("SIGINT", "SIGINT");
  if (message === "reload-config") process.emit("SIGHUP", "SIGHUP");
});
