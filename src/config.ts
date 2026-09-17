import { z } from "zod";

const positive = (n: number) => z.coerce.number().int().positive().default(n);
const bool = (n: boolean) =>
  z
    .enum(["true", "false"])
    .default(String(n) as "true" | "false")
    .transform((v) => v === "true");
const schema = z
  .object({
    FREESTYLE_API_URL: z.url().default("https://api.freestyle.sh"),
    FREESTYLE_API_TOKEN: z.string().min(1),
    FREESTYLE_SNAPSHOT_ID: z.string().min(1),
    FREESTYLE_VPC: z.string().optional(),
    SWARMFORGE_INSTANCE_ID: z
      .string()
      .regex(/^[a-z0-9]{1,16}$/)
      .default("default"),
    OPENCODE_PORT: positive(4096).pipe(z.number().max(65535)),
    OPENCODE_START_COMMAND: z
      .string()
      .min(1)
      .default('opencode serve --hostname 0.0.0.0 --port "$OPENCODE_PORT"'),
    SWARMFORGE_MODEL_BASE_URL: z.url(),
    SWARMFORGE_MODEL_API_KEY: z.string().min(1),
    SWARMFORGE_MODEL_NAME: z.string().min(1),
    SWARMFORGE_GIT_TREE: z.string().min(1).max(2048),
    SWARMFORGE_WORKSPACE: z
      .string()
      .regex(/^\/(?:[a-zA-Z0-9_.-]+\/?)*$/)
      .refine((v) => !v.split("/").includes(".."))
      .default("/workspace"),
    SWARMFORGE_DB_PATH: z.string().min(1).default("./data/swarmforge.sqlite"),
    SWARMFORGE_HOST: z.string().default("127.0.0.1"),
    SWARMFORGE_ALLOWED_HOSTS: z.string().default(""),
    SWARMFORGE_PORT: positive(8787).pipe(z.number().max(65535)),
    SWARMFORGE_API_TOKEN: z.string().min(24).optional(),
    SWARMFORGE_MAX_WORKERS: positive(50),
    SWARMFORGE_MAX_PROVISIONING: positive(4),
    SWARMFORGE_MAX_QUEUE: positive(1000),
    SWARMFORGE_DEFAULT_TIMEOUT_SECONDS: positive(3600),
    SWARMFORGE_PROVISION_TIMEOUT_SECONDS: positive(300),
    SWARMFORGE_POLL_INTERVAL_MS: positive(2000),
    SWARMFORGE_API_TIMEOUT_MS: positive(30000),
    SWARMFORGE_METRICS_ENABLED: bool(true),
    SWARMFORGE_METRICS_PORT: positive(9090).pipe(z.number().max(65535)),
    SWARMFORGE_METRICS_TEAMS: z.string().default("default"),
  })
  .superRefine((v, ctx) => {
    if (
      !["127.0.0.1", "localhost", "::1"].includes(v.SWARMFORGE_HOST) &&
      !v.SWARMFORGE_API_TOKEN
    )
      ctx.addIssue({
        code: "custom",
        path: ["SWARMFORGE_API_TOKEN"],
        message: "Required when binding beyond loopback",
      });
    if (
      v.SWARMFORGE_METRICS_ENABLED &&
      v.SWARMFORGE_PORT === v.SWARMFORGE_METRICS_PORT
    )
      ctx.addIssue({
        code: "custom",
        path: ["SWARMFORGE_METRICS_PORT"],
        message: "Must differ from server port",
      });
  });
export type Config = z.infer<typeof schema>;
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): Config {
  const r = schema.safeParse(
    Object.fromEntries(Object.entries(env).filter(([, v]) => v !== "")),
  );
  if (!r.success)
    throw new Error(
      `Invalid configuration: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  return r.data;
}
export function workerEnvironment(
  c: Config,
  w: { worker_id: string; team_id: string; task_id: string },
): Record<string, string> {
  return {
    SWARMFORGE_WORKER_ID: w.worker_id,
    SWARMFORGE_TEAM_ID: w.team_id,
    SWARMFORGE_TASK_ID: w.task_id,
    SWARMFORGE_GIT_TREE: c.SWARMFORGE_GIT_TREE,
    SWARMFORGE_WORKSPACE: c.SWARMFORGE_WORKSPACE,
    SWARMFORGE_MODEL_API_KEY: c.SWARMFORGE_MODEL_API_KEY,
    OPENCODE_PORT: String(c.OPENCODE_PORT),
  };
}
