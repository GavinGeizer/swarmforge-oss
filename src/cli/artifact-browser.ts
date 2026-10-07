import type { ArtifactSummary } from "./client";
import { safeTerminalText } from "./terminal";

export function renderArtifactBrowser(
  workerId: string,
  artifacts: ArtifactSummary[],
  selected: number,
  offset: number,
  next: number | null,
  width = 100,
) {
  const lines = [
    `ARTIFACTS  ${workerId}`,
    `Page starts at ${offset} · ${artifacts.length} records loaded`,
    "",
  ];
  for (const [index, artifact] of artifacts.entries())
    lines.push(
      `${index === selected ? "›" : " "} ${artifact.filename} · ${artifact.state} · ${artifact.size ?? "?"} bytes`,
      `    ID: ${artifact.artifact_id}`,
      `    SHA256: ${artifact.sha256 ?? "unavailable"}`,
      "",
    );
  if (!artifacts.length) lines.push("No artifacts on this page.");
  lines.push(
    `↑/↓ select · Enter save · ${offset ? "[ previous · " : ""}${next !== null ? "] next · " : ""}Esc back · q quit`,
  );
  return lines
    .map((line) => {
      const chars = Array.from(safeTerminalText(line));
      return chars.length > width
        ? `${chars.slice(0, width - 1).join("")}…`
        : chars.join("");
    })
    .join("\n");
}
