import type {
  AttachmentScanStatus,
  DraftAttachment,
  ThreadGoalInput,
  ThreadGoalPatch,
  ThreadGoalView,
} from "@codexplatform/contracts";
import { useEffect, useState } from "react";
import { Icon } from "../../icons.js";

export interface PendingComposerAttachment {
  localId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  scanStatus: AttachmentScanStatus;
  error?: string;
}

export type ComposerAttachment = DraftAttachment | PendingComposerAttachment;

interface ComposerResourcesProps {
  attachments: readonly ComposerAttachment[];
  goal: ThreadGoalView | null;
  goalEditorOpen: boolean;
  onChooseFiles(files: readonly File[]): void;
  onRemoveAttachment(attachment: ComposerAttachment): void;
  onSaveGoal(input: ThreadGoalInput): void;
  onGoalAction(action: NonNullable<ThreadGoalPatch["action"]>): void;
  onClearGoal(): void;
  onCloseGoal(): void;
  goalBusy?: boolean;
}

export function ComposerResources({
  attachments,
  goal,
  goalEditorOpen,
  onChooseFiles,
  onRemoveAttachment,
  onSaveGoal,
  onGoalAction,
  onClearGoal,
  onCloseGoal,
  goalBusy = false,
}: ComposerResourcesProps) {
  const [objective, setObjective] = useState(goal?.objective ?? "");

  useEffect(() => {
    setObjective(goal?.objective ?? "");
  }, [goal?.objective]);

  return (
    <fieldset
      className="composer-resources"
      data-testid="composer-drop-zone"
      aria-label="Composer resources"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        const files = Array.from(event.dataTransfer.files);
        if (files.length > 0) onChooseFiles(files);
      }}
    >
      {attachments.length > 0 ? (
        <ul className="composer-attachment-chips" aria-label="Attached files">
          {attachments.map((attachment) => {
            const key = "id" in attachment ? attachment.id : attachment.localId;
            const state = attachmentStateLabel(attachment.scanStatus);
            return (
              <li
                className={`composer-attachment-chip status-${attachment.scanStatus.toLowerCase()}`}
                aria-label={`${attachment.name} · ${formatBytes(attachment.sizeBytes)} · ${state}`}
                key={key}
              >
                <Icon
                  name={attachment.mimeType === "application/x-directory" ? "project" : "file"}
                />
                <span>
                  <strong>{attachment.name}</strong>
                  <small>
                    {formatBytes(attachment.sizeBytes)} · {state}
                  </small>
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${attachment.name}`}
                  onClick={() => onRemoveAttachment(attachment)}
                >
                  ×
                </button>
                {"error" in attachment && attachment.error ? (
                  <em role="alert">{attachment.error}</em>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {goal ? (
        <div className={`composer-goal-chip status-${goal.status.toLowerCase()}`}>
          <Icon name="activity" />
          <span>
            <strong>{goal.objective}</strong>
            <small>{goalBudgetLabel(goal)}</small>
          </span>
        </div>
      ) : null}
      {goalEditorOpen ? (
        <fieldset className="composer-goal-editor">
          <legend className="sr-only">Goal editor</legend>
          <label>
            <span>Goal</span>
            <textarea
              aria-label="Goal objective"
              value={objective}
              rows={2}
              maxLength={10_000}
              onChange={(event) => setObjective(event.target.value)}
              placeholder="Set a goal to keep pursuing"
            />
          </label>
          <div className="composer-goal-actions">
            <span>
              60 min · 200k tokens · {goal ? syncLabel(goal.runtimeSyncState) : "Pending"}
            </span>
            <button type="button" onClick={onCloseGoal}>
              Cancel
            </button>
            {goal ? (
              <>
                {goal.status === "ACTIVE" ? (
                  <button
                    type="button"
                    aria-label="Pause Goal"
                    disabled={goalBusy}
                    onClick={() => onGoalAction("PAUSE")}
                  >
                    Pause
                  </button>
                ) : goal.status === "PAUSED" || goal.status === "BUDGET_LIMITED" ? (
                  <button
                    type="button"
                    aria-label="Resume Goal"
                    disabled={goalBusy}
                    onClick={() => onGoalAction("RESUME")}
                  >
                    Resume
                  </button>
                ) : null}
                {goal.status !== "COMPLETE" ? (
                  <button
                    type="button"
                    aria-label="Complete Goal"
                    disabled={goalBusy}
                    onClick={() => onGoalAction("COMPLETE")}
                  >
                    Complete
                  </button>
                ) : null}
                <button
                  type="button"
                  aria-label="Clear Goal"
                  disabled={goalBusy}
                  onClick={onClearGoal}
                >
                  Clear
                </button>
              </>
            ) : null}
            <button
              type="button"
              aria-label="Save Goal"
              disabled={goalBusy || objective.trim().length === 0}
              onClick={() =>
                onSaveGoal({
                  objective: objective.trim(),
                  timeBudgetSeconds: 3_600,
                  tokenBudget: 200_000,
                })
              }
            >
              Save
            </button>
          </div>
        </fieldset>
      ) : null}
    </fieldset>
  );
}

export function composerAttachmentsBlockSubmission(
  attachments: readonly ComposerAttachment[],
): boolean {
  return attachments.some((attachment) =>
    ["UPLOADING", "SCANNING", "FAILED", "BLOCKED"].includes(attachment.scanStatus),
  );
}

function attachmentStateLabel(status: AttachmentScanStatus) {
  return (
    {
      UPLOADING: "Uploading",
      SCANNING: "Scanning",
      READY: "Ready",
      FAILED: "Failed",
      BLOCKED: "Blocked",
    } as const
  )[status];
}

function formatBytes(bytes: number) {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

function syncLabel(state: ThreadGoalView["runtimeSyncState"]) {
  if (state === "SYNCED") return "Synced";
  if (state === "NEEDS_RECOVERY") return "Needs recovery";
  return "Syncing";
}

function goalBudgetLabel(goal: ThreadGoalView) {
  return `${Math.round(goal.timeBudgetSeconds / 60)} min · ${Math.round(
    goal.tokenBudget / 1_000,
  )}k tokens · ${syncLabel(goal.runtimeSyncState)}`;
}
