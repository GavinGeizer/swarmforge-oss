import { fileURLToPath } from "node:url";
import { CliExit, runMain } from "cf";

// The pinned beta leaves a local runtime filesystem watcher open after its
// command completes. Await the public CLI entrypoint (including D1 writes and
// cleanup), flush output, then exit. Never time out or infer success from text.
try {
  await runMain([
    "d1",
    "migrations",
    "apply",
    "00000000-0000-4000-8000-00000000002a",
    "--local",
    "--mode",
    "local",
    "--persist-to",
    ".wrangler/state",
    "--dir",
    fileURLToPath(new URL("../migrations", import.meta.url)),
  ]);
} catch (error) {
  // cf renders command failures itself. Preserve its status, including errors.
  process.exitCode = error instanceof CliExit ? error.code : 1;
}
process.stdout.write("", () =>
  process.stderr.write("", () => process.exit(process.exitCode ?? 0)),
);
