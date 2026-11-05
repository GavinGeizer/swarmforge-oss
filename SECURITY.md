# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately by emailing [gavin@getswarmforge.tech](mailto:gavin@getswarmforge.tech). Do not open a public issue for an unpatched security problem.

Include the affected SwarmForge version, the impact you observed or expect, and a minimal reproduction when possible. Redact API keys, access tokens, passwords, private repository contents, personal data, and other secrets from logs, screenshots, and reproduction steps. If a secret may have been exposed, revoke or rotate it.

## Deployment boundaries

SwarmForge is a self-hosted coordinator. The operator controls the host, its filesystem and configuration, the network around it, and the credentials provided to it. Worker execution takes place in separate Freestyle virtual machines using the operator's prepared snapshot; the VM provider, model endpoint, source repository, and any configured GitHub integration are external services with their own access controls and security boundaries. Isolation depends on those services, the host, and the operator's configuration.

SwarmForge stores coordination state and collected artifacts on the coordinator host. Deploy it only on a host and storage location appropriate for the configuration, credentials, source, and task outputs it will handle. Do not include secrets in public issues or unredacted artifacts.

## Release verification

Published checksums detect accidental changes when compared with a trusted checksum file. For the procedure and the limits of signed release provenance, see [Release Verification](docs/RELEASE-VERIFICATION.md). The published v0.1.3 release has checksums but no signed provenance.
