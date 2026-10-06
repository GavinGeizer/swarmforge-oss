import type { Coordinator } from "./coordinator";
import { excerptLimit } from "./domain";
export class Redactor {
  private cached: { version: unknown; values: string[] } | undefined;
  constructor(
    readonly secrets: () => string[],
    private readonly version?: () => unknown,
  ) {}
  private variants() {
    const version = this.version?.();
    if (this.version && this.cached && this.cached.version === version)
      return this.cached.values;
    const values = [
      ...new Set(
        this.secrets()
          .filter(Boolean)
          .flatMap((secret) => [
            secret,
            encodeURIComponent(secret),
            Buffer.from(secret).toString("base64"),
          ]),
      ),
    ].sort((a, b) => b.length - a.length);
    if (this.version) this.cached = { version, values };
    return values;
  }
  /** Artifact ranges need a complete credential, including its encoded forms. */
  credentialOverlapBytes() {
    return this.variants().reduce(
      (maximum, value) => Math.max(maximum, Buffer.byteLength(value)),
      0,
    );
  }
  text(value: string) {
    let text = value;
    const variants = this.variants();
    // The list is longest first. Skip credentials that cannot fit in this value.
    let low = 0;
    let high = variants.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (variants[middle]!.length > value.length) low = middle + 1;
      else high = middle;
    }
    for (let index = low; index < variants.length; index++)
      text = text.replaceAll(variants[index]!, "[REDACTED]");
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
const redactors = new WeakMap<Coordinator, Redactor>();
export function redactorFor(c: Coordinator) {
  let redactor = redactors.get(c);
  if (!redactor) {
    let cached: { version: unknown; values: string[] } | undefined;
    const version = () =>
      c.store.db.inTransaction
        ? Symbol("transactional credentials")
        : JSON.stringify([
            c.store.revision(),
            c.config.FREESTYLE_API_TOKEN,
            c.config.SWARMFORGE_MODEL_API_KEY,
            c.config.SWARMFORGE_API_TOKEN,
          ]);
    redactor = new Redactor(() => {
      const current = version();
      if (cached?.version !== current)
        cached = {
          version: current,
          values: [
            c.config.FREESTYLE_API_TOKEN,
            c.config.SWARMFORGE_MODEL_API_KEY,
            c.config.SWARMFORGE_API_TOKEN ?? "",
            ...c.store.credentials(),
          ],
        };
      return cached!.values;
    }, version);
    redactors.set(c, redactor);
  }
  return redactor;
}

function isSpace(code: number) {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}
// Terminal-invisible code points: C0/C1 controls, bidi overrides, zero width and BOM.
function isInvisible(code: number) {
  return (
    code < 32 ||
    code === 127 ||
    (code >= 128 && code <= 159) ||
    code === 0xad ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2064) ||
    (code >= 0x2066 && code <= 0x206f) ||
    code === 0xfeff
  );
}
function escapeLength(chars: string[], index: number) {
  const marker = chars[index + 1];
  if (marker === "[") {
    let end = index + 2;
    while (end < chars.length && !/[@-~]/.test(chars[end]!)) end++;
    return end < chars.length ? end + 1 : chars.length;
  }
  if (marker === "]") {
    let end = index + 2;
    while (end < chars.length) {
      if (chars[end] === "\u0007") return end + 1;
      if (chars[end] === "\u001b" && chars[end + 1] === "\\") return end + 2;
      end++;
    }
    return chars.length;
  }
  return Math.min(chars.length, index + 2);
}
// Protect intact credentials first, then redact anything reconstructed by cleanup.
// Both passes happen before truncation, which could otherwise expose a secret fragment.
export function excerptText(value: string, redact: (text: string) => string) {
  const chars = [...redact(value)];
  let out = "";
  for (let index = 0; index < chars.length; ) {
    const code = chars[index]!.codePointAt(0)!;
    if (code === 27) {
      const end = escapeLength(chars, index);
      out += " ";
      index = end;
      continue;
    }
    out += isSpace(code) ? " " : isInvisible(code) ? "" : chars[index];
    index++;
  }
  const clean = redact(out.replace(/\s+/g, " ").trim());
  if (!clean) return "";
  const tail = [...clean];
  if (tail.length <= excerptLimit) return clean;
  const bounded = tail.slice(tail.length - excerptLimit);
  let start = 0;
  while (
    start < bounded.length - 1 &&
    start < 24 &&
    !/\s/.test(bounded[start]!)
  )
    start++;
  while (start < bounded.length - 1 && /\p{M}/u.test(bounded[start]!)) start++;
  const body = bounded.slice(start).join("").trim();
  return body ? `…${body}` : "";
}
export function publicWorker(c: Coordinator, id: string, detail = false) {
  const w = c.store.get(id);
  const excerpt = detail ? c.excerpt(id) : null;
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
    // Preservation is reported separately so completed, failed and cancelled keep their own
    // meaning for clients, and an exhausted collection is visible with its attempts and error.
    finalization: w.finalization ?? null,
    tokens: c.store.tokens({ worker_id: id }),
    pending_messages: c.store.pendingMessages(id),
    // Ephemeral, bounded and only on the single-worker view; never listed or persisted.
    ...(excerpt
      ? {
          excerpt: excerpt.text,
          excerpt_partial: excerpt.partial,
          excerpt_at: excerpt.at,
        }
      : {}),
  };
}
