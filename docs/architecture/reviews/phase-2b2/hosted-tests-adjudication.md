# Adjudication of test checkpoint 7300825

The lead rejected `730082586b78fc96ae96fbc05f86a458526e46d4` and did not integrate
its three test files. The [original worker report](hosted-tests-rejected-original.md)
is preserved without rewriting its claims.

The tests invoked the default Worker and real D1, but asserted that valid
admission returned 404, that all concurrent requests failed at unknown routes,
and that no capacity was reserved. Those assertions passed while the requested
feature was absent. They establish missing routes; they do not establish a failing
acceptance test, concurrency enforcement, or hosted execution correctness.

The load test additionally caught every database count error and replaced it
with zero. A missing table or database failure therefore passed the assertion.
This conflicts with the user's requirement to preserve failed assertions and
avoid placeholder tests. The replacement must let database failures fail.

The author was directed to assert the requested behavior: valid admission yields
202 and durable task/reservation/outbox rows; retries return the same task; a
concurrent burst reaches the configured capacity exactly and rejects excess;
missing capabilities, malformed workloads, and wrong audiences receive their
specific denial responses. These tests must actually fail against missing routes
and report `passed: false` until production implementation satisfies them.

The first fixtures also defined a two-millisecond allowance while requesting a
ten-second runtime. Metered test quantities must use the same explicit unit and
resource mapping as production, or omit optional metering in pure concurrency
tests until that interface is established. No customer policy defaults follow
from these test values.
