// Dev/test child entry: runs the embedded fixed inert runtime as a script.
// The compiled binary never uses this file: it self-spawns process.execPath
// (Bun.isStandaloneExecutable === true) and enters src/hosted-child.ts
// embedded in the binary. This script exists only so `bun test` (bare runtime
// execPath, isStandaloneExecutable === false) has a real entrypoint without
// $bunfs/repo-file coupling.
import { runHostedChildRuntime } from "./hosted-child";

await runHostedChildRuntime();
