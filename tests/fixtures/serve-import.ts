// Proves the serve modules are import-safe: no startup, no process lock, no listener and
// no signal handler exists just because the module was loaded.
export {};

const serve = await import("../../src/serve");
const command = await import("../../src/serve-command");
const { readdirSync } = await import("node:fs");

console.log(
  JSON.stringify({
    sigterm: process.listenerCount("SIGTERM"),
    sigint: process.listenerCount("SIGINT"),
    beforeExit: process.listenerCount("beforeExit"),
    exit: process.listenerCount("exit"),
    handles: readdirSync(".").filter((name) => name.endsWith(".lock")),
    exports: Object.keys(serve).concat(Object.keys(command)).sort(),
  }),
);
