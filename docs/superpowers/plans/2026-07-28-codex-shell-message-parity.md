# Codex Shell and Message Parity Implementation Plan

> **For Codex:** Execute this plan task-by-task with test-driven development. Do not change production code until the relevant test has failed for the expected reason.

**Goal:** Make the CodexPlatform Thread shell and messaging interaction match the captured Codex desktop references: minimal header, right-aligned user messages, sidebar running indicator, and Composer-owned stop/steer behavior.

**Architecture:** Keep the existing Thread/Turn/SSE/runtime data model. Introduce small presentational components and pure status helpers around the existing `ThreadPage`, while preserving the existing mutation and archive flows. Treat the four screenshots in `docs/research/codex-reference/` as the visual acceptance baseline.

**Tech Stack:** React 19, TypeScript, TanStack Query, React Router, Vitest, Testing Library, Playwright, CSS.

---

## Task 1: Codex-style minimal Thread header

**Files:**
- Create: `apps/web/src/components/thread/WorkspaceHeader.tsx`
- Create: `apps/web/src/components/thread/WorkspaceHeader.test.tsx`
- Modify: `apps/web/src/app.tsx`
- Modify: `apps/web/src/styles.css`

1. Write failing component tests asserting:
   - The left side contains folder icon semantics, the current Thread title, and an overflow menu button.
   - The right side contains only pinned summary, bottom panel, and side panel toggles.
   - `Live`, `StatusBadge`, the large `停止`, and the large `Archive` button are absent.
   - Archive is available inside the overflow menu only when `canArchive=true`.
2. Run `pnpm --filter @codexplatform/web test WorkspaceHeader.test.tsx` and confirm the expected import/component failure.
3. Implement `WorkspaceHeader` with controlled callbacks and an accessible native popover/menu state.
4. Replace the inline `ThreadPage` header with the component. Keep archive mutation in `ThreadPage`; pass it as a callback.
5. Update desktop/mobile CSS to keep a single compact row.
6. Run the focused test and `v11-app.test.tsx`; commit.

## Task 2: Sidebar running indicator

**Files:**
- Create: `apps/web/src/components/navigation/ThreadNavItem.tsx`
- Create: `apps/web/src/components/navigation/ThreadNavItem.test.tsx`
- Modify: `apps/web/src/app.tsx`
- Modify: `apps/web/src/styles.css`

1. Write failing tests asserting that the public Thread statuses `QUEUED`, `RUNNING`, and `WAITING_APPROVAL` render a small accessible spinner at the right edge, while terminal statuses do not. `ALLOCATING` remains an internal lease state and is not part of the current `Thread.status` contract.
2. Run the focused test and confirm failure.
3. Implement a pure `isActiveThreadStatus` helper and `ThreadNavItem`.
4. Render `ThreadNavItem` from `UserSidebar`.
5. Add the 14px, 1.5px, 900ms Codex-style ring and prevent the title from colliding with it.
6. Run focused and app tests; commit.

## Task 3: Right-aligned IM-style user and Steer messages

**Files:**
- Modify: `apps/web/src/components/thread/Transcript.test.tsx`
- Modify: `apps/web/src/components/thread/Transcript.tsx`
- Modify: `apps/web/src/styles.css`

1. Add failing tests asserting:
   - User messages have `data-message-side="right"`.
   - Normal prompts do not render a `You` label.
   - Steer messages use the same right-side bubble and render only the subtle `Steer` label.
2. Run the focused test and confirm assertion failures.
3. Add explicit message-side and message-kind semantics in `TranscriptRowView`.
4. Replace the transparent left-aligned styles with a right-aligned dark bubble (`max-width:72%`, `16px` radius, `16px 12px` padding); use `88%` on narrow screens.
5. Run focused and app tests; commit.

## Task 4: Composer-owned Stop and Steer control

**Files:**
- Create: `apps/web/src/components/thread/ComposerSubmitControl.tsx`
- Create: `apps/web/src/components/thread/ComposerSubmitControl.test.tsx`
- Modify: `apps/web/src/app.tsx`
- Modify: `apps/web/src/styles.css`

1. Write failing tests asserting:
   - Running + empty Composer renders a white circular `停止` control.
   - Running + non-empty Composer renders the send arrow and submits Steer.
   - Idle + non-empty Composer renders the send arrow.
   - Idle + empty Composer renders a disabled send arrow.
2. Run the focused test and confirm failure.
3. Implement the presentational control with `mode="stop" | "send"`.
4. Wire stop to the existing `interrupt` mutation and send to the existing submit flow. Remove interrupt from the header entirely.
5. Preserve all existing failure reporting and pending-state locks.
6. Run focused and app tests; commit.

## Task 5: Responsive and regression verification

**Files:**
- Modify: `apps/web/e2e/v11-workspace.spec.ts`
- Modify: `apps/web/src/styles.css`
- Modify: `docs/research/codex-reference/README.md`
- Add: `docs/research/codex-reference/codexplatform-parity-uat.png`

1. Add Playwright assertions for:
   - Minimal header controls.
   - Right-aligned user bubble.
   - Sidebar running indicator.
   - Running-empty Composer stop control.
   - No overlap between the header, side panel, bottom panel, and Composer at desktop and narrow widths.
2. Run the targeted Playwright spec and confirm failures before any required CSS fix.
3. Fix responsive layout only where the test exposes a mismatch.
4. Start the current worktree’s API/Web processes and run real-page UAT.
5. Capture `codexplatform-parity-uat.png` at the same desktop viewport as the reference.
6. Compare against:
   - `codex-running-full.png`
   - `codex-user-message-and-turn.png`
   - `codex-minimal-header.png`
   - `codex-sidebar-running-indicator.png`
7. Record the parity checklist and any intentional enterprise-only differences in `README.md`.
8. Run `pnpm test`, `pnpm test:e2e`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `pnpm verify`; commit.

## Task 6: Publish the verified branch

**Files:**
- No product-code changes expected.

1. Inspect `git diff --check`, `git status`, and the commit range.
2. Push `agent/codex-experience-convergence`.
3. Update PR #2 description with the interaction-parity scope, test evidence, and UAT screenshot path.
4. Confirm the PR remains mergeable and do not merge without explicit user approval.
