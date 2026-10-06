/** Shared eligibility for conservative cleanup previews and atomic server admission. */
export interface CleanupWorker {
  state: string;
  vm_id?: string | null;
  vm_missing?: boolean;
  finalization?: { state: string } | null;
  pending_control?: string | null;
  pending_messages?: number;
}

const settled = new Set([
  "completed",
  "failed",
  "cancelled",
  "recovery_required",
]);

export function retainsVm(worker: CleanupWorker) {
  return !!worker.vm_id && !worker.vm_missing && worker.state !== "destroyed";
}

export function cleanupReadiness(worker: CleanupWorker) {
  if (!retainsVm(worker)) return { eligible: false, reason: "No retained VM" };
  if (!settled.has(worker.state))
    return { eligible: false, reason: "Task is active or paused" };
  if (worker.pending_control)
    return { eligible: false, reason: "A control action is pending" };
  if ((worker.pending_messages ?? 0) > 0)
    return { eligible: false, reason: "Follow-up work is pending" };
  if (worker.finalization?.state !== "preserved")
    return {
      eligible: false,
      reason: `Outputs ${worker.finalization?.state ?? "not collected"}`,
    };
  return {
    eligible: true,
    reason: "Outputs preserved; Git check runs on destruction",
  };
}
