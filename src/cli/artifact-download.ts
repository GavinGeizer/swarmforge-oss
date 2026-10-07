import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface DownloadMetadata {
  artifact_id: string;
  state: string;
  size: number | null;
  sha256: string | null;
}

/** Stream verified bytes to a private sibling, then publish without replacing an existing path. */
export async function downloadArtifact(
  endpoint: string,
  token: string | undefined,
  metadata: DownloadMetadata,
  output: string,
  signal?: AbortSignal,
) {
  if (
    metadata.state !== "preserved" ||
    !Number.isSafeInteger(metadata.size) ||
    metadata.size === null ||
    metadata.size < 0 ||
    !/^[a-f0-9]{64}$/i.test(metadata.sha256 ?? "")
  )
    throw new Error(
      "Artifact is not preserved with valid size and checksum metadata",
    );
  const destination = resolve(output);
  try {
    await lstat(destination);
    throw new Error("Output already exists; choose a new path");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const abort = AbortSignal.any([
    AbortSignal.timeout(120000),
    ...(signal ? [signal] : []),
  ]);
  abort.throwIfAborted();
  const url = new URL(
    `/artifacts/${encodeURIComponent(metadata.artifact_id)}/download`,
    endpoint,
  );
  url.username = "";
  url.password = "";
  const response = await fetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
    redirect: "error",
    signal: abort,
  });
  if (response.status !== 200 || (!response.body && metadata.size !== 0)) {
    await response.body?.cancel();
    throw new Error(`Artifact download failed (HTTP ${response.status})`);
  }
  const reader = (
    response.body ??
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    })
  ).getReader();
  const temporary = join(
    dirname(destination),
    `.swarmforge-download-${randomUUID()}.tmp`,
  );
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  let bytes = 0;
  const hash = createHash("sha256");
  try {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    file = await open(temporary, "wx", 0o600);
    created = true;
    while (true) {
      abort.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > metadata.size)
        throw new Error("Download exceeds the declared artifact size");
      hash.update(chunk.value);
      let offset = 0;
      while (offset < chunk.value.length) {
        const written = await file.write(
          chunk.value,
          offset,
          chunk.value.length - offset,
        );
        if (!written.bytesWritten) throw new Error("Unable to write download");
        offset += written.bytesWritten;
      }
    }
    const sha256 = hash.digest("hex");
    if (bytes !== metadata.size || sha256 !== metadata.sha256!.toLowerCase())
      throw new Error("Artifact size or SHA-256 verification failed");
    await file.sync();
    await file.close();
    file = undefined;
    abort.throwIfAborted();
    await link(temporary, destination);
    return { path: destination, bytes, sha256 };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    await file?.close().catch(() => {});
    if (created) await unlink(temporary).catch(() => {});
  }
}
