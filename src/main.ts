import { loadConfig } from "./config";
import { Coordinator } from "./coordinator";
import { createHttpHandler } from "./http";
import { Metrics } from "./metrics";
import { FreestyleProvider } from "./providers/freestyle";
import { OpenCodeAgent } from "./providers/opencode";
import { acquireProcessLock, eventLogger, renderStartup } from "./runtime";
import { Store } from "./store";

const config = loadConfig();
if (config.SWARMFORGE_DB_PATH === ":memory:")
  throw new Error("Use a persistent database path to start the server");
const unlock = acquireProcessLock(`${config.SWARMFORGE_DB_PATH}.lock`);
const store = new Store(config.SWARMFORGE_DB_PATH);
const owner = store.setting("instance_id");
if (owner && owner !== config.SWARMFORGE_INSTANCE_ID)
  throw new Error("Instance ID differs from persisted owner");
store.setting("instance_id", config.SWARMFORGE_INSTANCE_ID);
const coordinator = new Coordinator(
  config,
  store,
  new FreestyleProvider(config),
  new OpenCodeAgent(config),
);
try {
  await coordinator.start();
} catch {
  store.close();
  unlock();
  console.error(
    JSON.stringify({
      level: "error",
      message:
        "Startup reconciliation failed; verify Freestyle connectivity and configuration",
    }),
  );
  process.exit(1);
}
const app = Bun.serve({
  hostname: config.SWARMFORGE_HOST,
  port: config.SWARMFORGE_PORT,
  maxRequestBodySize: 131072,
  fetch: createHttpHandler(coordinator),
  idleTimeout: 60,
});
const metrics = new Metrics(coordinator);
const metricsServer = config.SWARMFORGE_METRICS_ENABLED
  ? Bun.serve({
      hostname: config.SWARMFORGE_HOST,
      port: config.SWARMFORGE_METRICS_PORT,
      fetch: async (request) =>
        new URL(request.url).pathname === "/metrics"
          ? new Response(await metrics.render(), {
              headers: {
                "content-type": "text/plain; version=0.0.4; charset=utf-8",
              },
            })
          : new Response("Not found", { status: 404 }),
    })
  : undefined;
const flush = eventLogger(coordinator, `${config.SWARMFORGE_DB_PATH}.log`);
const logTimer = setInterval(flush, 1000);
console.log(
  renderStartup(
    {
      host: config.SWARMFORGE_HOST,
      port: app.port ?? config.SWARMFORGE_PORT,
      metricsEnabled: config.SWARMFORGE_METRICS_ENABLED,
      metricsPort: config.SWARMFORGE_METRICS_PORT,
    },
    Boolean(process.stdout.isTTY),
  ),
);
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(logTimer);
  await app.stop(true);
  await metricsServer?.stop(true);
  await coordinator.stop();
  flush();
  store.close();
  unlock();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
