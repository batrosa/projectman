# Vercel Protection Incident Runbook

Last verified: 2026-07-22 10:37 MSK.

This document is mandatory reading before large changes, production deploys, production smoke checks, load tests, or Vercel Firewall changes.

## Executive summary

ProjectSfera is hosted on Vercel Hobby. Vercel has a platform-wide automatic DDoS mitigation layer that runs before the project, CDN, and serverless functions. During unusual traffic it can return a JavaScript Security Checkpoint instead of forwarding the request to ProjectSfera.

Large changes do **not** directly switch Attack Mode on. They often coincide with CI deploys, browser refreshes, CLI inspection, `curl` probes, and repeated smoke requests. A burst of those requests from the same IP or traffic fingerprint may contribute to Vercel's automated risk signals. The exact scoring algorithm and expiry timer are not exposed by Vercel, so the relationship must be recorded as correlation, not deterministic causation.

## Verified facts from the 2026-07-22 incident

The Vercel Firewall dashboard showed:

- Attack Mode: off (`Enable Attack Mode` was available). The owner confirmed it had always been off.
- Bot Protection: off.
- Custom Rules: 0.
- IP blocking rules: 0.
- System Bypass Rules: unavailable on the Hobby plan.
- `DDoS Mitigation (sys_dos_mitigation)`: 37 challenged requests in the observed hour.

Blocked requests returned:

```text
HTTP/2 403
server: Vercel
x-vercel-mitigated: challenge
x-vercel-challenge-token: ...
content-type: text/html; charset=utf-8
```

The body was the Vercel Security Checkpoint page. These requests never reached ProjectSfera code.

The browser could eventually execute the challenge and receive a temporary challenge session. Direct clients such as iOS `URLSession`, `curl`, Postman, webhooks, and bots cannot reliably execute that JavaScript checkpoint. This caused:

- long page loading or a checkpoint page;
- web login appearing to complete while organization loading failed;
- Telegram login start failing;
- iOS receiving HTTP 403 and becoming unable to use the API.

At approximately 10:19 MSK an iOS-like request was challenged with 403. At 10:37 MSK the same single probe reached the application and returned the expected unauthenticated 401 response. This only demonstrates that the automatic mitigation had cleared for that route/source by then; it is not a guaranteed 18-minute recovery time.

## Do not confuse 403 protection with a 500 function crash

Two independent failures happened in the same maintenance window:

| Signal | Layer | Meaning | Recovery |
| --- | --- | --- | --- |
| `403` and `x-vercel-mitigated: challenge` | Vercel edge firewall | Request did not reach ProjectSfera | Stop request bursts, wait and re-probe with backoff; escalate to Vercel if persistent |
| `500`, `FUNCTION_INVOCATION_FAILED`, “This Serverless Function has crashed” | Vercel serverless runtime | ProjectSfera function started and crashed | Inspect runtime/dependency changes, deploy or promote a known-good build |
| `401` JSON from an API probe without a token | ProjectSfera API | Healthy expected response | No incident |
| `405` JSON from an unsupported method | ProjectSfera API | Healthy expected response | No incident |

The 500 incident was caused by the Firebase Admin 14.2.0 / forced Node 22 runtime change and was fixed by commit `9d0ff23` by restoring Firebase Admin 13.5.0 and the previous Vercel runtime selection. Do not attribute that 500 to the firewall.

## Safe diagnosis

Do not begin with a request loop. Make one request and inspect the headers:

```bash
curl -sS -D /tmp/projectman-headers.txt \
  -o /tmp/projectman-body.txt \
  -X POST 'https://projectman.online/api/org' \
  -H 'Content-Type: application/json' \
  -H 'User-Agent: ProjectSfera/1 CFNetwork Darwin' \
  --data '{"action":"list"}'

sed -n '1,30p' /tmp/projectman-headers.txt
sed -n '1,8p' /tmp/projectman-body.txt
```

Interpretation:

- `401` with JSON `{"error":"Unauthorized"}`: API routing and runtime are healthy.
- `403` with `x-vercel-mitigated: challenge`: automatic Vercel protection is blocking direct clients.
- `500 FUNCTION_INVOCATION_FAILED`: inspect function logs and the deployed runtime.

Then check Vercel → ProjectSfera → Firewall:

1. Overview: challenged request count and active events.
2. Rules: Attack Mode, Bot Protection, Custom Rules, System Bypass Rules.
3. Traffic: confirm the reported rule, normally `sys_dos_mitigation` for this incident.

Never infer Attack Mode from the existence of a checkpoint page.

## Recovery for `x-vercel-mitigated: challenge`

1. Stop automated production probes, refresh loops, CLI polling against Vercel endpoints, and repeated login attempts.
2. Do not redeploy the same code merely to clear the challenge; deployment does not reset the platform firewall.
3. Wait before rechecking. Use one request, then exponential/backoff-style intervals rather than a tight loop.
4. Verify both browser access and a cookieless iOS-like API request. A working browser alone is insufficient because it may hold a valid challenge session.
5. Ask the user to retry iOS only after the cookieless probe returns normal ProjectSfera JSON.
6. If the mitigation remains across ordinary networks after the operational observation window, collect `x-vercel-id`, timestamps, domain, and response headers and contact Vercel support. Any 30–60 minute escalation window used by the team is an internal threshold, not a Vercel SLA.

Do not:

- enable or disable Attack Mode without evidence and explicit authorization;
- hardcode `VERCEL_AUTOMATION_BYPASS_SECRET` or any bypass token in iOS/web code;
- implement a fake Safari User-Agent as a “fix”;
- attempt to copy browser challenge cookies into `URLSession`;
- assume a Pro static IP bypass solves mobile clients with changing IP addresses.

## Prevention during large changes

1. Run unit/API/web tests, Firestore emulator tests, dependency audit, and build verification locally or in CI.
2. Validate a single Vercel preview deployment before merging.
3. Deploy to production once per completed change set instead of repeatedly deploying partial fixes.
4. Use GitHub/Vercel deployment status for build polling; do not poll production application routes.
5. Run the production smoke checklist once. Do not wrap production endpoints in rapid shell loops.
6. Space manual checks and stop immediately if `x-vercel-mitigated: challenge` appears.
7. Record deployment ID, commit, first failure time, `x-vercel-id`, affected networks, and recovery time.

## Current hosting decision

The owner decided to remain on Vercel for now. MyArena, DNS, Firebase, Firestore, and the iOS API base URL were not changed during this incident. A dedicated non-browser API host remains a future reliability option if automatic Vercel challenges repeatedly block iOS, bots, webhooks, or other direct clients.

