// Shared artifact contracts. This module is decided once here: the transport,
// the storage backend, the service and the lifecycle/API layers all speak these
// types, so a change belongs in this file rather than in a caller's scratch copy.

/**
 * One bounded byte stream out of a worker guest, already staged privately
 * inside it. `size` and `sha256` describe the staged bytes exactly, so storage
 * can refuse a truncated or corrupted transfer without buffering it. `cleanup`
 * removes the private staging copy and is safe to call more than once.
 */
export interface ArtifactTransfer {
  stream: ReadableStream<Uint8Array>;
  size: number;
  sha256: string;
  filename: string;
  cleanup(): Promise<void>;
  /**
   * Set when the capture itself reports that what it staged is bounded evidence
   * rather than the whole source: a command that hit its byte bound, or a
   * deadline that arrived before a source finished. The bytes are still worth
   * keeping, and they are kept with this stated rather than presented as the
   * complete report.
   */
  incomplete?: string;
}

export interface ArtifactEntry {
  name: string;
  kind: "file" | "directory" | "symlink" | "other";
  /** Present for regular files only. */
  size?: number;
}

export interface ArtifactListing {
  entries: ArtifactEntry[];
  next_offset: number | null;
  /** Entries beyond `maxEntries` exist and were not described. */
  truncated?: boolean;
  /** Entries in the directory, bounded by `maxEntries`. */
  total?: number;
}

export interface ArtifactListingOptions {
  offset?: number;
  limit?: number;
  signal?: AbortSignal;
  maxEntries?: number;
  maxDepth?: number;
}

export interface ArtifactOpenOptions {
  /** Hard cap on the staged bytes. A larger source is refused, never cut. */
  maxBytes: number;
  signal?: AbortSignal;
  /** Stage only this window instead of the whole file. */
  offset?: number;
  length?: number;
}

export interface ArtifactSnapshotOptions {
  paths?: string[];
  maxBytes: number;
  maxEntries: number;
  maxDepth: number;
  signal?: AbortSignal;
}

export interface ArtifactDiagnosticsOptions {
  maxBytes: number;
  signal?: AbortSignal;
}

export interface ArtifactDiagnostic {
  /** Logical name of the capture, for example `logs/opencode-journal.txt`. */
  path: string;
  transfer: ArtifactTransfer;
  /**
   * What the capture itself recorded about its sources, such as a Git
   * directory that was absent. The same facts are also written inside the
   * captured bytes, so they survive with the artifact.
   */
  notes?: string[];
}

/**
 * The only way artifact bytes leave a worker guest. Providers that cannot offer
 * it fail clearly; there is no stat/read fallback, because re-resolving a path
 * per component is the race this interface exists to remove.
 */
export interface WorkerArtifactTransport {
  list(
    vmId: string,
    root: string,
    path: string,
    options?: ArtifactListingOptions,
  ): Promise<ArtifactListing>;
  open(
    vmId: string,
    root: string,
    path: string,
    options: ArtifactOpenOptions,
  ): Promise<ArtifactTransfer>;
  snapshot(
    vmId: string,
    root: string,
    options: ArtifactSnapshotOptions,
  ): Promise<ArtifactTransfer & { truncated?: boolean; entries?: number }>;
  diagnostics(
    vmId: string,
    root: string,
    options: ArtifactDiagnosticsOptions,
  ): Promise<ArtifactDiagnostic[]>;
}

export type ArtifactState = "preserving" | "preserved" | "failed";

export interface ArtifactRecord {
  artifact_id: string;
  task_id: string;
  worker_id: string;
  run_id: string | null;
  original_path: string;
  storage_key: string | null;
  filename: string;
  size: number;
  sha256: string | null;
  created_at: number;
  retrieved_at: number | null;
  state: ArtifactState;
  attempts: number;
  error: string | null;
  kind: string;
  /**
   * Set on a record whose published copy a later attempt replaced. The record
   * and its bytes stay: a failed recapture must not be able to take away the copy
   * that was already verified.
   */
  superseded_by?: string | null;
  /**
   * Set when the stored bytes are a bounded prefix of what was asked for, with
   * the reason. The artifact is readable and its hash matches its bytes, but it
   * is not the whole source, and a caller that must not act on partial evidence
   * has to be able to see that.
   */
  incomplete?: string | null;
}

