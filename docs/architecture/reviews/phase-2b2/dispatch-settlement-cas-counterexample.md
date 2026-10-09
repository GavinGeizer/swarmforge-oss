# Dispatch settlement CAS counterexample

Exact candidate: `55faf47057bd8dc87dc996d259949251189205f1`. This candidate is not integrated.

The lead invoked the actual `hostedDispatchRoute` using a Bun SQLite adapter, all three production migrations and foreign keys enabled. This is a local SQL reproduction, not a workerd/D1 integration result. The fixture contained a current tenant owner, session, worker and supervisor credential, a running task with current lease/fence, and a controlled allowance with 10,000 milliseconds reserved.

After the handler read the allowance and before it submitted its production settlement batch, the probe changed reserved quantity to 9,000. The handler attempted to settle 100 milliseconds. Its ledger CAS therefore matched zero rows.

Observed result: HTTP 200; task `completed`; reservation `consumed` with quantity `100`; allowance remained reserved `9000`, consumed `0`. The terminal transition occurs before the ledger CAS, and the final check tests only the task outcome. A CAS miss does not throw a database error and does not roll back a successful D1 batch automatically.

The complete synthetic probe is retained at `/tmp/phase2b2-dispatch-cas-probe/probe.ts`, with the archived exact candidate source beside it. Run `bun run probe.ts` in that directory. It contains no live credentials. Independent D1 confirmation and an atomic correction are assigned to separate workers. Neither the author's earlier successful tests nor this SQL adapter reproduction certifies the integrated dispatch protocol.
