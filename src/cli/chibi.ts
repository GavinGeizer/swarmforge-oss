import { retainsVm } from "../cleanup";
import type { OverviewData } from "./overview";

export type ChibiMood =
  | "idle"
  | "thinking"
  | "working"
  | "excited"
  | "sleeping"
  | "error";
export interface ChibiStatus {
  mood: ChibiMood;
  title: string;
  message: string;
  working: number;
  waiting: number;
  preparing: number;
  completed: number;
  failed: number;
}
const total = (data: OverviewData, names: string[]) =>
  names.reduce((sum, name) => sum + (data.states[name] ?? 0), 0);

export function chibiStatus(
  data: OverviewData,
  now = Date.now(),
  connectionError = false,
): ChibiStatus {
  const working = total(data, ["running"]);
  const waiting = total(data, ["waiting"]);
  const preparing = total(data, ["queued", "provisioning", "booting", "ready"]);
  const completed = total(data, ["completed"]);
  const failed = total(data, ["failed", "recovery_required"]);
  const recentCompletion = data.workers.some(
    (worker) =>
      worker.state === "completed" &&
      worker.completed_at !== null &&
      now >= worker.completed_at &&
      now - worker.completed_at < 60_000,
  );
  const attention = data.workers.some(
    (worker) =>
      worker.state === "recovery_required" ||
      (retainsVm(worker) &&
        (worker.state === "failed" ||
          worker.finalization?.state === "failed")) ||
      (["completed", "failed"].includes(worker.state) &&
        worker.progress?.needs_followup &&
        !worker.pending_control &&
        !(worker.pending_messages ?? 0)),
  );
  let mood: ChibiMood = "idle";
  let title = "Ready when you are.";
  let message = "Assign a task from your MCP client.";
  if (connectionError) {
    mood = "error";
    title = "Refresh needs attention.";
    message = "Some data could not be refreshed. Press r to retry.";
  } else if (attention || (data.states.recovery_required ?? 0) > 0) {
    mood = "error";
    title = attention
      ? "A worker in view needs a hand."
      : "A worker needs recovery.";
    message = "Inspect the task or open notifications for context.";
  } else if (working) {
    mood = "working";
    title = "Swarm's on it!";
    message = `${working} working · ${waiting} waiting · ${completed} completed`;
  } else if (preparing || waiting) {
    mood = "thinking";
    title = preparing ? "Getting work ready." : "Waiting for the next step.";
    message = preparing
      ? `${preparing} queued or preparing · ${waiting} waiting`
      : `${waiting} worker${waiting === 1 ? "" : "s"} waiting for follow-up`;
  } else if (recentCompletion) {
    mood = "excited";
    title = "Task complete!";
    message = "Open the result and collect its deliverables.";
  } else if (
    total(data, ["paused", "completed", "failed", "cancelled", "destroyed"])
  ) {
    mood = "sleeping";
    title = "No workers running.";
    message =
      (data.states.paused ?? 0)
        ? `${data.states.paused} paused · no workers running`
        : "Inspect this page's history or browse artifacts.";
  }
  return {
    mood,
    title,
    message,
    working,
    waiting,
    preparing,
    completed,
    failed,
  };
}

const palette: Record<string, [number, number, number]> = {
  c: [244, 231, 197], // cream helmet / limbs
  w: [255, 245, 219], // wings
  k: [44, 49, 54], // armor outline
  b: [21, 25, 30], // dark visor
  g: [255, 192, 67], // antennae, eyes and hive badge
  s: [81, 91, 106], // shoulder armor / laptop
  r: [246, 112, 133], // attention expression
};

