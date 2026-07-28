# Codex Composer Capabilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a Codex-style Composer whose Files/Folders, hidden Draft, Goal, Plan mode and policy gates map to real platform and App Server behavior. Record Skill, Plugins, Apps, Skills and history references stay hidden in this iteration.

**Architecture:** Add vendor-neutral Composer contracts and a server-owned capability registry, then translate validated choices into locked Codex App Server parameters. Stage browser files in a per-user/per-thread server workspace, persist immutable Turn input snapshots, and expose each capability only when runtime, organization policy and user grants all allow it.

**Tech Stack:** TypeScript, Zod, Fastify, React, SQLite WAL, Codex App Server JSONL, Vitest, Testing Library, Playwright.

---

## File map

- `packages/contracts/src/composer.ts`: permission, capability, attachment and Turn input schemas.
- `packages/contracts/src/composer.test.ts`: contract validation and policy-bypass regression tests.
- `packages/contracts/src/index.ts`: public Composer contract exports and effective config integration.
- `apps/api/src/domain/composer-capabilities.ts`: server-owned capability registry and permission expansion.
- `apps/api/src/domain/composer-capabilities.test.ts`: capability filtering and permission truth-table tests.
- `apps/api/src/infra/codex/codex-runtime.ts`: App Server permission, input, Goal and Plan translation.
- `apps/api/src/infra/codex/codex-runtime.test.ts`: exact JSONL parameter tests.
- `apps/api/src/infra/db/schema.ts`: attachment and Thread goal persistence.
- `apps/api/src/infra/db/migrate.ts`: additive SQLite migrations.
- `apps/api/src/domain/platform-store.ts`: attachment, Goal and immutable input snapshot storage.
- `apps/api/src/domain/platform-service.ts`: owner ACL, policy resolution and submission orchestration.
- `apps/api/src/server.ts`: capability, attachment and Goal endpoints.
- `apps/web/src/components/thread/PermissionModePicker.tsx`: Codex-style permission Popover.
- `apps/web/src/components/thread/PermissionModePicker.test.tsx`: keyboard, selected, disabled and reason tests.
- `apps/web/src/components/thread/ComposerAddMenu.tsx`: dynamic Add/Plugins/Apps/Files and chats menu.
- `apps/web/src/components/thread/ComposerAddMenu.test.tsx`: sections, selection and unavailable reasons.
- `apps/web/src/components/thread/AttachmentChips.tsx`: upload and reference status.
- `apps/web/src/app.tsx`: wire Composer state and submit bundle.
- `apps/web/src/styles.css`: Codex parity styling.
- `tests/e2e/workspace.spec.ts`: browser UAT for permission and Add workflows.

### Task 1: Permission contracts and Runtime truth table

- [x] **Step 1: Write failing contract tests**

Add tests proving the accepted modes are `ASK_FOR_APPROVAL`, `APPROVE_FOR_ME`, `FULL_ACCESS`,
`CUSTOM`, and that Custom requires `profileId` while other modes reject it.

- [x] **Step 2: Run the contract test and confirm RED**

Run: `pnpm exec vitest run packages/contracts/src/composer.test.ts`
Expected: FAIL because Composer permission schemas do not exist.

- [x] **Step 3: Implement the minimal contracts**

Create discriminated Zod schemas for `ExecutionPermissionSelection`, `ExecutionPermission`,
`ComposerCapability` and `TurnInputBundle`; export them from the package index.

- [x] **Step 4: Write failing Runtime mapping tests**

Assert exact mappings:

```ts
ASK_FOR_APPROVAL -> workspaceWrite + on-request + user
APPROVE_FOR_ME   -> workspaceWrite + on-request + auto_review
FULL_ACCESS      -> dangerFullAccess + never + user
CUSTOM           -> permissions=profileId and no sandboxPolicy
```

- [x] **Step 5: Run Runtime tests and confirm RED**

Run: `pnpm exec vitest run apps/api/src/infra/codex/codex-runtime.test.ts`
Expected: FAIL because the current Runtime only accepts legacy permission modes and `ASK`.

- [x] **Step 6: Implement mapping and run GREEN**

Translate the vendor-neutral selection in one helper used by `thread/start`, `thread/resume` and
`turn/start`. Run both commands from Steps 2 and 5; expect PASS.

### Task 2: Server-owned Composer Capability Registry

- [x] **Step 1: Write failing domain tests**

Cover available file picker and Goal, experimental Plan mode, unavailable Skill Recorder,
policy-blocked Full access, empty approved Skills/Apps, and current-user-only Thread references.

- [x] **Step 2: Run and confirm RED**

Run: `pnpm exec vitest run apps/api/src/domain/composer-capabilities.test.ts`
Expected: FAIL because the registry does not exist.