export interface ArtifactListQuery {
  query?: string;
  kind?: string;
  state?: "preserving" | "preserved" | "failed";
  worker_id?: string;
  task_id?: string;
  offset?: number;
  limit?: number;
}

export interface ArtifactListResult {
  artifacts: ArtifactRecord[];
  next_offset: number | null;
}

export interface ArtifactPreserveOptions {
  signal?: AbortSignal;
  runId?: string | null;
  kind?: string;
}

export interface ArtifactSnapshotRequest {
  signal?: AbortSignal;
  paths?: string[];
  runId?: string | null;
}

/** Model-facing reads are bounded; raw storage stays faithful. */
export const safeReadLimit = 32768;

/** Workspace-relative artifact paths: no traversal, no absolute, no surprises. */
export const maxArtifactPathBytes = 1024;
export const maxArtifactPathComponents = 32;

export class ArtifactPathError extends Error {}

/**
 * The refusal taxonomy a capture reports, as stable codes.
 *
 * A caller classifies a refusal by code and never by its message text: an absent
 * source, a path that is not a directory, a path that is not permitted, a source
 * that is larger than its bound, a source that changed under the capture and a
 * plain transport failure are six different outcomes, and a salvage decision
 * that has to tell an optional missing file from a permission or symlink refusal
 * cannot be made from English.
 */
export const artifactErrorCodes = {
  notFound: "not_found",
  notDirectory: "not_directory",
  unsafePath: "unsafe_path",
  limitExceeded: "limit_exceeded",
  sourceChanged: "source_changed",
  transport: "transport",
} as const;

export type ArtifactErrorCode =
  (typeof artifactErrorCodes)[keyof typeof artifactErrorCodes];

const artifactErrorCodeValues: ReadonlySet<string> = new Set(
  Object.values(artifactErrorCodes),
);

/** True only for one of the six codes, never for an arbitrary string. */
export function isArtifactErrorCode(
  value: unknown,
): value is ArtifactErrorCode {
  return typeof value === "string" && artifactErrorCodeValues.has(value);
}

/** One canonical phrase per code, so a message always names its own class. */
export function describeArtifactError(code: ArtifactErrorCode): string {
  return {
    not_found: "no such file or directory",
    not_directory: "path is not a directory",
    unsafe_path: "path is not permitted",
    limit_exceeded: "artifact exceeds a configured limit",
    source_changed: "source changed during capture",
    transport: "artifact transport failed",
  }[code];
}

/** A refusal from a capture, carrying the code a caller can classify on. */
export class ArtifactCaptureError extends Error {
  constructor(
    message: string,
    readonly code: ArtifactErrorCode = artifactErrorCodes.transport,
  ) {
    super(message);
    this.name = "ArtifactCaptureError";
  }
}

/**
 * The code of any error that came from a capture, whatever raised it.
 *
 * A transport that is not the guest helper still produces something a salvage
 * decision can act on: an absence is not a permission failure, and neither is a
 * limit. Anything unrecognised stays a plain transport failure rather than being
 * guessed into a more specific class.
 */
export function artifactErrorCode(error: unknown): ArtifactErrorCode {
  const code = (error as { code?: unknown })?.code;
  if (isArtifactErrorCode(code)) return code;
  const text = String(
    error instanceof Error ? error.message : (error ?? ""),
  ).toLowerCase();
  if (/(no such|not found|enoent|does not exist)/.test(text))
    return artifactErrorCodes.notFound;
  if (/(not a directory|enotdir)/.test(text))
    return artifactErrorCodes.notDirectory;
  if (
    /(symlink|not permitted|permission denied|eacces|eperm|too many levels)/.test(
      text,
    )
  )
    return artifactErrorCodes.unsafePath;
  if (/(exceeds|out of range|limit|too large|truncat)/.test(text))
    return artifactErrorCodes.limitExceeded;
  if (/changed during capture/.test(text))
    return artifactErrorCodes.sourceChanged;
  return artifactErrorCodes.transport;
}

/** C0 controls, DEL and C1 controls: never legitimate in a path or entry name. */
export function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127 || (code >= 128 && code <= 159)) return true;
  }
  return false;
}

