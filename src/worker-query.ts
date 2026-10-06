export interface WorkerQuery {
  query?: string;
  team_id?: string;
  task_id?: string;
  state?: string;
  preservation?: string;
  retained_only?: boolean;
  sort?: "recent" | "idle" | "age";
  offset?: number;
  limit?: number;
}
export const retainedSql =
  "coalesce(json_extract(body,'$.vm_id'),'')!='' AND coalesce(json_extract(body,'$.vm_missing'),0)=0 AND state!='destroyed'";
export function workerWhere(query: WorkerQuery) {
  const clauses: string[] = [];
  const args: string[] = [];
  for (const [column, value] of [
    ["team_id", query.team_id],
    ["task_id", query.task_id],
    ["state", query.state],
  ] as const) {
    if (value) {
      clauses.push(`${column}=?`);
      args.push(value);
    }
  }
  if (query.query) {
    clauses.push(
      "(instr(lower(worker_id),lower(?))>0 OR instr(lower(task_id),lower(?))>0)",
    );
    args.push(query.query, query.query);
  }
  if (query.preservation) {
    clauses.push(
      "coalesce(json_extract(body,'$.finalization.state'),'none')=?",
    );
    args.push(query.preservation);
  }
  if (query.retained_only) clauses.push(`(${retainedSql})`);
  return { sql: clauses.length ? clauses.join(" AND ") : "1", args };
}