- [x] **Step 3: Implement registry and API**

Build `listComposerCapabilities(actor, thread, runtime, policy)` and expose
`GET /api/composer/capabilities?threadId=:id`. Never accept a browser-supplied availability or
server path.

- [x] **Step 4: Run domain and server tests**

Run:
`pnpm exec vitest run apps/api/src/domain/composer-capabilities.test.ts apps/api/src/server-api.test.ts`
Expected: PASS.

### Task 3: Codex-style permission and Add menus

- [x] **Step 1: Write failing component tests**

Verify labels, descriptions, selected checkmark, disabled reasons, section headings, Escape/outside
close behavior, focus return, and no unsupported click callback.

- [x] **Step 2: Run and confirm RED**

Run:
`pnpm exec vitest run apps/web/src/components/thread/PermissionModePicker.test.tsx apps/web/src/components/thread/ComposerAddMenu.test.tsx`
Expected: FAIL because components do not exist.

- [x] **Step 3: Implement minimal components**

Use buttons and semantic `role=menu/menuitem`; no raw `<select>`. Render the permission mode icon
and Add button in the same toolbar positions as the Codex reference. Disabled items retain their
explanation.

- [x] **Step 4: Wire Thread and New Chat Composers**

Fetch capabilities, persist Thread-sticky permission, lock configuration during an active Turn,
and retain the existing model/Effort and send/stop behavior.

- [x] **Step 5: Run GREEN**

Run: `pnpm exec vitest run apps/web/src/v11-app.test.tsx`
Expected: all web unit tests pass.

### Task 4: Isolated file and image staging

- [ ] **Step 1: Write failing security tests**

Reject ownership mismatch, directory traversal, symbolic links, zero-byte unsupported files,
oversized batches, executable types and a Turn referencing another user’s attachment.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm exec vitest run apps/api/src/domain/attachments.test.ts`
Expected: FAIL because staging does not exist.

- [ ] **Step 3: Add migrations and store**

Persist attachment metadata and a server-generated relative staging reference. Use
`<runtime-root>/<tenant>/<user>/<thread>/<attachment>` with resolved-path containment checks; never
persist browser local paths.

- [ ] **Step 4: Add upload/delete endpoints**

Stream uploads with configured byte limits, scan before READY, delete only current-user drafts,
and perform an ownership recheck on Turn submission.

- [ ] **Step 5: Translate inputs**

Map READY images to `localImage`, Skills to `skill`, Apps/Threads to typed context and normal files
to controlled paths plus `additionalContext`.

- [ ] **Step 6: Run GREEN**

Run:
`pnpm exec vitest run apps/api/src/domain/attachments.test.ts apps/api/src/infra/codex/codex-runtime.test.ts`
Expected: PASS.

### Task 5: Goal and Plan mode

- [ ] **Step 1: Write failing protocol tests**

Verify `thread/goal/set|get|clear`, Goal persistence across Turns, and the locked
`collaborationMode=plan` preset for the current and subsequent new Turns.

- [ ] **Step 2: Run and confirm RED**

Run:
`pnpm exec vitest run apps/api/src/infra/codex/codex-runtime.test.ts apps/api/src/domain/composer-capabilities.test.ts`
Expected: FAIL for missing Goal/Plan adapters.

- [ ] **Step 3: Implement Runtime adapters and orchestration**

Set Goal before `turn/start`; fail the submission explicitly if Goal mutation fails. Send Plan mode
in the immutable Turn snapshot and keep the Thread setting until the user turns it off.

- [ ] **Step 4: Add Composer dialogs and Chips**

Goal supports objective, status, token budget and platform time budget; Plan mode is a Thread-sticky
menu toggle. Unsupported Add categories are not rendered.

- [ ] **Step 5: Run GREEN**

Run: `pnpm --filter @codexplatform/api test && pnpm --filter @codexplatform/web test`
Expected: PASS.

### Task 6: Full verification and visual UAT

- [ ] **Step 1: Run static and unit verification**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: exit 0 with no failures.

- [ ] **Step 2: Run browser UAT**

Run: `pnpm test:e2e`
Expected: permission menu, Add menu, upload, Goal, Plan and active-Turn lock scenarios pass.

- [ ] **Step 3: Run complete repository verification**

Run: `pnpm verify`
Expected: exit 0.

- [ ] **Step 4: Perform visual comparison**

Capture New Chat and active Thread at the same viewport as the stored Codex references. Check
Composer proportions, menu anchoring, labels, spacing, selected state and disabled reasons; record
remaining intentional enterprise differences.

- [ ] **Step 5: Update acceptance evidence and commit**

Update `docs/acceptance.md` with exact commands, counts and screenshot paths. Commit only after the
fresh verification evidence is present.