/**
 * Validates a workspace-relative path. Deliberately stricter than the kernel:
 * a path that is safe on one host may still be unsafe when it reaches a guest,
 * and a rejected path must never reach the filesystem at all.
 */
export function validateRelativePath(path: unknown): string {
  if (typeof path !== "string" || path.length === 0)
    throw new ArtifactPathError("Artifact path must be a non-empty string");
  if (Buffer.byteLength(path) > maxArtifactPathBytes)
    throw new ArtifactPathError("Artifact path exceeds 1024 bytes");
  if (path.startsWith("/") || path.startsWith("~"))
    throw new ArtifactPathError("Artifact path must be workspace-relative");
  if (path.includes("\\"))
    throw new ArtifactPathError("Artifact path must not contain backslashes");
  const parts = path.split("/");
  if (parts.length > maxArtifactPathComponents)
    throw new ArtifactPathError(
      `Artifact path has more than ${maxArtifactPathComponents} components`,
    );
  for (const part of parts) {
    if (!part || part === "." || part === "..")
      throw new ArtifactPathError(
        "Artifact path must not be empty or traverse directories",
      );
    if (hasControlCharacter(part))
      throw new ArtifactPathError("Artifact path contains a control character");
  }
  return parts.join("/");
}

/**
 * The absolute root a transport may open under. It comes from configuration,
 * never from a request, and it is opened with O_NOFOLLOW by the guest helper.
 */
export function validateRoot(root: unknown): string {
  if (typeof root !== "string" || !root.startsWith("/"))
    throw new ArtifactPathError("Artifact root must be an absolute path");
  // The whole VM filesystem is never a permitted capture root: it is not
  // coordinator-private, it cannot be walked with every component pinned, and a
  // configured workspace that resolves to it is a configuration error.
  if (root === "/")
    throw new ArtifactPathError(
      "Artifact root must be a directory inside the guest, not the filesystem root",
    );
  if (root.includes("\\") || root.includes("\0"))
    throw new ArtifactPathError("Artifact root contains an invalid character");
  if (Buffer.byteLength(root) > 4096)
    throw new ArtifactPathError("Artifact root exceeds 4096 bytes");
  const parts = root.split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === ".." || hasControlCharacter(part)))
    throw new ArtifactPathError("Artifact root must not traverse directories");
  return `/${parts.join("/")}`;
}

/** A storage filename: no separators, no traversal, bounded length. */
export function safeFilename(name: unknown, fallback = "artifact.bin"): string {
  const raw = typeof name === "string" ? name : "";
  const cleaned = raw
    .split("/")
    .at(-1)!
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 96);
  return cleaned.length >= 1 ? cleaned : fallback;
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** Every spelling of one secret a redactor looks for. */
export function secretVariants(secret: string): string[] {
  if (!secret) return [];
  return [
    ...new Set([
      secret,
      encodeURIComponent(secret),
      Buffer.from(secret).toString("base64"),
    ]),
  ];
}

/**
 * The overlap a screened read must inspect around the bytes it returns.
 *
 * Widths are byte lengths, because the stored bytes are bytes: a multi-byte
 * secret is wider than its character count, and an encoded variant is wider
 * than the secret itself. Bounded, because a read must stay bounded; a secret
 * too wide to screen inside that bound is refused rather than under-screened.
 */
export const screeningOverlapLimit = 65536;

export function screeningWindow(secrets: Iterable<string>): number {
  let widest = 0;
  for (const secret of secrets)
    for (const variant of secretVariants(secret))
      widest = Math.max(widest, Buffer.byteLength(variant));
  if (widest > screeningOverlapLimit)
    throw new Error(
      "Artifact read refused: a configured secret is wider than the bounded screening window",
    );
  return Math.max(4096, widest);
}

/**
 * Releases transfers nobody will read: the stream first, then the private
 * staging copy. Used when a group of captures is abandoned part way through.
 */
export async function cancelTransfers(
  transfers: { transfer: ArtifactTransfer }[],
): Promise<void> {
  for (const item of transfers) {
    try {
      await item.transfer.stream.cancel();
    } catch {
      // A stream that cannot be cancelled is already gone; the staging copy
      // still has to go.
    }
    await item.transfer.cleanup().catch(() => {});
  }
}
