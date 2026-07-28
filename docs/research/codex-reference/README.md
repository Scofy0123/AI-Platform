# Codex Interaction Parity References

These screenshots are the visual acceptance baseline for the CodexPlatform 1.1 Thread shell.

## Codex reference captures

- `codex-running-full.png`: complete running workspace composition.
- `codex-user-message-and-turn.png`: right-aligned user message, running timer, and execution stream.
- `codex-minimal-header.png`: project/title/overflow on the left and three panel controls on the right.
- `codex-sidebar-running-indicator.png`: small running ring at the right edge of a history row.

## CodexPlatform UAT capture

- `codexplatform-parity-uat.png`: authenticated browser rendering of the deterministic running fixture at `1512 × 949`.

## 1:1 interaction checklist

- [x] Header is a single compact row.
- [x] Header left contains folder, Thread title, and overflow.
- [x] Header right contains only pinned summary, bottom panel, and side panel controls.
- [x] Runtime status, `Live`, large Stop, and large Archive controls are absent from the header.
- [x] Archive is in the overflow menu.
- [x] User prompt and Steer render as right-aligned IM bubbles.
- [x] Normal prompts do not show a redundant `YOU` label.
- [x] Running state is expressed by `Working for … · current action` inside the Turn.
- [x] Active history rows show the small running ring.
- [x] Empty running Composer shows the white circular Stop control.
- [x] Typing during a running Turn changes the control to the Steer send arrow.
- [x] Narrow layout keeps the header on one row and avoids Composer/header overlap.

## Intentional enterprise differences

- Product and organization branding remains `CodexPlatform`.
- Feishu identity, enterprise permission mode, model-policy errors, and admin entry remain visible.
- All backend state, tool identity, audit, and shared-account governance continue to use CodexPlatform services; only the user-facing interaction grammar follows Codex.
