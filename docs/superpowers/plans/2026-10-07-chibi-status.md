# Chibi status overview

## Brief

Redesign the interactive `swarmforge status` overview using the user-provided `swarmforgechibi.png` as a visual reference: bee/robot mascot, cream helmet, dark visor, golden antennae and stateful expressions. Display the chibi/status composition at the top. No chat bar or conversational input. Preserve the existing technical dashboard behind Tab, including its filters, pagination, inspection, cleanup, artifact and notification controls.

Confirmed by the user: this targets the terminal CLI status screen, with Tab switching to the existing technical overview.

## Design

- Native terminal pixel art drawn with half-block characters and cream/charcoal/gold colors; ASCII fallback for no-color/dumb terminals and compact windows. Do not embed, crop or alter the supplied reference image.
- Six moods: idle, thinking/preparing, working, excited/recent completion, sleeping/paused or quiet history, error/needs attention. Derive them from real worker/lifecycle data and connection state; do not invent progress percentages or activity.
- Default friendly overview: mascot, a short status message, global working/waiting/completed/failed counts, measured tokens, retained VM/cleanup information, and a compact selectable task list with actual activity/result text.
- Tab toggles overview presentation; it must not reconnect, refresh, change filters/page/selection or start an operation. Mode persists while visiting details and returning.
- Technical rendering remains the existing renderOverview. Noninteractive status and JSON output remain technical/structured.
- Responsive terminal layout with hard row/column budgets. Keep navigation and view-toggle hints visible. Search/filter editors remain functional; they are not chat inputs.
- Leave the reference PNG and unrelated working-tree changes uncommitted.

## Checklist

- [x] Mascot renderer and state mapping
- [x] Friendly overview with bounded task rows and accurate totals
- [x] TUI default and Tab toggle, preserving existing controls
- [x] Documentation and static/build checks
- [x] Independent code review and correction
- [ ] Commit/push and install global executable; observe CI (current environment denies writes to Git metadata and the global executable directory)

## Validation

No tests are added/run locally unless requested. Use TypeScript/Biome checks, build verification, source review, and existing push CI when publication is possible. Do not call the configured SwarmForge/provider/model endpoints or restart the running service. The previous website/installer remains separate; public binary release publication is still an owner action.

## Implementation and review notes

- Added terminal-native cream/charcoal/gold mascot rendering and six expressions, with ASCII and compact fallbacks. Original reference PNG is unchanged.
- Added the friendly default overview and Tab toggle, keeping the existing technical renderer and noninteractive outputs.
- Updated README and operator documentation with the new view and controls. Global counts remain global; preservation/follow-up attention and recent completions reflect the loaded page. Status wording discloses this scope.
- Native read-only code review found three issues, all corrected: reserved task rows at 100×24, cleanup eligibility label, and page-specific attention wording. Follow-up review found no remaining important issues.
- `bun run check` passed (106 files); `git diff --check` passed. Local example frames were rendered to `/tmp/swarmforge-chibi-preview.png`; no endpoints were contacted.
- Built `dist/swarmforge` successfully for Linux x64 glibc. Local `--help` and `--version` succeeded; build identity is `54cba5b69529dbdf345119384731fff5dd4b439f-chibi-preview` to disclose uncommitted source.
- Current workspace permissions allow source and `dist` writes, but Git metadata and `/home/overlord/.local/bin` are read-only. No commit, push, global replacement, service restart, or CI run was performed for this change.
