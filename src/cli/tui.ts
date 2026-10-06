import { emitKeypressEvents } from "node:readline";
import {
  type CleanupOutcome,
  cleanupReadiness,
  renderCleanup,
  retainedWorkers,
} from "./cleanup";
import type { connectSwarmForge, WorkerDetail } from "./client";
import {
  emptyFilters,
  filterDescription,
  filterWorkers,
  sortOrders,
  type WorkerSort,
} from "./filters";
import {
  availableActions,
  canRetryPreservation,
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
  pollIntervalMs = 5_000,
) {
  let data = initial;
  let filters = emptyFilters();
  let order: WorkerSort = "recent";
  let editing: { field: "query" | "team" | "task"; draft: string } | null =
    null;
  let selected = visibleWorkers(data.workers, order)[0]?.worker_id;
  let detail: WorkerDetail | null = null;
  let mode: "overview" | "detail" | "cleanup" | "cleanup-preview" = "overview";
  let detailReturn: "overview" | "cleanup" = "overview";
  const cleanupSelected = new Set<string>();
  let cleanupCursor: string | undefined;
  let cleanupPreview: OverviewData["workers"] = [];
  let cleanupOutcomes: CleanupOutcome[] = [];
  let confirmation = false;
  let busy = false;
  let refreshing = false;
  let message = "";
  let stopped = false;
  const width = () => output.columns || 100;
  const reviewingCleanup = () => mode === "cleanup-preview";
  const matchingWorkers = () => filterWorkers(data.workers, filters);
  const cleanupRows = () => retainedWorkers(matchingWorkers(), order);
  const reconcileView = () => {
    const retained = cleanupRows();
    const eligible = new Set(
      retained
        .filter((worker) => cleanupReadiness(worker).eligible)
        .map((worker) => worker.worker_id),
    );
    for (const id of cleanupSelected)
      if (!eligible.has(id)) cleanupSelected.delete(id);
    if (!retained.some((worker) => worker.worker_id === cleanupCursor))
      cleanupCursor = retained[0]?.worker_id;
    const visible = visibleWorkers(matchingWorkers(), order);
    if (!visible.some((worker) => worker.worker_id === selected))
      selected = visible[0]?.worker_id;
  };
  const render = () => {
    if (stopped) return;
    const body =
      mode === "overview"
        ? renderOverview(data, {
            width: width(),
            height: Math.max(
              10,
              (output.rows || 40) - (editing ? 4 : message ? 3 : 0),
            ),
            color: !process.env.NO_COLOR && process.env.TERM !== "dumb",
            selectedId: selected,
            interactive: true,
            filters,
            sort: order,
          })
        : mode === "cleanup" || mode === "cleanup-preview"
          ? renderCleanup(
              mode === "cleanup-preview" ? cleanupPreview : matchingWorkers(),
              cleanupSelected,
              {
                cursor: cleanupCursor,
                width: width(),
                height: Math.max(
                  10,
                  (output.rows || 40) - (editing ? 4 : message ? 3 : 0),
                ),
                preview: mode === "cleanup-preview",
                outcomes: cleanupOutcomes,
                sort: order,
                filterLabel: filterDescription(filters, order),
              },
            )
          : detail
            ? renderWorkerDetail(detail, { width: width() })
            : "Loading worker…";
    const prompt = editing
      ? `\n\n${editing.field === "query" ? "Search worker/task IDs" : `${editing.field === "team" ? "Team" : "Task"} ID (exact)`}: ${safeTerminalText(editing.draft)}▏\nEnter apply · Esc cancel · Ctrl+U clear · blank matches all`
      : confirmation
        ? `\n\nDestroy this worker? Preservation: ${detail?.worker.finalization?.state ?? "not yet collected"}. Normal destruction checks preservation first. Press y to confirm or n to keep it.`
        : message
          ? `\n\n${safeTerminalText(message)}`
          : "";
    output.write(`\u001b[H\u001b[2J${body}${prompt}\n`);
  };
  const refresh = async () => {
    if (refreshing || stopped || reviewingCleanup()) return;
    refreshing = true;
    try {
      const next = await client.overview();
      if (stopped || reviewingCleanup()) return;
      data = next;
      reconcileView();
      if (mode === "detail" && detail && !busy) {
        const id = detail.worker.worker_id;
        const prior = detail.worker.state;
        const priorFinalization = JSON.stringify(detail.worker.finalization);
        const worker = await client.worker(id);
        if (mode === "detail" && detail?.worker.worker_id === id && !busy) {
          detail = { ...detail, worker };
          if (priorFinalization !== JSON.stringify(worker.finalization)) {
            const page = await client.artifacts(id);
            if (mode === "detail" && detail?.worker.worker_id === id && !busy)
              detail = {
                ...detail,
                artifacts: page.artifacts,
                artifactsNextOffset: page.next_offset,
              };
          }
          if (
            prior !== worker.state &&
            ["completed", "failed", "cancelled", "destroyed"].includes(
              worker.state,
            )
          ) {
            const result = await client.result(id);
            if (mode === "detail" && detail?.worker.worker_id === id && !busy)
              detail = { ...detail, result };
          }
        }
      }
      message = "";
    } catch (error) {
      message = `Refresh failed: ${error instanceof Error ? error.message : "unknown error"}`;
    } finally {
      refreshing = false;
      render();
    }
  };
  const inspect = async (id = selected) => {
    if (!id || busy) return;
    if (mode !== "detail")
      detailReturn = mode === "cleanup" ? "cleanup" : "overview";
    busy = true;
    mode = "detail";
    detail = null;
    message = "";
    render();
    try {
      detail = await client.inspect(id);
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
      const controlled = await client.control(detail.worker.worker_id, action);
      await refresh();
      detail = await client.inspect(detail.worker.worker_id);
      message =
        action === "destroy" && controlled.state !== "destroyed"
          ? `Destruction refused: ${controlled.error ?? controlled.state}. VM retained; inspect preservation and Git handoff.`
          : `${action} completed`;
    } catch (error) {
      message = `${action} failed: ${error instanceof Error ? error.message : "unknown error"}`;
    } finally {
      busy = false;
      render();
    }
  };

  const retryPreservation = async () => {
    if (!detail || busy || !canRetryPreservation(detail.worker)) return;
    busy = true;
    const id = detail.worker.worker_id;
    message = "Retrying artifact preservation…";
    render();
    try {
      await client.retryPreservation(id);
      detail = await client.inspect(id);
      message = `Preservation: ${detail.worker.finalization?.state ?? "unknown"}`;
    } catch (error) {
      message = `Preservation retry failed: ${error instanceof Error ? error.message : "unknown error"}`;
    } finally {
      busy = false;
      render();
    }
  };

  const openCleanup = () => {
    mode = "cleanup";
    detail = null;
    confirmation = false;
    reconcileView();
    message = "";
    render();
  };
  const moveCleanupCursor = (direction: number) => {
    const rows = mode === "cleanup-preview" ? cleanupPreview : cleanupRows();
    const current = rows.findIndex(
      (worker) => worker.worker_id === cleanupCursor,
    );
    cleanupCursor =
      rows[Math.min(Math.max(current + direction, 0), rows.length - 1)]
        ?.worker_id;
    render();
  };
  const previewCleanup = () => {
    reconcileView();
    cleanupPreview = cleanupRows().filter(
      (worker) =>
        cleanupSelected.has(worker.worker_id) &&
        cleanupReadiness(worker).eligible,
    );
    if (!cleanupPreview.length) {
      message = "Select at least one eligible worker first.";
      render();
      return;
    }
    // Freeze these exact identities while the operator reviews and confirms the batch.
    mode = "cleanup-preview";
    cleanupCursor = cleanupPreview[0]?.worker_id;
    message =
      "Confirming will request normal destruction for these workers only.";
    render();
  };
  const executeCleanup = async () => {
    if (busy || mode !== "cleanup-preview") return;
    const batch = [...cleanupPreview];
    busy = true;
    mode = "cleanup";
    cleanupOutcomes = [];
    try {
      for (const [index, candidate] of batch.entries()) {
        // Quitting ends the batch after the current request; nothing new is started.
        if (stopped) break;
        message = `Cleanup ${index + 1}/${batch.length}: ${candidate.worker_id}`;
        render();
        try {
          const current = await client.worker(candidate.worker_id);
          if (stopped) break;
          const readiness = cleanupReadiness(current);
          if (!readiness.eligible) {
            cleanupOutcomes.push({
              worker_id: current.worker_id,
              state: "skipped",
              message: readiness.reason,
            });
            cleanupSelected.delete(current.worker_id);
            continue;
          }
          const worker = await client.control(current.worker_id, "destroy", {
            settledOnly: true,
          });
          data = {
            ...data,
            workers: data.workers.map((prior) =>
              prior.worker_id === worker.worker_id ? worker : prior,
            ),
          };
          cleanupOutcomes.push({
            worker_id: worker.worker_id,
            state: worker.state === "destroyed" ? "destroyed" : "blocked",
            message:
              worker.state === "destroyed"
                ? "VM destroyed; stored artifacts retained"
                : (worker.error ?? `Server retained the VM (${worker.state})`),
          });
          cleanupSelected.delete(current.worker_id);
        } catch (error) {
          cleanupOutcomes.push({
            worker_id: candidate.worker_id,
            state: "failed",
            message:
              error instanceof Error ? error.message : "Cleanup request failed",
          });
          cleanupSelected.delete(candidate.worker_id);
        }
      }
      if (!stopped) {
        await refresh();
        const refreshWarning = message.startsWith("Refresh failed:")
          ? ` ${message}`
          : "";
        const destroyed = cleanupOutcomes.filter(
          (outcome) => outcome.state === "destroyed",
        ).length;
        const failed = cleanupOutcomes.filter(
          (outcome) => outcome.state === "failed",
        ).length;
        message = `Cleanup finished: ${destroyed} confirmed destroyed, ${cleanupOutcomes.length - destroyed - failed} blocked/skipped, ${failed} failed requests. Inspect current worker state before retrying.${refreshWarning}`;
      }
    } finally {
      busy = false;
      render();
    }
  };

  const changeFilters = () => {
    const priorSelection = cleanupSelected.size;
    reconcileView();
    message =
      cleanupSelected.size < priorSelection
        ? "Hidden or ineligible cleanup selections cleared."
        : "";
    render();
  };
  const filterKey = (text: string, name?: string) => {
    if (text === "/" || name === "slash")
      editing = { field: "query", draft: filters.query };
    else if (name === "t" || name === "k") {
      const field = name === "t" ? "team" : "task";
      editing = { field, draft: filters[field] };
    } else if (name === "s") {
      const values = [
        "",
        ...new Set(data.workers.map((worker) => worker.state).sort()),
      ];
      filters = {
        ...filters,
        state: values[(values.indexOf(filters.state) + 1) % values.length]!,
      };
    } else if (name === "p") {
      const values = [
        "",
        "none",
        "pending",
        "collecting",
        "preserved",
        "failed",
        "abandoned",
      ];
      filters = {
        ...filters,
        preservation:
          values[(values.indexOf(filters.preservation) + 1) % values.length]!,
      };
    } else if (name === "v")
      filters = { ...filters, retainedOnly: !filters.retainedOnly };
    else if (name === "o")
      order = sortOrders[(sortOrders.indexOf(order) + 1) % sortOrders.length]!;
    else if (name === "z") {
      filters = emptyFilters();
      order = "recent";
    } else return false;
    if (editing) {
      message = "";
      render();
    } else changeFilters();
    return true;
  };

  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  output.write("\u001b[?1049h\u001b[?25l");
  render();
  await new Promise<void>((resolve) => {
    const redraw = setInterval(render, 1_000);
    const poll = setInterval(() => void refresh(), pollIntervalMs);
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
    const onKey = (
      _text: string,
      key: { name?: string; ctrl?: boolean; meta?: boolean },
    ) => {
      if (key.ctrl && key.name === "c") {
        stop();
        return;
      }
      if (editing) {
        if (key.name === "escape") {
          editing = null;
          message = "";
          render();
        } else if (key.name === "return" || key.name === "enter") {
          filters = { ...filters, [editing.field]: editing.draft.trim() };
          editing = null;
          changeFilters();
        } else if (key.ctrl && key.name === "u") {
          editing.draft = "";
          render();
        } else if (key.name === "backspace") {
          editing.draft = Array.from(editing.draft).slice(0, -1).join("");
          render();
        } else if (
          !key.ctrl &&
          !key.meta &&
          _text &&
          !["up", "down", "left", "right", "tab"].includes(key.name ?? "")
        ) {
          editing.draft = Array.from(editing.draft + safeTerminalText(_text))
            .slice(0, 128)
            .join("");
          render();
        }
        return;
      }
      if (key.name === "q") {
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
      if (mode === "cleanup-preview") {
        if (key.name === "y") void executeCleanup();
        else if (key.name === "escape" || key.name === "n") {
          mode = "cleanup";
          message = "";
          render();
        } else if (key.name === "up" || key.name === "down")
          moveCleanupCursor(key.name === "up" ? -1 : 1);
        return;
      }
      if (
        (mode === "overview" || mode === "cleanup") &&
        !key.ctrl &&
        !key.meta &&
        filterKey(_text, key.name)
      )
        return;
      if (mode === "cleanup") {
        if (key.name === "escape") {
          mode = "overview";
          message = "";
          render();
        } else if (key.name === "up" || key.name === "down")
          moveCleanupCursor(key.name === "up" ? -1 : 1);
        else if (key.name === "space" && cleanupCursor) {
          const worker = cleanupRows().find(
            (worker) => worker.worker_id === cleanupCursor,
          );
          if (worker && cleanupReadiness(worker).eligible) {
            if (cleanupSelected.has(worker.worker_id))
              cleanupSelected.delete(worker.worker_id);
            else cleanupSelected.add(worker.worker_id);
            message = "";
          } else
            message = worker
              ? cleanupReadiness(worker).reason
              : "Refresh to update retained workers.";
          render();
        } else if (key.name === "a") {
          for (const worker of cleanupRows())
            if (cleanupReadiness(worker).eligible)
              cleanupSelected.add(worker.worker_id);
          render();
        } else if (key.name === "n") {
          cleanupSelected.clear();
          render();
        } else if (key.name === "return") previewCleanup();
        else if (key.name === "i" && cleanupCursor) void inspect(cleanupCursor);
        else if (key.name === "r") void refresh();
        return;
      }
      if (mode === "overview") {
        const visible = visibleWorkers(matchingWorkers(), order);
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
        } else if (key.name === "x") openCleanup();
        else if (key.name === "return") void inspect();
        else if (key.name === "r") void refresh();
        return;
      }
      if (key.name === "escape" || key.name === "backspace") {
        mode = detailReturn;
        detail = null;
        message = "";
        render();
      } else if (key.name === "r" && detail)
        void inspect(detail.worker.worker_id);
      else if (detail) {
        const actions = availableActions(detail.worker.state);
        if (key.name === "f") void retryPreservation();
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
