import type { SpawnRequest } from "./domain";

export const taskTemplates = [
  {
    id: "code",
    role: "coder",
    description:
      "Implement a scoped code change with a reviewable Git handoff.",
    instructions:
      "Inspect the existing code and implement the requested change. Keep changes scoped. Run relevant checks, commit source changes, and report changed files, test outcomes, warnings, and follow-up work. Write .swarmforge/artifacts/change-summary.md with the implementation summary and verification evidence.",
    deliverable: "change-summary.md",
  },
  {
    id: "review",
    role: "reviewer",
    description:
      "Review code and report actionable findings with file locations.",
    instructions:
      "Review the requested code or change. Prioritize correctness, security, regressions, and missing requirements. Cite file locations and explain impact. Do not modify source unless requested. Write .swarmforge/artifacts/review.md with findings ordered by severity and an explicit statement if no findings were identified.",
    deliverable: "review.md",
  },
  {
    id: "research",
    role: "researcher",
    description: "Investigate a question and deliver a sourced recommendation.",
    instructions:
      "Investigate the requested question. Distinguish evidence, inference, and unknowns. Include sources and concrete recommendations. Write .swarmforge/artifacts/research.md with findings, trade-offs, sources, and unanswered questions.",
    deliverable: "research.md",
  },
  {
    id: "docs",
    role: "writer",
    description:
      "Update documentation with concrete setup and usage instructions.",
    instructions:
      "Inspect the existing documentation and implement the requested updates. Include concrete usage examples, prerequisites, and troubleshooting where relevant. Check examples against the code. Persist source changes through Git. Write .swarmforge/artifacts/docs-summary.md with the changes and any unverified instructions.",
    deliverable: "docs-summary.md",
  },
] as const;
export function getTaskTemplate(id: string) {
  const recipe = taskTemplates.find((template) => template.id === id);
  if (!recipe) throw new Error(`Unknown task template: ${id}`);
  return recipe;
}
export function templatePrompt(id: string, prompt: string) {
  return `${getTaskTemplate(id).instructions}\n\nRequested task:\n${prompt}`;
}
export function applyTaskTemplate(
  input: SpawnRequest,
  id?: string,
): SpawnRequest {
  if (!id) return input;
  const recipe = getTaskTemplate(id);
  const path = `.swarmforge/artifacts/${recipe.deliverable}`;
  return {
    ...input,
    role: input.role === "coder" ? recipe.role : input.role,
    prompt: templatePrompt(id, input.prompt),
    artifacts: [
      ...(input.artifacts ?? []),
      ...((input.artifacts ?? []).some((artifact) => artifact.path === path)
        ? []
        : [{ path, required: true, directory: false }]),
    ],
  };
}
