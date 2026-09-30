// Child fixture for the serve command shutdown policy. Real signal delivery and a real
// process exit can only be observed from a separate process.

import { type Config, loadConfig } from "../../src/config";
import { Coordinator } from "../../src/coordinator";
import type { CodingAgent } from "../../src/domain";
import { runServe } from "../../src/serve-command";
import { Store } from "../../src/store";
import { FakeAgent, FakeProvider } from "../helpers";

type Provisioned = {
  id: string;
  slug: string;
  state: string;
  worker_id: string;
};

const [dbPath, port, metricsPort, mode] = process.argv.slice(2);
if (!dbPath || !port || !metricsPort || !mode)
  throw new Error(
    "usage: serve-command-child <db> <port> <metrics-port> <mode>",
  );

const config: Config = loadConfig({
  FREESTYLE_API_TOKEN: "infra-secret",
  FREESTYLE_SNAPSHOT_ID: "snapshot",
  SWARMFORGE_MODEL_BASE_URL: "https://model.example/v1",
  SWARMFORGE_MODEL_API_KEY: "model-secret",
  SWARMFORGE_MODEL_NAME: "qwen",
  SWARMFORGE_GIT_TREE: "opaque-tree",
  SWARMFORGE_DB_PATH: dbPath,
  SWARMFORGE_HOST: "127.0.0.1",
  SWARMFORGE_PORT: port,
  SWARMFORGE_METRICS_PORT: metricsPort,
  SWARMFORGE_POLL_INTERVAL_MS: "50",
});

const store = new Store(dbPath);
new Coordinator(config, store, new FakeProvider(), new FakeAgent()).spawn({
  team_id: "serve-fixture",
  task_id: `child-${mode}`,
  role: "tester",
  prompt: "Exercise the serve command shutdown policy",
});
store.close();

const provider = new FakeProvider();
const agent: CodingAgent = new FakeAgent();
let reported = false;
const report = (message: string) => {
  if (reported) return;
  reported = true;
  // Reported from inside a startup that cannot finish yet, so the parent only signals a
  // process whose shutdown handler is already installed.
  console.log(JSON.stringify({ message, pid: process.pid }));
};
if (mode === "blocked") {
  provider.createWorker = () => {
    report("provisioning-blocked");
    // A provider promise that never settles: only the shutdown deadline bounds the exit.
    return new Promise<Provisioned>(() => {});
  };
}
if (mode === "slow") {
  const released = new Promise<void>((resolve) => setTimeout(resolve, 1500));
  provider.listWorkers = async () => {
    report("recovery-blocked");
    await released;
    return [];
  };
}

process.exit(await runServe(config, { provider, agent }));
