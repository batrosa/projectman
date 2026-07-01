# Security fixes, Telegram auth, AI agent + files — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the found Firestore/secret-handling vulnerabilities, replace email/password login with Telegram login, and add a global org-wide AI agent (OpenRouter) that reads all tasks/projects and studies uploaded project files (md/xlsx/pdf/docx).

**Architecture:** Keep Firebase (Auth + Firestore) as the system of record. Add Vercel serverless functions (Node/ESM) for everything that needs a secret: Telegram auth verification, Telegram notification sending, AI chat, and file text extraction. Firestore rules get a new `organizations` block and tightened `users` field protection. File text extraction and AI-agent context patterns are adapted from `~/Desktop/12` (a sibling project with a proven OpenRouter + file-parsing pattern), swapping its Supabase calls for Firebase Admin SDK calls.

**Tech Stack:** Firebase (Auth, Firestore, Admin SDK), Vercel Functions (Node ESM), OpenRouter (`openai/gpt-oss-120b` / `openai/gpt-oss-20b`), `fflate` + `pdf-parse` for file parsing, Cloudinary (existing) for raw file storage, `vitest` for the new pure-logic unit tests, `@firebase/rules-unit-testing` + Firebase Emulator for security-rules tests.

Design doc: `docs/plans/2026-07-01-security-telegram-auth-ai-agent-design.md`

---

## Task 0: Verify the actual Firestore data model before writing queries — CONFIRMED

**Resolved (2026-07-01):** queried the live `projectman-96d3c` Firestore directly via the Firebase MCP tools. Both `projects` and `tasks` documents carry `organizationId` directly, confirmed on all sampled documents including the oldest `projects` docs (createdAt 2025-11-24, the earliest in the collection) — the field has been present since before any of this plan's other changes, no backfill needed. Task 14's `db.collection('projects').where('organizationId', '==', organizationId)` / same for `tasks` can proceed exactly as designed.

Original task text below, kept for history:

The AI agent (Task 13) needs to query `projects` and `tasks` by organization. It is **not yet confirmed** whether `projects`/`tasks` documents carry an `organizationId` field today — `readme.md`'s schema predates the `organizations` collection. Do not guess; confirm first.

**Steps:**

1. Once Firebase project access is confirmed working (`firebase_get_environment` / `firebase_list_projects` MCP tools show `projectman-96d3c`), run:
   ```
   firebase firestore:indexes  # sanity check CLI has access
   ```
