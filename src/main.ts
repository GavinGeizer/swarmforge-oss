import { loadConfig } from "./config";
import { runServe } from "./serve-command";

// Thin entry point: configuration loading, signals and exit policy belong to the serve
// command, and the server lifecycle belongs to startServer.
if (import.meta.main) process.exit(await runServe(loadConfig()));
