import { z } from "zod";
import {
  hasControlCharacter,
  maxArtifactPathBytes,
  maxArtifactPathComponents,
  type WorkerArtifactTransport,
} from "./artifact-types";
export const states = [
  "queued",
  "provisioning",
  "booting",
  "ready",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "paused",
  "destroyed",
  "recovery_required",
] as const;
export type WorkerState = (typeof states)[number];
export const terminal = new Set<WorkerState>([
  "completed",
  "failed",
  "cancelled",
  "destroyed",
  "recovery_required",
]);
export const idSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.:-]+$/);
// Artifact preservation is separate from the task outcome, so it carries its own durable
// states: a retained worker can be preserved, still collecting, exhausted, or explicitly
// abandoned by a forced destruction.
export const finalizationStates = [
  "pending",
  "collecting",
  "preserved",
  "failed",
  "abandoned",
] as const;
export type FinalizationState = (typeof finalizationStates)[number];
export const finalizationSettled = new Set<FinalizationState>([
  "preserved",
  "failed",
  "abandoned",
]);
export interface WorkerFinalization {
  state: FinalizationState;
  run_id: string | null;
  attempts: number;
  error: string | null;
  next_retry_at: number | null;
  started_at: number | null;
  completed_at: number | null;
}
export interface ArtifactDeclaration {
  path: string;
  required: boolean;
  directory: boolean;
}
export const artifactDepth = maxArtifactPathComponents;
// Workspace-relative artifact paths only, checked with the same rules the data plane applies
// when it opens a path: no traversal, no absolute paths, no backslashes, no C0, DEL or C1
// control characters. The only wildcard accepted is the trailing "/**" directory marker.
export function artifactPathProblem(raw: string): string | null {
  if (Buffer.byteLength(raw) > maxArtifactPathBytes)
    return `Artifact path exceeds ${maxArtifactPathBytes} bytes`;
  if (raw.startsWith("/")) return "Artifact path must be workspace-relative";
  if (raw.includes("\\")) return "Artifact path must not contain backslashes";
  const directory = raw.endsWith("/**");
  const path = directory ? raw.slice(0, -3) : raw;
  const parts = path.split("/");
  if (!path || parts.some((part) => !part || part === "." || part === ".."))
    return "Artifact path must not contain empty or relative components";
  if (parts.length > maxArtifactPathComponents)
    return `Artifact path exceeds ${maxArtifactPathComponents} components`;
  if (path.startsWith("~")) return "Artifact path must be workspace-relative";
  if (hasControlCharacter(path))
    return "Artifact path must not contain control characters";
  if (parts.some((part) => /[*?[\]{}]/.test(part)))
    return "Artifact path wildcards are not allowed";
  return null;
}
export const artifactPathSchema = z
  .string()
  .min(1)
  .max(maxArtifactPathBytes)
  .superRefine((value, ctx) => {
    const problem = artifactPathProblem(value);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });
export const artifactDeclarationSchema = z
  .object({ path: artifactPathSchema, required: z.boolean().default(false) })
  .transform(({ path, required }) => ({
    path: path.endsWith("/**") ? path.slice(0, -3) : path,
    required,
    directory: path.endsWith("/**"),
  }));
export const artifactDeclarationsSchema = z
  .array(artifactDeclarationSchema)
  .max(100)
  .default([]);
export const spawnSchema = z.object({
  team_id: idSchema.default("default"),
  task_id: idSchema,
  role: z.string().min(1).max(64).default("coder"),
  prompt: z.string().min(1).max(32000),
  timeout_seconds: z.number().int().min(1).max(604800).optional(),
  request_id: idSchema.optional(),
  artifacts: artifactDeclarationsSchema,
  // Full workspace snapshots stay opt-in: explicitly requested, or configured for failures.
  snapshot_on_failure: z.boolean().default(false),
});
export type Spawn = z.infer<typeof spawnSchema>;
// Preservation declarations are optional on any creation request, including the internal ones
// that never collect anything.
export type SpawnRequest = Omit<Spawn, "artifacts" | "snapshot_on_failure"> & {
  artifacts?: ArtifactDeclaration[];
  snapshot_on_failure?: boolean;
};
export const resultSchema = z
  .object({
    worker_id: z.string().max(128).optional(),
    task_id: z.string().max(128).optional(),
    run_id: z.string().max(128).optional(),
    status: z.enum(["completed", "failed"]),
    summary: z.string().min(1).max(4000),
    details: z.string().max(16000).optional(),
    files_changed: z.array(z.string().max(1024)).max(200).default([]),
    tests: z
      .object({
        ran: z.boolean(),
        passed: z.boolean().nullable().optional(),
        command: z.string().max(2000).optional(),
        summary: z.string().max(4000).optional(),
      })
      .optional(),
    git: z
      .object({
        tree: z.string().max(2048).optional(),
        workspace: z.string().max(2048).optional(),
        branch: z.string().max(512).optional(),
        commit: z.string().max(128).optional(),
        base_commit: z.string().max(128).optional(),
        review_url: z.string().max(2048).optional(),
        dirty: z.boolean().optional(),
        persisted: z.boolean().optional(),
      })
      .optional(),
    warnings: z.array(z.string().max(2000)).max(50).default([]),
    needs_followup: z.boolean().default(false),
    followup_reason: z.string().max(4000).nullable().optional(),
  })
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value)) <= 61440,
    "Structured result exceeds 60 KiB; place large reports in artifacts",
  );
