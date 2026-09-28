import { emitKeypressEvents } from "node:readline";
import type { connectSwarmForge, WorkerDetail } from "./client";
import {
  availableActions,
  type OverviewData,
  renderOverview,
  renderWorkerDetail,
  safeTerminalText,
  visibleWorkers,
} from "./overview";

type DashboardClient = Awaited<ReturnType<typeof connectSwarmForge>>;

export async function runDashboard(
  client: DashboardClient,
  initial: OverviewData,
  input = process.stdin,
  output = process.stdout,
) {
  let data = initial;
  let selected = visibleWorkers(data.workers)[0]?.worker_id;
  let detail: WorkerDetail | null = null;
  let mode: "overview" | "detail" = "overview";
  let confirmation = false;
  let busy = false;
  let refreshing = false;
  let message = "";
  let stopped = false;
  const width = () => output.columns || 100;
  const render = () => {
    if (stopped) return;
    const body =
      mode === "overview"
        ? renderOverview(data, {
            width: width(),
            height: output.rows || 40,
            color: !process.env.NO_COLOR && process.env.TERM !== "dumb",
            selectedId: selected,
            interactive: true,
          })
        : detail
          ? renderWorkerDetail(detail, { width: width() })
          : "Loading worker…";
    const prompt = confirmation
      ? "\n\nDestroy this worker? Press y to confirm or n to keep it."
      : message
        ? `\n\n${safeTerminalText(message)}`
        : "";
    output.write(`\u001b[H\u001b[2J${body}${prompt}\n`);
  };
  const refresh = async () => {
    if (refreshing || stopped) return;
    refreshing = true;
    try {
      data = await client.overview();
      const visible = visibleWorkers(data.workers);
      if (!visible.some((worker) => worker.worker_id === selected))
        selected = visible[0]?.worker_id;
      message = "";
    } catch (error) {
      message = `Refresh failed: ${error instanceof Error ? error.message : "unknown error"}`;
    } finally {
      refreshing = false;
      render();
    }
  };
  const inspect = async () => {
    if (!selected || busy) return;
    busy = true;
    mode = "detail";
    detail = null;
    message = "";
    render();
    try {
      detail = await client.inspect(selected);
    } catch (error) {
      message = `Inspection failed: ${error instanceof Error ? error.message : "unknown error"}`;
    } finally {
      busy = false;
      render();
    }
  };
  const control = async (action: "pause" | "resume" | "cancel" | "destroy") => {
    if (!detail || busy) return;
    busy = true;
    confirmation = false;
    message = `${action} in progress…`;
    render();
    try {
      await client.control(detail.worker.worker_id, action);
      await refresh();
      detail = await client.inspect(detail.worker.worker_id);
      message = `${action} completed`;
    } catch (error) {
      message = `${action} failed: ${error instanceof Error ? error.message : "unknown error"}`;
    } finally {
      busy = false;
      render();
    }
  };

  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  output.write("\u001b[?1049h\u001b[?25l");
  render();
  await new Promise<void>((resolve) => {
    const redraw = setInterval(render, 1_000);
    const poll = setInterval(() => void refresh(), 5_000);
    const onResize = () => render();
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(redraw);
      clearInterval(poll);
      input.off("keypress", onKey);
      output.off("resize", onResize);
      input.setRawMode(false);
      input.pause();
      output.write("\u001b[?25h\u001b[?1049l");
      resolve();
    };
    const onKey = (_text: string, key: { name?: string; ctrl?: boolean }) => {
      if ((key.ctrl && key.name === "c") || key.name === "q") {
        stop();
        return;
      }
      if (confirmation) {
        if (key.name === "y") void control("destroy");
        else if (key.name === "n" || key.name === "escape") {
          confirmation = false;
          render();
        }
        return;
      }
      if (busy) return;
      if (mode === "overview") {
        const visible = visibleWorkers(data.workers);
        const current = visible.findIndex(
          (worker) => worker.worker_id === selected,
        );
        if (key.name === "up" || key.name === "down") {
          const direction = key.name === "up" ? -1 : 1;
          const next = Math.min(
            Math.max(current + direction, 0),
            visible.length - 1,
          );
          selected = visible[next]?.worker_id;
          render();
        } else if (key.name === "return") void inspect();
        else if (key.name === "r") void refresh();
        return;
      }
      if (key.name === "escape" || key.name === "backspace") {
        mode = "overview";
        detail = null;
        message = "";
        render();
      } else if (key.name === "r") void inspect();
      else if (detail) {
        const actions = availableActions(detail.worker.state);
        if (key.name === "p" && actions.includes("p pause"))
          void control("pause");
        if (key.name === "u" && actions.includes("u resume"))
          void control("resume");
        if (key.name === "c" && actions.includes("c cancel"))
          void control("cancel");
        if (key.name === "d" && actions.includes("d destroy")) {
          confirmation = true;
          render();
        }
      }
    };
    input.on("keypress", onKey);
    output.on("resize", onResize);
  });
}
