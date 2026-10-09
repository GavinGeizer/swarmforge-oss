# Hosted status pagination counterexample

Candidate `a6294161f968a8f75604b9c4bdae4854d8e3a64f` is not integrated. Its initial independent security approval is preserved separately and does not supersede this executable counterexample.

The lead invoked the actual hostedStatusRoute with all three production migrations and foreign keys enabled using Bun SQLite. This is a local SQL reproduction, not a D1 integration result. Three held task UUIDs begin `10000000`; three stop_requested UUIDs begin `90000000`. With limit=1, page one returns held task 100...001 and stop task 900...001, but chooses stopDuty.next as the shared cursor. Page two returns no held tasks, skipping held tasks 100...002 and 100...003.

The complete synthetic probe and exact archived candidate are retained in `/tmp/phase2b2-status-pagination-probe`; run `bun run probe.ts`. The correction must enumerate all categories without losing records and keep task/supervisor pagination scopes coherent. Additional source issues involving actual audit event attribution, bounded aggregation, current supervisor authority, and correctly labeled resource observations are assigned to the author and independent reviewer.
