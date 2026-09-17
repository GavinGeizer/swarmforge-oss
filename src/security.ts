import type { Coordinator } from "./coordinator";
export class Redactor {
  constructor(readonly secrets: () => string[]) {}
  text(value: string) {
    let text = value;
    for (const secret of this.secrets()
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)) {
      for (const variant of new Set([
        secret,
        encodeURIComponent(secret),
        Buffer.from(secret).toString("base64"),
      ]))
        text = text.replaceAll(variant, "[REDACTED]");
    }
    return text
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[REDACTED]@")
      .replace(
        /([?&](?:token|key|api_key|password)=)[^&\s]+/gi,
        "$1[REDACTED]",
      );
  }
  value(value: unknown): unknown {
    if (typeof value === "string") return this.text(value);
    if (Array.isArray(value)) return value.map((v) => this.value(v));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [
          k,
          /^(?:authorization|api[_-]?key|.*password|.*secret|.*token)$/i.test(k)
            ? "[REDACTED]"
            : this.value(v),
        ]),
      );
    return value;
  }
  contains(bytes: Uint8Array) {
    const s = Buffer.from(bytes).toString("utf8");
    return this.text(s) !== s;
  }
}
export function redactorFor(c: Coordinator) {
  return new Redactor(() => [
    c.config.FREESTYLE_API_TOKEN,
    c.config.SWARMFORGE_MODEL_API_KEY,
    c.config.SWARMFORGE_API_TOKEN ?? "",
    ...c.store.all().map((w) => w.server_password),
  ]);
}
export function publicWorker(c: Coordinator, id: string) {
  const w = c.store.get(id);
  return {
    worker_id: w.worker_id,
    team_id: w.team_id,
    task_id: w.task_id,
    role: w.role,
    state: w.state,
    vm_id: w.vm_id,
    vm_missing: w.vm_missing,
    opencode_session_id: w.opencode_session_id,
    created_at: w.created_at,
    started_at: w.started_at,
    last_activity_at: w.last_activity_at,
    completed_at: w.completed_at,
    deadline_at: w.deadline_at,
    error: w.error,
    pending_control: w.intent,
    tokens: c.store.tokens({ worker_id: id }),
    pending_messages: c.store
      .dispatches(id)
      .filter((d) => ["pending", "sending", "sent"].includes(d.state)).length,
  };
}
