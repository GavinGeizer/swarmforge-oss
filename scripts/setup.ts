import { installLocal } from "./install";

const path = await installLocal();
const child = Bun.spawn([path, "init"], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exitCode = await child.exited;
