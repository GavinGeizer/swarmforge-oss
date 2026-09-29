import { z } from "zod";
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
export const spawnSchema = z.object({
  team_id: idSchema.default("default"),
  task_id: idSchema,
  role: z.string().min(1).max(64).default("coder"),
  prompt: z.string().min(1).max(32000),
  timeout_seconds: z.number().int().min(1).max(604800).optional(),
  request_id: idSchema.optional(),
});
export type Spawn = z.infer<typeof spawnSchema>;
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
  | "artifact.created";
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
