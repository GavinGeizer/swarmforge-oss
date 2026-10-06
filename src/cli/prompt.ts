import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import type { InitField } from "./init";

/** Readline handles editing; its output is muted while a credential is entered. */
export function terminalPrompt() {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "init needs an interactive terminal. Run `swarmforge init` in a terminal.",
    );
  let muted = false;
  const controller = new AbortController();
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) process.stdout.write(chunk);
      done();
    },
  });
  const reader = createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });
  reader.on("SIGINT", () => controller.abort());
  reader.on("close", () => controller.abort());
  return {
    async ask(field: InitField): Promise<string> {
      process.stdout.write(
        `${field.label}${field.secret ? " (hidden)" : ""}: `,
      );
      muted = field.secret;
      try {
        return await reader.question("", { signal: controller.signal });
      } catch {
        throw new Error(
          "Initialization cancelled; no configuration was written.",
        );
      } finally {
        if (muted) process.stdout.write("\n");
        muted = false;
      }
    },
    close() {
      reader.close();
      output.destroy();
    },
  };
}