/** Terminal-native pixel art inspired by swarmforgechibi.png; no raster payload. */
function sprite(mood: ChibiMood, blink: boolean) {
  const grid = Array.from({ length: 20 }, () => Array<string>(24).fill("."));
  const dot = (x: number, y: number, color: string) => {
    if (x >= 0 && x < 24 && y >= 0 && y < 20) grid[y]![x] = color;
  };
  const box = (
    left: number,
    top: number,
    width: number,
    height: number,
    color: string,
  ) => {
    for (let y = top; y < top + height; y++)
      for (let x = left; x < left + width; x++) dot(x, y, color);
  };
  // Wings behind the silhouette, small boots and torso beneath the large helmet.
  box(1, 8, 3, 2, "w");
  box(2, 10, 3, 2, "w");
  box(2, 13, 3, 2, "w");
  box(7, 13, 11, 5, "k");
  box(8, 14, 9, 3, "b");
  box(7, 18, 4, 2, "k");
  box(14, 18, 4, 2, "k");
  box(8, 19, 3, 1, "g");
  box(14, 19, 3, 1, "g");
  box(5, 14, 3, 4, "c");
  box(17, 14, 3, 4, "c");
  box(5, 17, 3, 1, "k");
  box(17, 17, 3, 1, "k");
  dot(12, 14, "g");
  dot(11, 15, "g");
  dot(13, 15, "g");
  dot(12, 16, "g");
  for (let y = 2; y <= 13; y++)
    for (let x = 3; x <= 21; x++) {
      const outer = ((x - 12) / 9) ** 2 + ((y - 7.5) / 6) ** 2;
      const inner = ((x - 12) / 8) ** 2 + ((y - 7.5) / 5) ** 2;
      if (outer <= 1) dot(x, y, inner <= 1 ? "c" : "k");
    }
  // Dark visor, armored left ear and a cream rim.
  for (let y = 5; y <= 11; y++)
    for (let x = 7; x <= 19; x++)
      if (((x - 13) / 6) ** 2 + ((y - 8) / 3.5) ** 2 <= 1) dot(x, y, "b");
  box(3, 6, 3, 5, "k");
  box(4, 7, 1, 3, "s");
  dot(6, 4, "k");
  dot(7, 3, "k");
  dot(8, 3, "k");
  for (const [x, y] of [
    [6, 3],
    [6, 2],
    [7, 1],
    [8, 0],
    [9, 0],
    [17, 3],
    [18, 2],
    [19, 1],
    [20, 0],
    [21, 0],
  ])
    dot(x!, y!, "g");
  for (const x of [10, 16]) {
    if (mood === "sleeping" || blink) box(x, 9, 2, 1, "g");
    else if (mood === "excited") {
      dot(x, 8, "g");
      dot(x + 1, 7, "g");
      dot(x + 2, 8, "g");
    } else if (mood === "error") {
      box(x, 7, 1, 3, "r");
      dot(x, 11, "r");
    } else box(x, 7, 1, mood === "thinking" && x === 16 ? 2 : 3, "g");
  }
  if (mood === "working") {
    box(8, 16, 12, 3, "s");
    box(9, 16, 10, 2, "b");
    dot(14, 16, "g");
    dot(13, 17, "g");
    dot(15, 17, "g");
    box(7, 19, 14, 1, "s");
  } else if (mood === "excited") {
    box(2, 3, 1, 2, "g");
    box(1, 4, 3, 1, "g");
    box(21, 12, 1, 3, "g");
    box(20, 13, 3, 1, "g");
  } else if (mood === "thinking") {
    box(22, 3, 2, 1, "g");
    dot(23, 4, "g");
    dot(22, 5, "g");
    dot(22, 7, "g");
  }
  return grid;
}

export function renderChibi(mood: ChibiMood, color = true, now = Date.now()) {
  const blink =
    mood !== "error" && mood !== "excited" && Math.floor(now / 1000) % 8 === 7;
  if (!color) {
    const eyes =
      mood === "error"
        ? "!!"
        : mood === "excited"
          ? "^^"
          : mood === "sleeping" || blink
            ? "--"
            : mood === "thinking"
              ? "o?"
              : "||";
    return [
      "      \\  /",
      "    .------.",
      "   / .----. \\",
      `  ( |  ${eyes}  | )`,
      "   \\ '----' /",
      "    /| <> |\\",
      "   (_|____|_)",
    ];
  }
  const pixels = sprite(mood, blink);
  const lines: string[] = [];
  const paint = (key: string, foreground: boolean) =>
    key === "."
      ? `${foreground ? 39 : 49}`
      : `${foreground ? 38 : 48};2;${palette[key]!.join(";")}`;
  for (let y = 0; y < pixels.length; y += 2) {
    let line = "";
    let style = "";
    for (let x = 0; x < 24; x++) {
      const upper = pixels[y]![x]!;
      const lower = pixels[y + 1]![x]!;
      const key =
        upper === "." && lower !== "."
          ? `${paint(lower, true)};49`
          : `${paint(upper, true)};${paint(lower, false)}`;
      if (key !== style) {
        line += `\u001b[${key}m`;
        style = key;
      }
      line += upper === "." ? (lower === "." ? " " : "▄") : "▀";
    }
    lines.push(`${line}\u001b[0m`);
  }
  return lines;
}
