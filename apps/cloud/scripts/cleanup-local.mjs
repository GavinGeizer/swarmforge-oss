import { CliExit, runMain } from "cf";
import { cleanupStatements } from "../src/abuse.ts";

// Local DB UUID and local state are fixed. No remote toggle or arbitrary SQL.
const args = process.argv.slice(2);
let auditBefore;
if (args.length) {
  if (
    args.length !== 2 ||
    args[0] !== "--audit-retention-days" ||
    !/^[0-9]+$/.test(args[1])
  )
    throw new Error("Expected --audit-retention-days 7..3650");
  const days = Number(args[1]);
  if (days < 7 || days > 3650)
    throw new Error("Audit retention must be 7..3650 days");
  auditBefore = Date.now() - days * 86400000;
}
const now = Date.now(),
  sql = cleanupStatements(auditBefore)
    .map((s) => s.replaceAll("?", String(now)))
    .join(";");
try {
  await runMain([
    "d1",
    "raw",
    "00000000-0000-4000-8000-00000000002a",
    "--local",
    "--mode",
    "local",
    "--persist-to",
    ".wrangler/state",
    "--sql",
    sql,
  ]);
} catch (e) {
  process.exitCode = e instanceof CliExit ? e.code : 1;
}
process.stdout.write("", () =>
  process.stderr.write("", () => process.exit(process.exitCode ?? 0)),
);