2. Use the Firebase MCP tool `firestore_query_collection` (or Firebase Console) to fetch a few real documents from `projects` and `tasks` and inspect their actual fields.
3. If `organizationId` is **absent** on `projects`/`tasks`: add a one-off backfill (either a small admin script using Admin SDK, or a Firestore Console bulk edit) that stamps `organizationId` onto every existing `projects` doc using `projects` → `organizations` linkage you find in the code (check `script.js` around `createOrganization`/`selectProject` for how projects currently get associated with an org — this wasn't fully traced during research). Also update `script.js`'s project-creation code path to always set `organizationId` on new projects going forward.
4. Write down the confirmed field name in this plan file (edit this task) before starting Task 13, so the query in Task 13 matches reality.

**Commit:** only if you changed code/rules for the backfill — `git commit -m "fix: ensure projects carry organizationId for agent context queries"`.

---

## Task 1: Remove dead admin-password code

**Files:**
- Modify: `index.html` (remove `admin-verify-screen` block, ~line 727-749)
- Modify: `script.js` (remove now-orphaned references to `admin-verify-submit`/`admin-verify-screen` element caching, ~lines 1540, 1545)
- Modify: `readme.md`, `deployment.md` (remove all mentions of password `301098` and the admin-confirmation flow)

**Steps:**

1. Grep to find every reference before touching anything: `grep -rn "301098\|admin-verify" .` (run from repo root). Confirm the earlier research finding still holds (zero live event listener bound to `admin-verify-submit`).
2. Delete the dead HTML block and the two JS element-cache lines.
3. Update the two markdown docs to describe the *actual* current registration flow (role is always `reader` on signup; there is no admin password step).
4. Manually smoke-test in the browser: register a new account, confirm no console errors about missing `admin-verify-screen`/`admin-verify-submit` elements.
5. Commit: `git commit -m "fix: remove dead admin-password screen and stale docs"`.

---

## Task 2: Move Telegram sending server-side; stop shipping the bot token to the browser

Currently `script.js:5116` hardcodes the bot token and calls Telegram's API directly from the browser — this is worse than the already-known server-side leak in `api/webhook.js`, because it's trivially visible in devtools with zero effort. Fix: introduce a server endpoint that holds the token, and make the client call that instead.

**Files:**
- Create: `api/notify-telegram.js`
- Modify: `script.js` (replace direct `fetch(TELEGRAM_API/sendMessage...)` calls inside `checkReminders`/notification code, ~lines 5115-5260, 5490-5630, with calls to the new endpoint)
- Modify: `.env`/Vercel dashboard (add `TELEGRAM_BOT_TOKEN` as a server env var — do NOT commit it)

**Step 1: Write the new endpoint**

```js
// api/notify-telegram.js
export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Method not allowed" });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return response.status(503).json({ error: "Telegram is not configured" });
  }

  let body;
  try {
    body = await parseJsonBody(request);
  } catch {
    return response.status(400).json({ error: "Invalid JSON body" });
  }

  const chatId = String(body.chatId || "").trim();
  const text = String(body.text || "").trim();
  if (!chatId || !text) {
    return response.status(400).json({ error: "chatId and text are required" });
  }

  const telegramResponse = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 3900) }),
  });

  const ok = telegramResponse.ok;
  return response.status(200).json({ ok });
}

async function parseJsonBody(request) {
  if (request.body && typeof request.body === "object") return request.body;
  if (typeof request.body === "string") return JSON.parse(request.body || "{}");
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}
```

**Step 2: Update the client**

In `script.js`, find every place that currently does `fetch(\`${TELEGRAM_API}/sendMessage\`, ...)` (the reminder/notification sends around lines 5115-5260 and 5490-5630) and replace with:

```js
async function sendTelegramNotification(chatId, text) {
  try {
    await fetch("/api/notify-telegram", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, text }),
    });
  } catch (error) {
    console.error("Telegram notification failed", error);
  }
}
```

Delete the `TELEGRAM_BOT_TOKEN` and `TELEGRAM_API` constants from `script.js` entirely — grep `grep -n "TELEGRAM_BOT_TOKEN\|TELEGRAM_API" script.js` after editing to confirm zero remaining references.

**Step 3: Manual verification**

1. Set `TELEGRAM_BOT_TOKEN` in your local `.env`/Vercel env (do not put it in any file that gets committed).
2. Run the app locally (or on a preview deploy), trigger a reminder condition, confirm the Telegram message still arrives and confirm via browser devtools Network tab that the token is no longer visible anywhere in `script.js` or in any request the browser makes directly to `api.telegram.org`.

**Commit:** `git commit -m "fix: move Telegram sends server-side, remove bot token from client bundle"`

---

## Task 3: Rotate the Telegram bot token

This is a manual action for you (the user), not code — but do it before or immediately after Task 2 ships, since the old token is already public in git history and possibly cached by anyone who viewed the repo.

**Steps (for you to do, not Claude):**
1. Message @BotFather → `/mybots` → select the bot → `Bot Settings` → `API Token` → `Revoke current token`.
2. Put the new token into Vercel's environment variables as `TELEGRAM_BOT_TOKEN` (used by both `api/webhook.js` and the new `api/notify-telegram.js`), and into `api/webhook.js` — remove the hardcoded literal there too (Task 4 below).
3. Note: this does not scrub the old token out of git history. If you want that done, say so explicitly — it requires a history rewrite (`git filter-repo` + force-push), which is a separate, disruptive action needing its own confirmation.

---

## Task 4: Remove the hardcoded token/key from `api/webhook.js`

**Files:**
- Modify: `api/webhook.js:1-6`

**Steps:**

1. Replace:
   ```js
   const TOKEN = '8318306872:AAFQh2-XtMSMTe6StxJNMdy29l0UzbxD600';
   const FIREBASE_API_KEY = 'AIzaSyBqNCgLUmlxfIKlDCwmx0-9D-JJm63RpuU';
   ```
   with:
   ```js
   const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
   const FIREBASE_API_KEY = process.env.FIREBASE_WEB_API_KEY;
   ```
   (Note: the Firebase Web API key itself is not a secret by Firebase's design — client SDKs ship it openly — but there's no reason to duplicate a literal when an env var works just as well and makes rotation easier if the project ID ever changes.)
2. Add `TELEGRAM_BOT_TOKEN` and `FIREBASE_WEB_API_KEY` to Vercel env vars (the bot token is the same one from Task 3).
3. Manual test: send `/start` to the bot from Telegram, confirm the webhook still replies.
4. Commit: `git commit -m "fix: read Telegram/Firebase secrets from env instead of hardcoding"`

---

## Task 5: Firestore rules — add `organizations`, protect `organizationId`/`orgRole`

**Files:**
- Modify: `firestore.rules`
- Create: `firestore-tests/organizations.rules.test.js` (new test directory)
- Create: `package.json` (if not already created by Task 8 — check first, don't overwrite)
- Create: `firebase.json` — add emulator config (merge into existing file, don't overwrite the `hosting`/`firestore` keys already there)

**Step 1: Add emulator + test tooling**

Check whether `package.json` exists yet (Task 8 also creates one — do this task first if executing in order). Create if missing:

```json
{
  "name": "projectman",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:rules": "firebase emulators:exec --only firestore \"vitest run firestore-tests\""
  },
  "devDependencies": {
    "@firebase/rules-unit-testing": "^4.0.1",
    "vitest": "^3.0.0"
  }
}
```

Run `npm install`.

Add an `emulators` block to `firebase.json` (merge, keep existing `firestore`/`hosting` keys):
```json
{
  "firestore": { "rules": "firestore.rules" },
  "emulators": { "firestore": { "port": 8080 } },
  "hosting": { ... existing content unchanged ... }
}
```

**Step 2: Write the failing test**

```js
// firestore-tests/organizations.rules.test.js
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";

let testEnv;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "projectman-rules-test",
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

describe("organizations privilege escalation", () => {
  it("blocks a user from self-granting orgRole=owner on an arbitrary org", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection("users").doc("attacker").set({ role: "reader" });
      await ctx.firestore().collection("organizations").doc("victim-org").set({ ownerId: "victim", name: "Victim Org" });
    });

    const attacker = testEnv.authenticatedContext("attacker").firestore();
    await assertFails(
      attacker.collection("users").doc("attacker").update({
        organizationId: "victim-org",
        orgRole: "owner",
      })
    );
  });

  it("allows a user to self-join an org with orgRole=employee only", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection("users").doc("newbie").set({ role: "reader" });
      await ctx.firestore().collection("organizations").doc("some-org").set({ ownerId: "owner1", name: "Some Org" });
    });

    const newbie = testEnv.authenticatedContext("newbie").firestore();
    await assertSucceeds(
      newbie.collection("users").doc("newbie").update({
        organizationId: "some-org",
        orgRole: "employee",
      })
    );
  });

  it("blocks reading/writing organizations doc fields by non-owner non-admin", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection("users").doc("bystander").set({ role: "reader", orgRole: "employee", organizationId: "some-org" });
      await ctx.firestore().collection("organizations").doc("some-org").set({ ownerId: "owner1", name: "Some Org" });
    });

    const bystander = testEnv.authenticatedContext("bystander").firestore();
    await assertFails(
      bystander.collection("organizations").doc("some-org").update({ name: "Hijacked" })
    );
  });

  it("allows the real createOrganization() write shape (organizationId + orgRole:'owner' + email + displayName) when the caller actually owns the referenced org", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection("users").doc("founder").set({ role: "reader" });
      await ctx.firestore().collection("organizations").doc("new-org").set({ ownerId: "founder", name: "New Org" });
    });

    const founder = testEnv.authenticatedContext("founder").firestore();
    await assertSucceeds(
      founder.collection("users").doc("founder").update({
        organizationId: "new-org",
        orgRole: "owner",
        email: "founder@example.com",
        displayName: "Founder",
      })
    );
  });

  it("blocks self-granting orgRole:'owner' by pointing organizationId at an org the caller does not own", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection("users").doc("faker").set({ role: "reader" });
      await ctx.firestore().collection("organizations").doc("real-org").set({ ownerId: "realowner", name: "Real Org" });
    });

    const faker = testEnv.authenticatedContext("faker").firestore();
    await assertFails(
      faker.collection("users").doc("faker").update({
        organizationId: "real-org",
        orgRole: "owner",
      })
    );
  });

  it("allows the real leaveOrganization() write shape (organizationId + orgRole both set to null)", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection("users").doc("leaver").set({
        role: "reader", organizationId: "some-org", orgRole: "employee",
      });
    });

    const leaver = testEnv.authenticatedContext("leaver").firestore();
    await assertSucceeds(
      leaver.collection("users").doc("leaver").update({ organizationId: null, orgRole: null })
    );
  });

  it("allows a plain employee to bump membersCount by exactly 1 on the org they just joined (real joinOrganization() follow-up write)", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection("users").doc("joiner").set({ role: "reader", organizationId: "some-org", orgRole: "employee" });
      await ctx.firestore().collection("organizations").doc("some-org").set({ ownerId: "owner1", name: "Some Org", membersCount: 1 });
    });

    const joiner = testEnv.authenticatedContext("joiner").firestore();
    await assertSucceeds(
      joiner.collection("organizations").doc("some-org").update({ membersCount: 2 })
    );
  });

  it("blocks a plain employee from changing membersCount by more than 1 or touching other org fields", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection("users").doc("joiner2").set({ role: "reader", organizationId: "some-org", orgRole: "employee" });
      await ctx.firestore().collection("organizations").doc("some-org").set({ ownerId: "owner1", name: "Some Org", membersCount: 1 });
    });

    const joiner2 = testEnv.authenticatedContext("joiner2").firestore();
    await assertFails(
      joiner2.collection("organizations").doc("some-org").update({ membersCount: 5 })
    );
    await assertFails(
      joiner2.collection("organizations").doc("some-org").update({ membersCount: 2, name: "Renamed" })
    );
  });
});
```

**Step 3: Run to verify it fails**

Run: `npm run test:rules`
Expected: FAIL — first test fails because the current rules have no `organizations` match block at all (default-deny means the `organizations.doc().set()` inside `withSecurityRulesDisabled` still works since rules are disabled, but the `update` in the *not*-disabled context should currently succeed unexpectedly since `organizationId`/`orgRole` aren't in `notUpdatingRestrictedFields()` — confirming the vulnerability actually reproduces before you fix it).

**Step 4: Apply the rules fix**

> **Correction recorded during execution:** the original version of this step (adding `isSelfServiceOrgJoin()` as an OR-branch while leaving `notUpdatingRestrictedFields()`'s blocklist unchanged) was a no-op — `notUpdatingRestrictedFields()` never blocked `organizationId`/`orgRole` in the first place, so the OR made no difference and the vulnerability would NOT actually have been fixed. The corrected version below (a) adds `organizationId`/`orgRole` to the blocklist, then (b) adds three narrow, verified carve-outs matching each of the three real self-service write shapes used by `createOrganization()`/`joinOrganization()`/`leaveOrganization()` in `script.js`, with the create carve-out cryptographically tied to actually owning the referenced org document (via `get()`), not just claiming to. Verified against official Firebase docs that `"field" in resource.data` is the documented-safe way to check a possibly-missing field (do not compare a possibly-absent field directly to `null`) — see https://firebase.google.com/docs/firestore/security/rules-conditions.

In `firestore.rules`, replace the `notUpdatingRestrictedFields` function and the `users` update rule, and add a new `organizations` match block:

```
function notUpdatingRestrictedFields() {
  return !request.resource.data.diff(resource.data).affectedKeys().hasAny(['role', 'allowedProjects', 'organizationId', 'orgRole']);
}

function isSelfServiceOrgJoin() {
  let changedKeys = request.resource.data.diff(resource.data).affectedKeys();
  return changedKeys.hasOnly(['organizationId', 'orgRole'])
    && request.resource.data.orgRole == 'employee';
}

function isSelfServiceOrgLeave() {
  let changedKeys = request.resource.data.diff(resource.data).affectedKeys();
  return changedKeys.hasOnly(['organizationId', 'orgRole'])
    && request.resource.data.organizationId == null
    && request.resource.data.orgRole == null;
}

function wasNotYetInOrg() {
  return !('organizationId' in resource.data) || resource.data.organizationId == null;
}

function isSelfServiceOrgCreate() {
  let changedKeys = request.resource.data.diff(resource.data).affectedKeys();
  return changedKeys.hasOnly(['organizationId', 'orgRole', 'email', 'displayName'])
    && request.resource.data.orgRole == 'owner'
    && wasNotYetInOrg()
    && exists(/databases/$(database)/documents/organizations/$(request.resource.data.organizationId))
    && get(/databases/$(database)/documents/organizations/$(request.resource.data.organizationId)).data.ownerId == request.auth.uid;
}
```

and change the `users/{userId}` update rule to:

```
allow update: if (request.auth != null && request.auth.uid == userId
                   && (notUpdatingRestrictedFields() || isSelfServiceOrgJoin() || isSelfServiceOrgLeave() || isSelfServiceOrgCreate()))
              || isAdmin();
```

Add, after the `users` match block:

```
function isMemberCountStep() {
  let changedKeys = request.resource.data.diff(resource.data).affectedKeys();
  return changedKeys.hasOnly(['membersCount'])
    && (request.resource.data.membersCount == resource.data.membersCount + 1
        || request.resource.data.membersCount == resource.data.membersCount - 1);
}

match /organizations/{orgId} {
  allow read: if request.auth != null;
  allow create: if request.auth != null && request.resource.data.ownerId == request.auth.uid;
  allow update: if request.auth != null && (
    resource.data.ownerId == request.auth.uid ||
    get(/databases/$(database)/documents/users/$(request.auth.uid)).data.orgRole in ['owner', 'admin'] ||
    isMemberCountStep()
  );
  allow delete: if request.auth != null && (
    resource.data.ownerId == request.auth.uid ||
    get(/databases/$(database)/documents/users/$(request.auth.uid)).data.orgRole in ['owner', 'admin']
  );
}
```

**Second correction recorded during execution:** the implementer traced `joinOrganization()` (script.js:666-668) and found it calls `organizations/{orgId}.update({membersCount: increment(1)})` immediately after the self-join succeeds — under the `organizations` block above (before this correction), a plain employee is neither `ownerId` nor `orgRole in ['owner','admin']`, so that follow-up write would be denied, breaking the join flow (or at least leaving `membersCount` out of sync while the user doc itself did get updated). This is a regression in the rules block written for *this task*, not pre-existing debt — fixed by adding `isMemberCountStep()`, a narrow carve-out limited to the single `membersCount` field changing by exactly ±1 per write. This intentionally does not verify the caller is joining/leaving *this specific* org (that would require correlating two separate document writes, which isn't reliably expressible in security rules without a transaction guarantee this app doesn't use) — accepted as a reasonable, low-severity trade-off since `membersCount` is a display/limit-tracking counter, not a field that gates any actual permission.

**Note — pre-existing, out-of-scope gap found while tracing this (do not fix as part of Task 5, just record in "Known gaps"):** promoting/demoting a *different* user's `orgRole` (e.g. an org owner making a teammate `admin`/`moderator`, or removing a member) is done in `script.js` (around line 4553 admin role-change UI, line 4763-4766 member removal, line 713-718 `deleteOrganization`'s batch update of other members) but the `users/{userId}` update rule only grants non-owner-of-the-target-doc writes via `isAdmin()` (the legacy global admin/reader flag), which typical org owners/admins don't have. This looks broken today independent of this task and is a separate, larger feature gap (would need a rule path like "caller's own orgRole is owner/admin AND caller's organizationId matches the target user's organizationId" or a dedicated server-side endpoint) — track as a follow-up, do not attempt in Task 5.

**Step 5: Run to verify it passes**

First, check whether the Firestore emulator can actually run in this environment: `java -version`. The emulator (`firebase emulators:exec`) requires Java.

- **If Java is available**: `npm run test:rules` — expect PASS on all 8 tests (the original 3, plus the 3 create/leave tests, plus the 2 membersCount tests added above).
- **If Java is NOT available**: attempt to install one before giving up, since this task is security-critical and worth the effort — e.g. `brew install openjdk` if Homebrew is present (`brew --version`), then retry. If installation isn't feasible in your environment either, fall back to careful manual/static tracing of the rules logic against every test case (as documented in this plan's corrected Step 4), and say so explicitly and honestly in your report — do not claim tests passed if they were never executed.

**Step 5b: Third correction — the `create` rule is a full bypass of everything above (found by code-quality review, confirmed via a live emulator probe, not theoretical)**

Code-quality review found and empirically confirmed (via their own throwaway emulator test using the exact shipped rules) that `users/{userId}`'s existing `allow create` rule was never touched by this task and only constrains `role`:

```
allow create: if request.auth != null && request.auth.uid == userId 
  && (!request.resource.data.keys().hasAll(['role']) || request.resource.data.role == 'reader');
```

Since Firestore evaluates a `.set(..., {merge:true})` call as a **`create`** (not `update`) whenever the target document doesn't yet exist, and `createOrganization()` in `script.js:598` explicitly does exactly this ("use set with merge to handle missing docs"), an attacker whose own `users/{uid}` doc doesn't yet exist (e.g. a freshly-registered account, before normal registration's own doc-creation write lands, or any doc that was ever deleted) can call:

```js
db.collection('users').doc(myUid).set({ role: 'reader', organizationId: 'victim-org', orgRole: 'owner' })
```

and it succeeds — full self-escalation, no ownership check, via a different write shape than everything fixed so far. This must be closed before any deploy.

**Fix:** extend the `create` rule with the same rigor as the `update` fix — a narrow, `get()`-verified carve-out for the real `createOrganization()`-on-a-missing-doc shape, otherwise forbid `organizationId`/`orgRole` entirely at creation time (matching what real registration actually writes today: just `role: 'reader'` plus basic profile fields, never org fields).

```
function isSelfServiceOrgCreateAtDocCreation() {
  return request.resource.data.keys().hasOnly(['organizationId', 'orgRole', 'email', 'displayName', 'role'])
    && (!('role' in request.resource.data) || request.resource.data.role == 'reader')
    && request.resource.data.orgRole == 'owner'
    && exists(/databases/$(database)/documents/organizations/$(request.resource.data.organizationId))
    && get(/databases/$(database)/documents/organizations/$(request.resource.data.organizationId)).data.ownerId == request.auth.uid;
}

allow create: if request.auth != null && request.auth.uid == userId && (
  (!request.resource.data.keys().hasAny(['organizationId', 'orgRole'])
    && (!request.resource.data.keys().hasAll(['role']) || request.resource.data.role == 'reader'))
  || isSelfServiceOrgCreateAtDocCreation()
);
```

This mirrors `isSelfServiceOrgCreate()`'s ownership tie exactly, just adapted for the create path (no `wasNotYetInOrg()` guard needed here — there's no prior document state to check against when creating one from nothing).

Add these test cases to `firestore-tests/organizations.rules.test.js` (a 9th and 10th, plus consider splitting the file into nested `describe` blocks per code-quality review's suggestion — e.g. `describe("users create path")` / `describe("users update path")` / `describe("organizations doc")` — now that it's growing):

```js
it("blocks self-granting orgRole:'owner' via create() when the user doc doesn't exist yet (the bypass code-quality review found)", async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().collection("organizations").doc("victim-org").set({ ownerId: "victim", name: "Victim Org" });
  });

  const attacker = testEnv.authenticatedContext("attacker-no-doc").firestore();
  await assertFails(
    attacker.collection("users").doc("attacker-no-doc").set({
      role: "reader", organizationId: "victim-org", orgRole: "owner",
    })
  );
});

it("allows the real createOrganization() write shape via create() when the caller actually owns the referenced org and their user doc doesn't exist yet", async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().collection("organizations").doc("new-org-2").set({ ownerId: "founder2", name: "New Org 2" });
  });

  const founder2 = testEnv.authenticatedContext("founder2").firestore();
  await assertSucceeds(
    founder2.collection("users").doc("founder2").set({
      organizationId: "new-org-2", orgRole: "owner", email: "founder2@example.com", displayName: "Founder 2",
    })
  );
});
```

Run `npm run test:rules` again (same Java/Homebrew approach as Step 5) — expect all 10 tests to pass. Do not consider this task done until this passes.

**Step 6: Deploy and commit**

1. Confirm Firebase project access is working (`projectman-96d3c` visible via MCP/CLI). If not yet available, skip the deploy sub-step and flag it as still needed — do not skip committing the code/rules/tests themselves.
2. `firebase deploy --only firestore:rules` (from `/Users/teko/Desktop/projectman`, with the correct project selected) — once access is confirmed. **Do not deploy until Step 5b's fix is committed and all 10 tests pass** — deploying only the update-path fix would leave the create-path escalation live in production.
3. `git add firestore.rules firestore-tests/ package.json firebase.json && git commit -m "fix: close organizations privilege-escalation gap in Firestore rules"` (if committing Step 5b separately: `git commit -m "fix: close create-path bypass of organizations privilege-escalation fix"`)

---

## Task 6: Add Firestore rules for the new project files subcollection

**Files:**
- Modify: `firestore.rules` (add after the `tasks` match block)
- Modify: `firestore-tests/organizations.rules.test.js` or create `firestore-tests/project-files.rules.test.js`

**Step 1: Add the rule**

All writes to file docs happen server-side via the Admin SDK (Task 13/14), which bypasses rules entirely — so the client-facing rule only needs to allow reads to people who can already see the project, and deny all client-side writes:

```
match /projects/{projectId}/files/{fileId} {
  allow read: if isAdmin() || (request.auth != null && canViewProject(projectId));
  allow write: if false;
}
```

**Step 2: Test**

```js
// firestore-tests/project-files.rules.test.js
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";

let testEnv;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "projectman-rules-test-2",
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  });
});

afterAll(async () => { await testEnv.cleanup(); });

describe("project files subcollection", () => {
  it("denies direct client writes even from an admin-looking client", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection("users").doc("someone").set({ role: "admin" });
    });
    const someone = testEnv.authenticatedContext("someone").firestore();
    await assertFails(
      someone.collection("projects").doc("p1").collection("files").doc("f1").set({ filename: "x.pdf" })
    );
  });

  it("allows read for a user who can view the project", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection("users").doc("viewer1").set({ role: "reader", allowedProjects: [] });
      await ctx.firestore().collection("projects").doc("p1").collection("files").doc("f1").set({ filename: "x.pdf" });
    });
    const viewer = testEnv.authenticatedContext("viewer1").firestore();
    await assertSucceeds(viewer.collection("projects").doc("p1").collection("files").doc("f1").get());
  });
});
```

Run `npm run test:rules`, confirm both pass.

**Commit:** `git commit -m "feat: lock down project files subcollection to server-side writes only"`

---

## Task 7: Set up Node test tooling for serverless library code

(Skip if `package.json`/vitest was already created in Task 5 — just add the `test` script if missing.)

**Files:**
- Modify/Create: `package.json`

Ensure it has:
```json
{
  "scripts": {
    "test": "vitest run"
  },
  "devDependencies": {
    "vitest": "^3.0.0"
  }
}
```

Run `npm install`, then `npm test` (expect: "no test files found" is fine at this point — later tasks add tests).

---

## Task 8: Port `lib/openrouter-config.js`

**Files:**
- Create: `lib/openrouter-config.js`
- Test: `lib/openrouter-config.test.js`

**Step 1: Write the failing test**

```js
// lib/openrouter-config.test.js
import { describe, it, expect } from "vitest";
import { buildOpenRouterModels, openRouterModelBody } from "./openrouter-config.js";

describe("buildOpenRouterModels", () => {
  it("defaults to gpt-oss-120b then gpt-oss-20b", () => {
    const models = buildOpenRouterModels();
    expect(models[0]).toBe("openai/gpt-oss-120b");
    expect(models).toContain("openai/gpt-oss-20b");
  });
});

describe("openRouterModelBody", () => {
  it("wraps a single model into the request body shape", () => {
    expect(openRouterModelBody(["openai/gpt-oss-120b"])).toEqual({ model: "openai/gpt-oss-120b" });
  });
});
```

**Step 2: Run to verify it fails**

Run: `npm test -- lib/openrouter-config.test.js`
Expected: FAIL — module not found.

**Step 3: Implement (adapted from `~/Desktop/12/lib/openrouter-config.js`, chat-only — no `material` purpose needed here)**

```js
// lib/openrouter-config.js
const DEFAULT_CHAT_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"];

export function buildOpenRouterModels() {
  const explicit = parseModelList(process.env.CHAT_AGENT_MODELS);
  if (explicit.length) return withRequiredFallback(explicit);
  return uniqueModels(DEFAULT_CHAT_MODELS);
}

export function openRouterModelBody(models) {
  const list = uniqueModels(models);
  return { model: list[0] || DEFAULT_CHAT_MODELS[0] };
}

export function openRouterTimeoutMs() {
  const n = Number(process.env.OPENROUTER_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 3000 ? Math.min(n, 60000) : 9000;
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = openRouterTimeoutMs()) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function uniqueModels(models) {
  const out = [];
  for (const model of models || []) {
    const clean = String(model || "").trim();
    if (clean && !out.includes(clean)) out.push(clean);
  }
  return out;
}

function withRequiredFallback(models) {
  return uniqueModels([...models, ...DEFAULT_CHAT_MODELS]);
}

function parseModelList(value) {
  return String(value || "")
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}
```

**Step 4: Run to verify it passes**

Run: `npm test -- lib/openrouter-config.test.js`
Expected: PASS

**Step 5: Commit**

`git commit -m "feat: add OpenRouter model-selection config module"`

---

## Task 9: Port `lib/material-parser.js`

**Files:**
- Create: `lib/material-parser.js`
- Test: `lib/material-parser.test.js`
- Modify: `package.json` (add `fflate`, `pdf-parse` dependencies)

**Step 1: Install dependencies**

```bash
npm install fflate pdf-parse
```

**Step 2: Write the failing test (plain-text case first — cheapest to fixture)**

```js
// lib/material-parser.test.js
import { describe, it, expect } from "vitest";
import { extractMaterialText } from "./material-parser.js";

describe("extractMaterialText", () => {
  it("extracts plain text from a .md file", async () => {
    const base64 = Buffer.from("# Заметка\nПривет мир").toString("base64");
    const result = await extractMaterialText({ filename: "note.md", contentType: "text/markdown", base64 });
    expect(result.parser).toBe("md");
    expect(result.text).toContain("Привет мир");
  });

  it("returns a warning for an empty file", async () => {
    const result = await extractMaterialText({ filename: "empty.pdf", contentType: "application/pdf", base64: "" });
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
```

**Step 3: Run to verify it fails**

Run: `npm test -- lib/material-parser.test.js`
Expected: FAIL — module not found.

**Step 4: Implement**

Copy `~/Desktop/12/lib/material-parser.js` to `lib/material-parser.js` verbatim (it has zero Supabase-specific code — it's a pure buffer-in, text-out module). Confirm after copying:

```bash
diff ~/Desktop/12/lib/material-parser.js lib/material-parser.js
```
should show no differences.

**Step 5: Run to verify it passes**

Run: `npm test -- lib/material-parser.test.js`
Expected: PASS

**Step 6 (optional but recommended): add one real-file fixture test**

Add a small real `.xlsx` and `.docx` fixture under `lib/__fixtures__/` (a tiny 1-sheet/1-paragraph file you create by hand in Excel/Word, not synthesized) and a test asserting `extractMaterialText` returns non-empty text with `parser: "xlsx"`/`"docx"`. This catches regressions the plain-text test can't.

**Step 7: Commit**

`git commit -m "feat: port material text extraction (docx/xlsx/pdf/md) from credit-matrix project"`

---

## Task 10: `lib/firebase-admin.js`

**Files:**
- Create: `lib/firebase-admin.js`
- Modify: `package.json` (add `firebase-admin` dependency)

**Steps:**

1. `npm install firebase-admin`
2. Create a Firebase service account key: Firebase Console → Project Settings → Service Accounts → Generate new private key. **Do not commit this file.** Store its full JSON contents as a single-line Vercel env var `FIREBASE_SERVICE_ACCOUNT_JSON`.
3. Implement:

```js
// lib/firebase-admin.js
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

function loadServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not configured");
  return JSON.parse(raw);
}

function getAdminApp() {
  const existing = getApps();
  if (existing.length) return existing[0];
  return initializeApp({ credential: cert(loadServiceAccount()) });
}

export function adminDb() {
  return getFirestore(getAdminApp());
}

export function adminAuth() {
  return getAuth(getAdminApp());
}
```

This module is a thin wrapper with no independent logic worth unit-testing in isolation (it would just be testing the Admin SDK itself) — it gets exercised indirectly through Tasks 11 and 13's manual verification steps.

**Commit:** `git commit -m "feat: add Firebase Admin SDK helper for serverless functions"`

---

## Task 11: Telegram login — verification + endpoint

**Files:**
- Create: `lib/telegram-auth-verify.js`
- Test: `lib/telegram-auth-verify.test.js`
- Create: `api/telegram-auth.js`

**Step 1: Write the failing test**

```js
// lib/telegram-auth-verify.test.js
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { verifyTelegramAuth } from "./telegram-auth-verify.js";

const BOT_TOKEN = "test-bot-token";

function signPayload(fields) {
  const checkString = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const secretKey = crypto.createHash("sha256").update(BOT_TOKEN).digest();
  const hash = crypto.createHmac("sha256", secretKey).update(checkString).digest("hex");
  return { ...fields, hash };
}

describe("verifyTelegramAuth", () => {
  it("accepts a correctly signed, fresh payload", () => {
    const payload = signPayload({ id: 12345, first_name: "Ivan", auth_date: Math.floor(Date.now() / 1000) });
    const result = verifyTelegramAuth(payload, BOT_TOKEN);
    expect(result.valid).toBe(true);
    expect(result.telegramId).toBe("12345");
  });

  it("rejects a tampered payload", () => {
    const payload = signPayload({ id: 12345, first_name: "Ivan", auth_date: Math.floor(Date.now() / 1000) });
    payload.first_name = "Hacker";
    const result = verifyTelegramAuth(payload, BOT_TOKEN);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("hash_mismatch");
  });

  it("rejects a stale auth_date (replay)", () => {
    const payload = signPayload({ id: 12345, first_name: "Ivan", auth_date: Math.floor(Date.now() / 1000) - 90000 });
    const result = verifyTelegramAuth(payload, BOT_TOKEN);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("auth_date_expired");
  });
});
```

**Step 2: Run to verify it fails**

Run: `npm test -- lib/telegram-auth-verify.test.js`
Expected: FAIL — module not found.

**Step 3: Implement**

```js
// lib/telegram-auth-verify.js
import crypto from "node:crypto";

export function verifyTelegramAuth(data, botToken, { maxAgeSeconds = 86400 } = {}) {
  if (!data || typeof data !== "object") return { valid: false, reason: "no_data" };
  const { hash, ...fields } = data;
  if (!hash || typeof hash !== "string") return { valid: false, reason: "missing_hash" };

  const checkString = Object.keys(fields)
    .filter((key) => fields[key] !== undefined && fields[key] !== null)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join("\n");

  const secretKey = crypto.createHash("sha256").update(botToken).digest();
  const computedHash = crypto.createHmac("sha256", secretKey).update(checkString).digest("hex");

  let hashesMatch;
  try {
    hashesMatch = crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(computedHash, "hex"));
  } catch {
    hashesMatch = false; // length mismatch etc.
  }
  if (!hashesMatch) return { valid: false, reason: "hash_mismatch" };

  const authDate = Number(fields.auth_date);
  if (!Number.isFinite(authDate)) return { valid: false, reason: "invalid_auth_date" };
  const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
  if (ageSeconds > maxAgeSeconds || ageSeconds < -60) {
    return { valid: false, reason: "auth_date_expired" };
  }

  return { valid: true, telegramId: String(fields.id) };
}
```

**Step 4: Run to verify it passes**

Run: `npm test -- lib/telegram-auth-verify.test.js`
Expected: PASS (all three cases)

**Step 5: Implement the endpoint**

```js
// api/telegram-auth.js
import { verifyTelegramAuth } from "../lib/telegram-auth-verify.js";
import { adminDb, adminAuth } from "../lib/firebase-admin.js";

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Method not allowed" });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return response.status(503).json({ error: "Telegram auth is not configured" });

  let body;
  try {
    body = await parseJsonBody(request);
  } catch {
    return response.status(400).json({ error: "Invalid JSON body" });
  }

  const verification = verifyTelegramAuth(body, botToken);
  if (!verification.valid) {
    return response.status(401).json({ error: "Telegram auth verification failed", reason: verification.reason });
  }

  const telegramId = verification.telegramId;
  const db = adminDb();
  const usersRef = db.collection("users");
  const existing = await usersRef.where("telegramId", "==", telegramId).limit(1).get();

  let uid;
  if (!existing.empty) {
    uid = existing.docs[0].id;
    await usersRef.doc(uid).set(
      { telegramChatId: telegramId, telegramUsername: body.username || null, lastLogin: new Date().toISOString() },
      { merge: true }
    );
  } else {
    uid = `tg_${telegramId}`;
    await usersRef.doc(uid).set(
      {
        telegramId,
        telegramChatId: telegramId,
        telegramUsername: body.username || null,
        firstName: body.first_name || null,
        lastName: body.last_name || null,
        role: "reader",
        createdAt: new Date().toISOString(),
        lastLogin: new Date().toISOString(),
      },
      { merge: true }
    );
  }

  const customToken = await adminAuth().createCustomToken(uid);
  return response.status(200).json({ ok: true, token: customToken, isNewUser: existing.empty });
}

async function parseJsonBody(request) {
  if (request.body && typeof request.body === "object") return request.body;
  if (typeof request.body === "string") return JSON.parse(request.body || "{}");
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}
```

**Commit:** `git commit -m "feat: add Telegram login verification and custom-token endpoint"`

---

## Task 12: Frontend — Telegram Login Widget replaces email/password

**Files:**
- Modify: `index.html` (replace the `auth-screen` email/password form, remove the dead settings "connect Telegram" screen at `index.html:1181/1221`)
- Modify: `script.js` (remove `signInWithEmailAndPassword`/registration logic; add Telegram widget callback wiring)

**Steps:**

1. In `index.html`, inside the `auth-screen` container, replace the email/password form with the Telegram widget script tag:
   ```html
   <script async src="https://telegram.org/js/telegram-widget.js?22"
     data-telegram-login="YOUR_BOT_USERNAME"
     data-size="large"
     data-onauth="onTelegramAuth(user)"
     data-request-access="write"></script>
   ```
   Replace `YOUR_BOT_USERNAME` with the actual bot username (without `@`).
2. Remove the settings screen for "connect Telegram for notifications" (`index.html:1181/1221` per earlier research) and any script.js code wiring its button — it's now redundant since `telegramChatId` is set at login time.
3. In `script.js`, add:
   ```js
   window.onTelegramAuth = async function onTelegramAuth(telegramUser) {
     try {
       const res = await fetch("/api/telegram-auth", {
         method: "POST",
         headers: { "Content-Type": "application/json" },
         body: JSON.stringify(telegramUser),
       });
       const data = await res.json();
       if (!data.ok) throw new Error(data.error || "Telegram auth failed");
       await firebase.auth().signInWithCustomToken(data.token);
     } catch (error) {
       console.error("Telegram login failed", error);
       alert("Не удалось войти через Telegram. Попробуйте ещё раз.");
     }
   };
   ```
4. Remove the old registration/login form-submit handlers (`grep -n "signInWithEmailAndPassword\|createUserWithEmailAndPassword" script.js` to find them) and their associated DOM elements in `index.html`.

**Manual verification (no automated test possible for a third-party widget + real Firebase Auth):**

1. Register the app's domain with @BotFather (`/setdomain`) — required before the widget will render/work at all, for both the local dev URL if testing locally with a tunnel, and the production domain.
2. Load the app, click the Telegram widget button, complete the Telegram auth popup, confirm you land in the app logged in and `firebase.auth().currentUser` is set.
3. Check Firestore (`users` collection) to confirm a new doc appeared with `telegramId`/`telegramChatId`/`role: "reader"`.
4. Log out and log back in with the same Telegram account — confirm it reuses the same `uid` (no duplicate user doc).

**Commit:** `git commit -m "feat: replace email/password login with Telegram Login Widget"`

---

## Task 13: File upload — metadata endpoint + text extraction

**Files:**
- Create: `api/project-files.js`
- Modify: `firestore.rules` (already done in Task 6 — verify it's in place)

**Step 1: Implement**

```js
// api/project-files.js
import { adminDb } from "../lib/firebase-admin.js";
import { extractMaterialText } from "../lib/material-parser.js";

const ALLOWED_EXTENSIONS = ["md", "xlsx", "xlsm", "pdf", "docx"];
const MAX_FILE_BYTES = 10 * 1024 * 1024;

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Method not allowed" });
  }

  let body;
  try {
    body = await parseJsonBody(request);
  } catch {
    return response.status(400).json({ error: "Invalid JSON body" });
  }

  const { projectId, filename, url, mimeType, sizeBytes, uploadedBy } = body;
  if (!projectId || !filename || !url) {
    return response.status(400).json({ error: "projectId, filename and url are required" });
  }

  const ext = String(filename).toLowerCase().split(".").pop();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return response.status(400).json({ error: `Unsupported file type: .${ext}` });
  }
  if (Number(sizeBytes) > MAX_FILE_BYTES) {
    return response.status(400).json({ error: "File exceeds 10 MB limit" });
  }

  const db = adminDb();
  const fileRef = db.collection("projects").doc(projectId).collection("files").doc();
  await fileRef.set({
    filename,
    url,
    mimeType: mimeType || null,
    sizeBytes: sizeBytes || null,
    uploadedBy: uploadedBy || null,
    uploadedAt: new Date().toISOString(),
    extractionStatus: "pending",
    extractedText: null,
    extractionWarnings: [],
  });

  extractInBackground(fileRef, { filename, url, mimeType }).catch((error) => {
    console.error("background extraction failed", error);
  });

  return response.status(200).json({ ok: true, fileId: fileRef.id });
}

async function extractInBackground(fileRef, { filename, url, mimeType }) {
  try {
    const fileResponse = await fetch(url);
    if (!fileResponse.ok) throw new Error(`Failed to download file: ${fileResponse.status}`);
    const arrayBuffer = await fileResponse.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");

    const result = await extractMaterialText({ filename, contentType: mimeType || "", base64 });
    await fileRef.update({
      extractionStatus: result.text ? "done" : "error",
      extractedText: result.text || null,
      extractionWarnings: result.warnings || [],
    });
  } catch (error) {
    await fileRef.update({
      extractionStatus: "error",
      extractionWarnings: [String(error.message || error)],
    });
  }
}

async function parseJsonBody(request) {
  if (request.body && typeof request.body === "object") return request.body;
  if (typeof request.body === "string") return JSON.parse(request.body || "{}");
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}
```

Note: unlike `~/Desktop/12`, there's no `waitUntil` import here — Vercel's Node runtime (non-Edge) keeps a function alive until all pending promises from the invocation settle by default in most cases, but this is not fully guaranteed for fire-and-forget promises after `response` is sent. **Verify this in practice** (see manual step 3 below); if extraction reliably doesn't complete, add `@vercel/functions`' `waitUntil()` around the `extractInBackground(...)` call the same way `~/Desktop/12/api/materials.js` does.

**Step 2: Frontend wiring**

- Extend the existing Cloudinary upload code path (used today for task attachments) to also accept `.md`/`.xlsx`/`.xlsm`/`.pdf`/`.docx` with `resource_type: "raw"`, in a new "Project files" UI section (not the per-task attachment picker).
- After the Cloudinary upload resolves, call `POST /api/project-files` with the returned `secure_url` + metadata.
- Render the file list with `extractionStatus` (pending/done/error) using a live Firestore listener on `projects/{projectId}/files`, matching the existing pattern for other collections in `script.js`.

**Step 3: Manual verification**

1. Upload a real `.md`, `.xlsx`, and `.pdf` file through the new UI.
2. Watch the Firestore doc for each file — confirm `extractionStatus` moves from `pending` to `done` within a few seconds, and `extractedText` is non-empty and looks correct for each file type.
3. If extraction never completes (stuck on `pending`), that confirms the `waitUntil` concern above — add it per the note in Step 1.

**Commit:** `git commit -m "feat: add project file upload metadata endpoint with background text extraction"`

---

## Task 14: Global AI agent chat endpoint

**Files:**
- Create: `api/agent-chat.js`

Uses the confirmed field name from Task 0 for scoping `projects`/`tasks` by organization — **replace `organizationId` below if Task 0 found a different actual field/join path.**

**Step 1: Implement**

```js
// api/agent-chat.js
import { adminDb, adminAuth } from "../lib/firebase-admin.js";
import { buildOpenRouterModels, openRouterModelBody, fetchWithTimeout } from "../lib/openrouter-config.js";

const CONTEXT_CHAR_LIMIT = 45000;
const MAX_HISTORY_TURNS = 8;

const SYSTEM_PROMPT_RULES = [
  "Ты — ИИ Руководитель проекта, ассистент внутри системы управления задачами.",
  "Отвечай коротко и по делу: 1-3 тезиса по умолчанию, простым не техническим языком.",
  "Ты знаешь все задачи, сроки и статусы всей организации, а не только открытый экран — не проси открыть раздел или выбрать проект, если данные уже есть ниже.",
  "Если факта нет в данных — прямо скажи, что этого пока нет в системе. Не выдумывай.",
  "Никогда не придумывай кнопки, разделы, статусы или функции, которых нет в приложении.",
  "Не говори «в предоставленном контексте» — говори «в данных проекта» или «в системе».",
  "Ты только отвечаешь на вопросы, данные не меняешь.",
].join(" ");

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Method not allowed" });
  }

  const idToken = (request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!idToken) return response.status(401).json({ error: "Unauthorized" });

  let decoded;
  try {
    decoded = await adminAuth().verifyIdToken(idToken);
  } catch {
    return response.status(401).json({ error: "Unauthorized" });
  }

  let body;
  try {
    body = await parseJsonBody(request);
  } catch {
    return response.status(400).json({ error: "Invalid JSON body" });
  }

  const message = String(body.message || "").trim();
  if (!message) return response.status(400).json({ error: "message is required" });
  const history = normalizeHistory(body.history);

  const db = adminDb();
  const userDoc = await db.collection("users").doc(decoded.uid).get();
  const organizationId = userDoc.exists ? userDoc.data().organizationId : null;
  if (!organizationId) {
    return response.status(200).json({ ok: true, answer: "Вы пока не состоите ни в одной организации — агенту нечего показать." });
  }

  const context = await loadOrganizationContext(db, organizationId);
  const contextText = compactContext(context);

  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (!openRouterKey) {
    return response.status(200).json({ ok: true, answer: "ИИ-агент временно недоступен (не настроен OpenRouter)." });
  }

  const models = buildOpenRouterModels();
  const messages = [
    { role: "system", content: `${SYSTEM_PROMPT_RULES}\n\nДанные организации:\n${contextText}` },
    ...history,
    { role: "user", content: message },
  ];

  for (let i = 0; i < models.length; i += 1) {
    const model = models[i];
    try {
      const apiResponse = await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${openRouterKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...openRouterModelBody([model]), temperature: 0.2, max_tokens: 900, messages }),
      });

      if (!apiResponse.ok) {
        if (i === models.length - 1) break;
        continue;
      }

      const data = await apiResponse.json();
      const answer = cleanAnswer(data?.choices?.[0]?.message?.content);
      if (!answer) {
        if (i === models.length - 1) break;
        continue;
      }

      return response.status(200).json({ ok: true, answer, model });
    } catch {
      if (i === models.length - 1) break;
    }
  }

  return response.status(200).json({
    ok: true,
    answer: "Не удалось получить ответ от ИИ-агента, попробуйте ещё раз через минуту.",
    model: "fallback",
  });
}

async function loadOrganizationContext(db, organizationId) {
  const [projectsSnap, tasksSnap] = await Promise.all([
    db.collection("projects").where("organizationId", "==", organizationId).get(),
    db.collection("tasks").where("organizationId", "==", organizationId).get(),
  ]);

  const projects = projectsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const tasks = tasksSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

  const files = [];
  for (const project of projects) {
    const filesSnap = await db
      .collection("projects").doc(project.id).collection("files")
      .where("extractionStatus", "==", "done")
      .get();
    filesSnap.docs.forEach((doc) => {
      const data = doc.data();
      if (data.extractedText) files.push({ projectId: project.id, filename: data.filename, extractedText: data.extractedText });
    });
  }

  return { projects, tasks, files };
}

function compactContext(context) {
  const structured = JSON.stringify({
    projects: context.projects.map((p) => ({ id: p.id, name: p.name })),
    tasks: context.tasks.map((t) => ({
      id: t.id, projectId: t.projectId, title: t.title, assignee: t.assignee,
      deadline: t.deadline, status: t.status, subStatus: t.subStatus,
    })),
  });

  const fileTexts = context.files.map((f) => `Файл "${f.filename}" (проект ${f.projectId}):\n${f.extractedText}`);
  let combined = `${structured}\n\n${fileTexts.join("\n\n")}`;
  if (combined.length > CONTEXT_CHAR_LIMIT) {
    combined = `${combined.slice(0, CONTEXT_CHAR_LIMIT)}\n...[данные обрезаны по объёму — часть файлов или задач могла не попасть в контекст]`;
  }
  return combined;
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.slice(-MAX_HISTORY_TURNS).map((turn) => ({
    role: turn.role === "assistant" ? "assistant" : "user",
    content: String(turn.content || "").slice(0, 2000),
  }));
}

function cleanAnswer(text) {
  if (!text) return "";
  return String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/в предоставленном контексте/gi, "в данных проекта")
    .trim();
}

async function parseJsonBody(request) {
  if (request.body && typeof request.body === "object") return request.body;
  if (typeof request.body === "string") return JSON.parse(request.body || "{}");
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}
```

**Step 2: Unit-testable pure helpers**

Extract `cleanAnswer` and `normalizeHistory` are already pure and easy to test in isolation if you want coverage — optional given they're a handful of lines each, but if you do:

```js
// api/agent-chat.helpers.test.js — only if you split cleanAnswer/normalizeHistory into lib/agent-chat-helpers.js
```

This is optional; the bulk of this file's value can only be verified end-to-end (real Firestore + real OpenRouter), which is what Step 3 does.

**Step 3: Manual end-to-end verification**

1. Set `OPENROUTER_API_KEY` in env.
2. Log in as a real user with `organizationId` set, with at least one project/task and one uploaded+extracted file.
3. Call the endpoint with a real Firebase ID token:
   ```bash
   curl -X POST https://<preview-url>/api/agent-chat \
     -H "Authorization: Bearer <id-token>" \
     -H "Content-Type: application/json" \
     -d '{"message": "Какие задачи сейчас просрочены?"}'
   ```
4. Confirm the answer references real task titles/deadlines from your test data, not invented ones.
5. Ask about something genuinely absent (e.g. a task that doesn't exist) — confirm it says the fact isn't in the system rather than making one up.
6. Ask a follow-up question referencing "it"/"that" from the previous turn — confirm history is used correctly.

**Commit:** `git commit -m "feat: add global org-wide AI agent chat endpoint"`

---

## Task 15: Frontend — global agent chat UI

**Files:**
- Modify: `index.html` (add a chat panel/nav entry, visible to all authenticated users per the org-wide-access decision)
- Modify: `script.js` (wire send/receive, attach Firebase ID token)

**Steps:**

1. Add a persistent chat entry point in the nav (icon/button opening a panel), visible regardless of role, per the design decision that everyone in the org can access the agent.
2. On send:
   ```js
   async function sendAgentMessage(message, history) {
     const idToken = await firebase.auth().currentUser.getIdToken();
     const res = await fetch("/api/agent-chat", {
       method: "POST",
       headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
       body: JSON.stringify({ message, history }),
     });
     return res.json();
   }
   ```
3. Keep a client-side `history` array of `{role, content}` capped to the last 8 turns before sending (mirrors server-side cap, keeps payload small).
4. Render using the existing safe DOM-construction pattern already used elsewhere in this codebase for user-facing text — do not use `innerHTML` with the agent's answer text, since it's LLM output rendered directly to the page (use `.textContent`).

**Manual verification:**

1. Open the chat as a `reader`/employee role account, confirm it answers using org-wide data (per the "visible to everyone, sees everything" decision), not just that user's `allowedProjects`.
2. Confirm markdown-like formatting from the LLM (if any) doesn't break rendering (since you're using `textContent`, verify the plain-text rendering still reads acceptably, or add minimal safe formatting — e.g., convert `\n` to line breaks via a `<br>`-per-line DOM construction, still without `innerHTML` of the raw text).

**Commit:** `git commit -m "feat: add global AI agent chat UI"`

---

## Task 16: Deploy

**Steps:**

1. Confirm Firebase access is resolved (Task 0 prerequisite) and rules pass emulator tests.
2. `firebase deploy --only firestore:rules` from `/Users/teko/Desktop/projectman`.
3. In Vercel dashboard, set env vars: `TELEGRAM_BOT_TOKEN` (rotated, Task 3), `FIREBASE_WEB_API_KEY`, `FIREBASE_SERVICE_ACCOUNT_JSON`, `OPENROUTER_API_KEY`.
4. Confirm the bot's domain is registered via `/setdomain` in @BotFather (Task 12).
5. `git push` to `main` (Vercel auto-deploys via its existing GitHub integration) — confirm this is still the desired deploy path, or use `vercel --prod` manually if preferred.
6. Post-deploy smoke test: Telegram login, file upload + extraction, agent chat — the same manual checks from Tasks 12-15, run against the real production URL.

**Commit:** none (deploy step, not a code change) — if any last-minute fixes come up during smoke testing, commit those individually with their own descriptive messages.

---

## Known gaps / tracked follow-ups (recorded during execution, not blocking)

- **`api/notify-telegram.js` (Task 2) is an open relay**: no auth/authorization check — any client can POST an arbitrary `chatId`+`text` and it will relay through the bot token. Code-quality review confirmed this mirrors the plan's own original sample and the pre-existing client-side behavior (not a regression introduced by this task), so it wasn't blocked on, but it should be fixed properly once Task 10 (`lib/firebase-admin.js`) exists: restrict `chatId` to values found in `users.telegramChatId`, or add rate limiting.
- ~~**Module system mismatch**: `api/webhook.js` and `api/notify-telegram.js` (Task 2) are CommonJS (`module.exports`), matching the repo's current no-`package.json` state. Task 7 introduces `package.json` with `"type": "module"` and Tasks 8-14's sample code uses ESM `import`/`export default`. When executing Task 7, also convert `api/webhook.js` and `api/notify-telegram.js` to ESM syntax so the whole `api/`/`lib/` tree is consistent — do this as a small addition to Task 7, verified with `node --check` on both files after conversion.~~ **Resolved in Task 7** (commit `ee6ef93`): both files converted to `export default async function handler(...) {...}`. Neither file had any `require()` calls, so no import statements were needed — the only change was the export syntax. Verified with `node --check` on both (syntax-only; full Vercel runtime behavior still needs a live deploy check).
- **`api/webhook.js` (Task 4) has no guard for missing `TELEGRAM_BOT_TOKEN`/`FIREBASE_WEB_API_KEY`**: if either env var is unset at deploy time, the webhook silently returns 200 OK to Telegram forever while never actually sending a reply or completing the Firestore update (pre-existing unchecked-fetch shape, just newly reachable via config error instead of a typo). `api/notify-telegram.js` already has the `if (!token) return response.status(503)...` pattern — add the same guard to `api/webhook.js` as a fast-follow for consistency and observability.
- ~~**`lib/material-parser.js` (Task 9) xlsx shared-strings and PDF paths are untested**: the xlsx fixture (generated via `openpyxl`) uses inline strings (`t="inlineStr"`), so `parseSharedStrings()` and the `type === "s"` branch — the path real Excel-produced files predominantly use — has zero test coverage. The PDF extraction path (`pdf-parse` + optional `@napi-rs/canvas`) also has no real-file smoke test, only the empty-file/warning case. Add a shared-strings xlsx fixture and a minimal real PDF fixture before this parser is trusted against real user uploads in Task 13.~~ **Resolved** (commit `6d7892f`): confirmed via openpyxl source (`openpyxl/cell/_writer.py`) that openpyxl 3.1.5 always writes `t="inlineStr"` on save and has no shared-strings writer at all, so the gap could not be closed by re-generating with openpyxl — `lib/__fixtures__/sample-shared-strings.xlsx` was hand-built (valid xlsx zip with a real `xl/sharedStrings.xml` `<sst>` table and `t="s"` cells referencing it by index), verified independently with `unzip -l`/`unzip -p` and by loading it in openpyxl (`load_workbook` round-trips the expected rows), then verified end-to-end through the actual `extractMaterialText()` code path. For PDF, `reportlab` was available and used to generate `lib/__fixtures__/sample.pdf` with a genuine text layer, independently verified with both `pdftotext` and `pypdf` before exercising it through `extractMaterialText()`. Both new fixtures are covered by new tests in `lib/material-parser.fixtures.test.js` asserting on the exact embedded text; all 6 tests in `lib/material-parser.test.js` + `lib/material-parser.fixtures.test.js` pass. `@napi-rs/canvas` is present in `node_modules` in this environment (transitive dep) and its import in `extractPdf()` is wrapped in a bare `try {}catch{}`, so the primary `pdf-parse` text-layer path does not hard-depend on it — not independently re-verified with canvas absent, since it is currently installed.
- **`isOrgOwnerOrAdmin(orgId)` (Task 5) doesn't actually scope by `orgId`**: any user whose own `orgRole` is `owner`/`admin` (for whatever org they belong to) can update/delete ANY organization document, not just their own — the parameter name implies scoping that doesn't exist. Confirmed pre-existing (identical since the original `organizations` rule draft, not introduced by the create-path fix round), not a regression, but worth fixing: compare the caller's own `organizationId` to the target `orgId` path parameter via a `get()` on the caller's `users` doc. Track as a follow-up, not blocking Task 5's deploy.
- **`firebase-admin@14.1.0` (Task 10) pulls in 6 moderate `npm audit` advisories** transitively via `@google-cloud/storage` → `gaxios`/`teeny-request` → `uuid@9.0.1` (GHSA-w5hq-g745-h8pq). Traced: this codebase never calls `uuid` directly, only Google Cloud client-library internals, almost certainly via the unaffected `uuid.v4()` path, not the vulnerable buf-supplied v3/v5/v6 path. `npm audit fix --force` would downgrade to `firebase-admin@10.3.0` (breaking major regression) — not worth doing. Track as a dependency-watch item: re-check when `firebase-admin` ships a release pulling in a patched `@google-cloud/storage`.
