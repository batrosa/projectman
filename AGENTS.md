# ProjectMan repository instructions

## Production safety: Vercel

Before any production deploy, rollback, load test, repeated smoke test, or Vercel Firewall change, read [docs/vercel-protection-incident-runbook.md](docs/vercel-protection-incident-runbook.md).

Mandatory rules:

- Do not run rapid or repeated request loops against `projectman.online`.
- A large code change does not itself enable Vercel Attack Mode. Deploys and repeated production probes can coincide with traffic signals that trigger Vercel's automatic DDoS mitigation; treat this as correlation, not a proven direct trigger.
- Never state that Attack Mode is enabled without checking the Vercel Firewall dashboard. During the 2026-07-22 incident it was and had always been off.
- Distinguish an edge challenge (`403` plus `x-vercel-mitigated: challenge`) from a crashed function (`500 FUNCTION_INVOCATION_FAILED`). They are different incidents with different recovery procedures.
- Do not put Vercel bypass secrets in web or iOS clients and do not attempt to solve a JavaScript challenge from `URLSession`.

