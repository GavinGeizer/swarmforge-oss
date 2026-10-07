import type { Config } from "./config";
import type { Worker, WorkerResult } from "./domain";
import type { Store } from "./store";

export interface UsageEstimate {
  currency: "USD";
  estimated_usd: number | null;
  token_estimated_usd: number | null;
  vm_estimated_usd: number | null;
  retained_vm_hours: number;
  measured_tokens: number;
  priced_tokens: number;
  complete: boolean;
  budget_usd: number | null;
  budget_exceeded: boolean;
}

export function usageEstimate(
  store: Store,
  config: Config,
  workerId?: string,
  now = Date.now(),
): UsageEstimate {
  const groups = store.usageByModel(workerId);
  let tokenCost = 0;
  let priced = 0;
  let measured = 0;
  let hasRate = false;
  const rates = {
    input: config.SWARMFORGE_INPUT_USD_PER_MILLION,
    output: config.SWARMFORGE_OUTPUT_USD_PER_MILLION,
    reasoning: config.SWARMFORGE_REASONING_USD_PER_MILLION,
    cache_read: config.SWARMFORGE_CACHE_READ_USD_PER_MILLION,
    cache_write: config.SWARMFORGE_CACHE_WRITE_USD_PER_MILLION,
  };
  for (const row of groups)
    for (const [category, rate] of Object.entries(rates)) {
      const amount = row[category as keyof typeof rates];
      measured += amount;
      if (row.model === config.SWARMFORGE_MODEL_NAME && rate !== undefined) {
        hasRate = true;
        priced += amount;
        tokenCost += (amount * rate) / 1_000_000;
      }
    }
  const hours = store.retainedVmMilliseconds(workerId, now) / 3_600_000;
  const vmCost =
    config.SWARMFORGE_VM_USD_PER_HOUR === undefined
      ? null
      : hours * config.SWARMFORGE_VM_USD_PER_HOUR;
  const token = hasRate ? tokenCost : null;
  const total =
    token === null && vmCost === null ? null : (token ?? 0) + (vmCost ?? 0);
  const budget = workerId ? null : (config.SWARMFORGE_BUDGET_USD ?? null);
  return {
    currency: "USD",
    estimated_usd: total,
    token_estimated_usd: token,
    vm_estimated_usd: vmCost,
    retained_vm_hours: hours,
    measured_tokens: measured,
    priced_tokens: priced,
    complete: measured === priced && (hours === 0 || vmCost !== null),
    budget_usd: budget,
    budget_exceeded: budget !== null && total !== null && total >= budget,
  };
}

export function recoveryGuidance(
  w: Worker,
  result: WorkerResult | null,
  pending: number,
) {
  const actions: string[] = [];
  let explanation =
    "Task is progressing; inspect the latest activity and result.";
  if (w.state === "destroyed" || w.vm_missing) {
    explanation =
      "The VM workspace is unavailable. Preserved artifacts and persisted results remain accessible.";
    actions.push("list_artifacts", "get_worker_result");
    if (
      (result?.status !== "completed" && w.state !== "completed") ||
      result?.needs_followup
    )
      actions.push(
        "spawn_worker with a new task/request ID using preserved inputs",
      );
  } else if (w.intent) {
    explanation = `A ${w.intent} operation is pending; inspect current state before requesting another control action.`;
    actions.push("get_worker", "get_worker_logs");
  } else if (w.state === "paused") {
    explanation =
      "The VM is paused. Inspect the error and logs, then resume when ready.";
    actions.push("get_worker_logs", "resume_worker");
  } else if (["failed", "cancelled", "recovery_required"].includes(w.state)) {
    explanation =
      "The task stopped. Inspect the result and logs before choosing follow-up work or a replacement worker.";
    actions.push("get_worker_result", "get_worker_logs");
    if (w.state !== "cancelled" && w.vm_id && w.opencode_session_id)
      actions.push("send_worker_message after resolving the failure");
    else actions.push("spawn_worker with a new request ID");
  } else if (w.state === "waiting") {
    explanation =
      "The worker is waiting; inspect the response for requested input.";
    actions.push("get_worker", "send_worker_message");
  }
  if (
    w.finalization?.state === "failed" &&
    w.vm_id &&
    !w.vm_missing &&
    w.state !== "destroyed"
  ) {
    explanation +=
      " Output preservation failed; the VM must be retained until collection succeeds.";
    actions.push("retry_worker_finalization");
  }
  if (result?.needs_followup) {
    explanation += ` Follow-up requested: ${result.followup_reason ?? "inspect the result"}.`;
    actions.push("get_worker_result");
  }
  if (pending) explanation += ` ${pending} message(s) are pending.`;
  return { explanation, actions: [...new Set(actions)] };
}

export function taskProgress(
  w: Worker,
  result: WorkerResult | null,
  now = Date.now(),
) {
  const end = w.completed_at ?? now;
  return {
    queue_ms: Math.max(
      0,
      (w.provision_started_at ?? w.started_at ?? end) - w.created_at,
    ),
    run_ms: w.started_at === null ? 0 : Math.max(0, end - w.started_at),
    idle_ms: Math.max(
      0,
      now - Math.max(w.token_progress_at ?? 0, w.last_activity_at),
    ),
    last_meaningful_activity_at: Math.max(
      w.token_progress_at ?? 0,
      w.last_activity_at,
    ),
    source: w.token_progress_at
      ? "dispatch/token activity"
      : "lifecycle activity",
    summary: result?.summary.slice(0, 240) ?? null,
    files_changed: result?.files_changed.length ?? 0,
    tests_passed: result?.tests?.passed ?? null,
    needs_followup: result?.needs_followup ?? false,
    review_url: result?.git?.review_url ?? null,
  };
}
