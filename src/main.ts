import { resolveServerSettings } from "./settings/load";

// Thin entry point: configuration loading, signals and exit policy belong to the
// serve command, and the server lifecycle belongs to startServer.
if (import.meta.main)
  try {
    const settings = await resolveServerSettings();
    // Loaded only once the configuration is known to be complete, so importing
    // this module starts nothing and a rejected configuration loads no server.
    const { runServe } = await import("./serve-command");
    // An in-memory database is refused by startServer, which owns that rule.
    process.exit(await runServe(settings.value));
  } catch (error) {
    // A configuration failure is a diagnostic, not a stack trace: the message is
    // already credential-free and control-character-free.
    process.stderr.write(
      `SwarmForge: ${error instanceof Error ? error.message : "Unexpected error"}\n`,
    );
    process.exit(1);
  }
