# Live local GitHub → CLI identity verification

Verified 2026-10-09 from the Phase 2B.1 implementation plus the accepted worker-client
storage extraction. The dedicated local GitHub OAuth app/private configuration
already existed. The lead started the loopback-only local API; `/ready` returned200.
No remote migration, deployment, secret upload or provisioning occurred.

The owner completed actual GitHub browser sign-in and explicitly approved two
separate temporary CLI installations. These were live provider flows, distinct
from the simulated provider used in automated workerd integration tests.

1. `cloud login` completed after browser approval and saved a separate private
   credential file in a freshly created private temporary directory.
2. `cloud status` verified the installation; `cloud rotate` succeeded; status
   still returned the same installation and organization.
3. `cloud logout` confirmed server revocation and removed the local credential.
   A retained private copy was used for one sanitized verification: its credential
   was rejected with401. The copy was deleted immediately afterward.
4. `cloud use` for the same selected organization required fresh browser approval
   and completed reauthorization. Status verified the selected organization.
5. The second temporary installation was explicitly revoked via logout and its
   credential file removed. The local dev API was stopped afterward.

File mode0600 was checked directly. Existing storage validation also required the
private0700 parent and POSIX ownership/no-follow checks. Neither raw credential,
OAuth secret, account profile, GitHub token nor proof was included in this record.
The public pairing URLs/codes were displayed only as needed for owner approval.

This establishes live local account/CLI linking, organization selection,
credential rotation, logout/revocation and reauthorization. It does not establish
remote preview authorization, worker/supervisor execution, Windows storage support,
Cloudflare edge CPU/load fitness or runtime isolation for untrusted workloads.
