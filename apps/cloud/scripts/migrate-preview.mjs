import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { previewTarget } from "./preview-target.mjs";

const database = previewTarget();
execFileSync(
  "cf",
  [
    "d1",
    "migrations",
    "apply",
    database,
    "--mode",
    "preview",
    "--dir",
    fileURLToPath(new URL("../migrations", import.meta.url)),
  ],
  { stdio: "inherit" },
);
