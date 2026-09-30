/**
 * A compiled test harness for the packaged serve lifecycle.
 *
 * The packaged CLI cannot be given the test doubles without adding a bypass to
 * production code, so the lifecycle tests run this harness instead: it is
 * compiled with the same exported compile settings as the CLI, uses the real
 * `runServe` command with the existing provider and agent doubles, and keeps a
 * real database on disk, so `flock`, the native SQLite bindings, startup
 * rollback and the shutdown deadline are all exercised in a packaged binary.
 *
 * `SWARMFORGE_HARNESS_WORKER=1` queues one worker before the server starts, and
 * `SWARMFORGE_HARNESS_BLOCKED=1` leaves its provisioning call pending, so the
 * shutdown deadline has an in-flight operation to bound. Both are test-only
 * variables read here, in the harness, and never in production code.
 */
import { Coordinator } from "../../src/coordinator";
import { runServe } from "../../src/serve-command";
import { resolveServerSettings } from "../../src/settings/load";
import { Store } from "../../src/store";
import { FakeAgent, FakeProvider } from "../helpers";

const settings = await resolveServerSettings();
const config = settings.value;
const provider = new FakeProvider();
const agent = new FakeAgent();

if (process.env.SWARMFORGE_HARNESS_WORKER === "1") {
  const store = new Store(config.SWARMFORGE_DB_PATH);
  new Coordinator(config, store, new FakeProvider(), new FakeAgent()).spawn({
    team_id: "packaging",
    task_id: "compiled-serve",
    role: "coder",
    prompt: "Exercise the packaged serve lifecycle",
  });
  store.close();
}

if (process.env.SWARMFORGE_HARNESS_BLOCKED === "1")
  // A provider promise that never settles: only the shutdown deadline ends it.
  provider.createWorker = () => new Promise<never>(() => {});

process.exit(
  await runServe(config, {
    provider,
    agent,
    log: (line) => process.stdout.write(`${line}\n`),
    logError: (line) => process.stderr.write(`${line}\n`),
  }),
);
