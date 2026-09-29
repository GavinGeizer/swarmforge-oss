import type { Coordinator } from "./coordinator";
import { excerptLimit } from "./domain";
export class Redactor {
  constructor(readonly secrets: () => string[]) {}
  private variants() {
    const all = new Set<string>();
    for (const secret of this.secrets().filter(Boolean))
      for (const variant of [
        secret,
        encodeURIComponent(secret),
        Buffer.from(secret).toString("base64"),
      ])
        all.add(variant);
    return [...all].sort((a, b) => b.length - a.length);
  }
  text(value: string) {
    let text = value;
    for (const variant of this.variants())
      text = text.replaceAll(variant, "[REDACTED]");
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
    const text = Buffer.from(bytes).toString("utf8");
    if (this.text(text) !== text) return true;
    // Escapes, terminal-invisible code points and whitespace runs are folded away
    // by every renderer between here and the reader, so screen the folded text as
    // well: a credential spelled only once those characters are dropped is still a
    // credential. This catches that shape of splitting, not arbitrary obfuscation.
    const folded = sanitizeText(text);
    return folded !== text && this.text(folded) !== folded;
  }
  // Longest form the redactor screens for. A bounded read must overlap its window
  // by at least this many bytes for a credential straddling the edge to be seen whole.
  guardWidth() {
    let longest = 0;
    for (const variant of this.variants())
      longest = Math.max(longest, variant.length);
    return longest;
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
// Fold the characters every renderer drops: escapes, terminal-invisible code
// points and whitespace runs. Used to screen untrusted text before it is shown.
export function sanitizeText(value: string) {
  const chars = [...value];
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
  return out.replace(/\s+/g, " ").trim();
}
// Model output is untrusted: redact before trimming so a secret split by truncation is never partially revealed.
export function excerptText(value: string, redact: (text: string) => string) {
  // Redact again after folding: dropping the characters below can join the pieces
  // of a credential that the first pass could not match.
  const clean = redact(sanitizeText(redact(value)));
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
    tokens: c.store.tokens({ worker_id: id }),
    pending_messages: c.store
      .dispatches(id)
      .filter((d) => ["pending", "sending", "sent"].includes(d.state)).length,
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
