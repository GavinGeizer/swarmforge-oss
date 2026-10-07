import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

const usd = z.coerce.number().finite().min(0).max(1_000_000).optional();
const positive = (n: number) => z.coerce.number().int().positive().default(n);
const nonNegative = (n: number) => z.coerce.number().int().min(0).default(n);
// Safe integer bounds only: every artifact and finalization limit multiplies, loops or
// allocates, so a fractional or unsafe value is rejected instead of silently truncating.
const bounded = (n: number, max: number) =>
  z.coerce.number().int().positive().max(max).default(n);
const bool = (n: boolean) =>
  z
    .enum(["true", "false"])
    .default(String(n) as "true" | "false")
    .transform((v) => v === "true");
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const isLoopbackHost = (host: string) =>
  loopbackHosts.has(host.trim().toLowerCase());
// Every hostname the HTTP layer accepts must be considered: a loopback bind behind a
// reverse proxy still serves a public hostname, and that request is unauthenticated
// without a token.
const acceptedHosts = (v: {
  SWARMFORGE_HOST: string;
  SWARMFORGE_ALLOWED_HOSTS: string;
}) => [
  v.SWARMFORGE_HOST,
  ...v.SWARMFORGE_ALLOWED_HOSTS.split(",")
    .map((s) => s.trim())
    .filter(Boolean),
];
const inputSchema = z
  .object({
    FREESTYLE_API_URL: z.url().default("https://api.freestyle.sh"),
    FREESTYLE_API_TOKEN: z.string().min(1),
    FREESTYLE_SNAPSHOT_ID: z.string().min(1),
    FREESTYLE_VPC: z.string().optional(),
    SWARMFORGE_WORKER_DOMAIN_SUFFIX: z
      .string()
      .min(1)
      .max(253)
      .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)
      .optional(),
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
    SWARMFORGE_GIT_PUSH_MODE: z
      .enum(["none", "github-app", "ssh"])
      .default("none"),
    SWARMFORGE_GIT_PUSH_TIMEOUT_MS: positive(120000),
    SWARMFORGE_GIT_AUTHOR_NAME: z
      .string()
      .min(1)
      .max(128)
      .default("SwarmForge Worker"),
    SWARMFORGE_GIT_AUTHOR_EMAIL: z
      .email()
      .default("swarmforge-worker@example.invalid"),
    SWARMFORGE_GIT_PUSH_URL: z.string().min(1).max(2048).optional(),
    SWARMFORGE_GIT_SSH_KEY_PATH: z.string().startsWith("/").optional(),
    SWARMFORGE_GIT_SSH_KNOWN_HOSTS_PATH: z.string().startsWith("/").optional(),
    SWARMFORGE_GITHUB_APP_ID: z.string().regex(/^\d+$/).optional(),
    SWARMFORGE_GITHUB_INSTALLATION_ID: z.string().regex(/^\d+$/).optional(),
    SWARMFORGE_GITHUB_PRIVATE_KEY_PATH: z.string().startsWith("/").optional(),
    SWARMFORGE_GITHUB_REPOSITORY: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
      .optional(),
    SWARMFORGE_WORKSPACE: z
      .string()
      .regex(/^\/(?:[a-zA-Z0-9_.-]+\/?)*$/)
      .refine((v) => !v.split("/").includes(".."))
      .default("/workspace"),
    SWARMFORGE_DB_PATH: z.string().min(1).default("./data/swarmforge.sqlite"),
    // Resolved below when unset: beside the database, or a private temporary root when the
    // database is in memory. The directory itself is created on first write with mode 0700.
    SWARMFORGE_ARTIFACT_DIR: z
      .string()
      .min(1)
      .max(4096)
      .refine((v) => !v.includes("\0"), "must not contain NUL")
      .optional(),
    SWARMFORGE_ARTIFACT_MAX_BYTES: bounded(1073741824, Number.MAX_SAFE_INTEGER),
    SWARMFORGE_ARTIFACT_MAX_ENTRIES: bounded(10000, 1000000),
    SWARMFORGE_ARTIFACT_MAX_DEPTH: bounded(32, 256),
    SWARMFORGE_ARTIFACT_TIMEOUT_MS: bounded(120000, 3600000),
    SWARMFORGE_ARTIFACT_CONCURRENCY: bounded(4, 64),
    SWARMFORGE_FINALIZATION_MAX_ATTEMPTS: bounded(3, 100),
    SWARMFORGE_FINALIZATION_RETRY_MS: bounded(2000, 3600000),
    SWARMFORGE_HOST: z.string().default("127.0.0.1"),
    SWARMFORGE_ALLOWED_HOSTS: z.string().default(""),
    SWARMFORGE_PORT: positive(8787).pipe(z.number().max(65535)),
    SWARMFORGE_API_TOKEN: z.string().min(24).optional(),
    SWARMFORGE_INPUT_USD_PER_MILLION: usd,
    SWARMFORGE_OUTPUT_USD_PER_MILLION: usd,
    SWARMFORGE_REASONING_USD_PER_MILLION: usd,
    SWARMFORGE_CACHE_READ_USD_PER_MILLION: usd,
    SWARMFORGE_CACHE_WRITE_USD_PER_MILLION: usd,
    SWARMFORGE_VM_USD_PER_HOUR: usd,
    SWARMFORGE_BUDGET_USD: usd,
    SWARMFORGE_RETENTION_MODE: z.enum(["off", "remind", "auto"]).default("off"),
    SWARMFORGE_RETENTION_SECONDS: bounded(86400, 6048000),
    SWARMFORGE_MAX_WORKERS: positive(50),
    SWARMFORGE_MAX_PROVISIONING: positive(4),
    SWARMFORGE_MAX_QUEUE: positive(1000),
    SWARMFORGE_DEFAULT_TIMEOUT_SECONDS: positive(3600),
    SWARMFORGE_PROVISION_TIMEOUT_SECONDS: positive(300),
    SWARMFORGE_TOKEN_IDLE_TIMEOUT_SECONDS: nonNegative(300),
    SWARMFORGE_POLL_INTERVAL_MS: positive(2000),
    SWARMFORGE_API_TIMEOUT_MS: positive(30000),
    SWARMFORGE_METRICS_ENABLED: bool(true),
    SWARMFORGE_METRICS_PORT: positive(9090).pipe(z.number().max(65535)),
    SWARMFORGE_METRICS_TEAMS: z.string().default("default"),
  })
  .superRefine((v, ctx) => {
    const required = (field: keyof typeof v) => {
      if (!v[field])
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: "Required for Git push mode",
        });
    };
    if (
      v.SWARMFORGE_GIT_PUSH_MODE !== "none" &&
      !gitTree(v.SWARMFORGE_GIT_TREE).clone
    )
      ctx.addIssue({
        code: "custom",
        path: ["SWARMFORGE_GIT_TREE"],
        message: "Automatic push requires a cloned Git tree",
      });
    if (v.SWARMFORGE_GIT_PUSH_MODE === "github-app") {
      required("SWARMFORGE_GITHUB_APP_ID");
      required("SWARMFORGE_GITHUB_INSTALLATION_ID");
      required("SWARMFORGE_GITHUB_PRIVATE_KEY_PATH");
      required("SWARMFORGE_GITHUB_REPOSITORY");
      if (
        v.SWARMFORGE_GITHUB_REPOSITORY &&
        ![
          `https://github.com/${v.SWARMFORGE_GITHUB_REPOSITORY}`,
          `https://github.com/${v.SWARMFORGE_GITHUB_REPOSITORY}.git`,
        ].includes(v.SWARMFORGE_GIT_TREE)
      )
        ctx.addIssue({
          code: "custom",
          path: ["SWARMFORGE_GIT_TREE"],
          message: "Must be the configured GitHub repository over HTTPS",
        });
    }
    if (v.SWARMFORGE_GIT_PUSH_MODE === "ssh") {
      required("SWARMFORGE_GIT_PUSH_URL");
      required("SWARMFORGE_GIT_SSH_KEY_PATH");
      required("SWARMFORGE_GIT_SSH_KNOWN_HOSTS_PATH");
    }
    const exposed = acceptedHosts(v).filter((host) => !isLoopbackHost(host));
    if (exposed.length > 0 && !v.SWARMFORGE_API_TOKEN)
      ctx.addIssue({
        code: "custom",
        path: ["SWARMFORGE_API_TOKEN"],
        message: `Required for a non-loopback accepted hostname: ${exposed.join(", ")}`,
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
const schema = inputSchema.transform((v) => ({
  ...v,
  SWARMFORGE_ARTIFACT_DIR:
    v.SWARMFORGE_ARTIFACT_DIR ?? defaultArtifactDir(v.SWARMFORGE_DB_PATH),
}));
export type Config = z.infer<typeof schema>;
/** Validate one prompted field with the same rules used by server startup. */
export function configFieldError(
  key: keyof Config,
  value: string,
): string | null {
  const result = inputSchema.shape[key].safeParse(value);
  return result.success
    ? null
    : result.error.issues.map((issue) => issue.message).join("; ");
}
// Beside the database by default. An in-memory database has no directory to sit beside, so it
// gets a unique private temporary root: never created here, only on first artifact write.
function defaultArtifactDir(database: string) {
  if (database === ":memory:")
    return join(tmpdir(), `swarmforge-artifacts-${randomUUID()}`);
  return join(dirname(resolve(database)), "artifacts");
}
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
export function gitTree(raw: string): { clone: boolean; target: string } {
  if (raw === "none") return { clone: false, target: "" };
  if (raw.startsWith("none:")) return { clone: false, target: raw.slice(5) };
  return { clone: true, target: raw };
}
export function workerEnvironment(
  c: Config,
  w: { worker_id: string; team_id: string; task_id: string },
): Record<string, string> {
  return {
    SWARMFORGE_WORKER_ID: w.worker_id,
    SWARMFORGE_TEAM_ID: w.team_id,
    SWARMFORGE_TASK_ID: w.task_id,
    SWARMFORGE_GIT_TREE: gitTree(c.SWARMFORGE_GIT_TREE).target,
    SWARMFORGE_WORKSPACE: c.SWARMFORGE_WORKSPACE,
    SWARMFORGE_MODEL_API_KEY: c.SWARMFORGE_MODEL_API_KEY,
    OPENCODE_PORT: String(c.OPENCODE_PORT),
  };
}