export type WorkerResult = z.infer<typeof resultSchema>;
export interface Worker {
  worker_id: string;
  team_id: string;
  task_id: string;
  role: string;
  state: WorkerState;
  prompt: string;
  timeout_seconds: number;
  request_id?: string;
  request_fingerprint: string;
  vm_id: string | null;
  vm_missing: boolean;
  opencode_session_id: string | null;
  endpoint: string | null;
  server_password: string;
  created_at: number;
  started_at: number | null;
  last_activity_at: number;
  completed_at: number | null;
  provision_started_at: number | null;
  deadline_at: number | null;
  paused_at: number | null;
  previous_state: WorkerState | null;
  token_progress_at?: number | null;
  token_progress_total?: number;
  error: string | null;
  intent: "pause" | "resume" | "cancel" | "destroy" | null;
  force_destroy: boolean;
  artifacts: ArtifactDeclaration[];
  snapshot_on_failure: boolean;
  finalization?: WorkerFinalization;
}
export interface Dispatch {
  run_id: string;
  worker_id: string;
  message_id: string;
  message: string;
  state: "pending" | "sending" | "sent" | "completed" | "cancelled";
  created_at: number;
  sent_at: number | null;
  result: WorkerResult | null;
}
export type EventType =
  | `worker.${WorkerState | "requested" | "resumed"}`
  | "result.received"
  | "artifact.created"
  // One attempted event per collection attempt, persisted before any transfer starts, plus
  // exactly one settled outcome per collection. Cumulative counters are rebuilt from these.
  | "finalization.attempted"
  | "finalization.preserved"
  | "finalization.failed"
  | "finalization.abandoned";
export interface WorkerEvent {
  id: number;
  worker_id: string;
  type: EventType;
  at: number;
  data: string;
}
// A creation event carries no state name of its own; the record is always created queued.
export function lifecycleState(type: string): WorkerState | null {
  if (type === "worker.requested") return "queued";
  const name = type.startsWith("worker.") ? type.slice(7) : "";
  return (states as readonly string[]).includes(name)
    ? (name as WorkerState)
    : null;
}
export interface StateChangeFilter {
  worker_id?: string;
  team_id?: string;
  task_id?: string;
  states?: WorkerState[];
  cursor?: number;
}
export interface StateChange {
  event_id: number;
  worker_id: string;
  state: WorkerState;
  at: number;
}
export interface StateChangeResult {
  changed: boolean;
  event_id: number | null;
  next_cursor: number;
  worker_id: string | null;
  team_id: string | null;
  task_id: string | null;
  vm_id: string | null;
  state: WorkerState | null;
  at: number | null;
}
export interface VmInfo {
  id: string;
  slug: string;
  state: string;
  worker_id?: string;
}
export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}
export interface FileInfo {
  name: string;
  kind: string;
}
export interface WorkerProvider {
  createWorker(w: Worker): Promise<VmInfo>;
  getWorker(id: string): Promise<VmInfo | null>;
  listWorkers(): Promise<VmInfo[]>;
  prepare(w: Worker): Promise<string>;
  pushBranch(w: Worker): Promise<{
    branch: string;
    commit: string;
    base_commit: string;
    review_url?: string;
  }>;
  pauseWorker(id: string): Promise<void>;
  resumeWorker(id: string): Promise<void>;
  destroyWorker(id: string): Promise<void>;
  exec(id: string, command: string): Promise<ExecResult>;
  readFile(
    id: string,
    path: string,
    offset?: number,
    length?: number,
  ): Promise<Uint8Array>;
  writeFile(id: string, path: string, content: string): Promise<void>;
  listFiles(id: string, path: string): Promise<FileInfo[]>;
  stat(
    id: string,
    path: string,
  ): Promise<{ size: number; isFile: boolean; isSymlink: boolean }>;
  // Raw artifact bytes come from the provider transport, never from exec output or a
  // stat-then-read race. A provider without it fails clearly instead of degrading unsafely.
  artifactTransport?: WorkerArtifactTransport;
}
export interface AgentMessage {
  id: string;
  parent_id?: string;
  role: "user" | "assistant";
  completed: boolean;
  result?: unknown;
  error?: string;
  model?: string;
  text?: string;
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  cache_write: number;
}
export const excerptLimit = 180;
export interface ResponseExcerpt {
  text: string;
  at: number;
  partial: boolean;
}
export interface AgentSnapshot {
  // "unknown" is a reported /session/status type this version does not recognize. It is
  // never proof that a turn finished; an absent entry is read as idle, not as unknown.
  status: "idle" | "busy" | "retry" | "unknown";
  messages: AgentMessage[];
  inference_active: number;
}
export interface CodingAgent {
  ensureSession(w: Worker): Promise<string>;
  submit(w: Worker, d: Dispatch): Promise<void>;
  inspect(w: Worker): Promise<AgentSnapshot>;
  abort(w: Worker): Promise<void>;
}
