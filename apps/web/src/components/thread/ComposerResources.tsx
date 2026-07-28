import type {
  AttachmentScanStatus,
  BrowserDraftAttachment,
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

export type ComposerAttachment = BrowserDraftAttachment | PendingComposerAttachment;

interface ComposerResourcesProps {
  attachments: readonly ComposerAttachment[];
  goal: ThreadGoalView | null;
  goalEditorOpen: boolean;
  onChooseFiles(files: readonly File[]): void;
  onDropError?(message: string): void;
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
  onDropError,
  onRemoveAttachment,
  onSaveGoal,
  onGoalAction,
  onClearGoal,
  onCloseGoal,
  goalBusy = false,
}: ComposerResourcesProps) {
  const [objective, setObjective] = useState(goal?.objective ?? "");
  const [dragActive, setDragActive] = useState(false);

  useEffect(() => {
    setObjective(goal?.objective ?? "");
  }, [goal?.objective]);

  useEffect(() => {
    const showDropTarget = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) setDragActive(true);
    };
    const hideDropTarget = () => setDragActive(false);
    document.addEventListener("dragenter", showDropTarget);
    document.addEventListener("dragend", hideDropTarget);
    document.addEventListener("drop", hideDropTarget);
    return () => {
      document.removeEventListener("dragenter", showDropTarget);
      document.removeEventListener("dragend", hideDropTarget);
      document.removeEventListener("drop", hideDropTarget);
    };
  }, []);

  return (
    <fieldset
      className={`composer-resources${dragActive ? " is-dragging" : ""}`}
      data-testid="composer-drop-zone"
      data-drag-active={dragActive}
      aria-label="Composer resources"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDragActive(false);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragActive(false);
        void readDroppedFiles(event.dataTransfer)
          .then((files) => {
            if (files.length > 0) onChooseFiles(files);
          })
          .catch((cause: unknown) => {
            onDropError?.(cause instanceof Error ? cause.message : "Unable to read dropped files");
          });
      }}
    >
      {dragActive ? (
        <span className="composer-drop-hint" aria-live="polite">
          <Icon name="file" />
          Drop files or folders
        </span>
      ) : null}
      {attachments.length > 0 ? (
        <ul className="composer-attachment-chips" aria-label="Attached files">
          {attachments.map((attachment) => {
            const key = "id" in attachment ? attachment.id : attachment.localId;
            const state = attachmentStateLabel(attachment.scanStatus);
            const type = attachmentTypeLabel(attachment);
            return (
              <li
                className={`composer-attachment-chip status-${attachment.scanStatus.toLowerCase()}`}
                aria-label={`${attachment.name} · ${type} · ${formatBytes(
                  attachment.sizeBytes,
                )} · ${state}`}
                key={key}
              >
                <Icon
                  name={attachment.mimeType === "application/x-directory" ? "project" : "file"}
                />
                <span>
                  <strong>{attachment.name}</strong>
                  <small>
                    {type} · {formatBytes(attachment.sizeBytes)} · {state}
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
              60 min limit · 200k token limit ·{" "}
              {goal ? syncLabel(goal.runtimeSyncState) : "Pending"}
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
  const status = goal.runtimeSyncState === "NEEDS_RECOVERY" ? "NEEDS_RECOVERY" : goal.status;
  return `${status} · ${Math.round(goal.timeUsedSeconds / 60)}/${Math.round(
    goal.timeBudgetSeconds / 60,
  )} min · ${formatTokenCount(goal.tokensUsed)}/${formatTokenCount(
    goal.tokenBudget,
  )} tokens · ${syncLabel(goal.runtimeSyncState)}`;
}

function formatTokenCount(tokens: number) {
  if (tokens < 1_000) return String(tokens);
  return `${Math.round(tokens / 1_000)}k`;
}

function attachmentTypeLabel(attachment: ComposerAttachment) {
  if (attachment.mimeType === "application/x-directory") return "Folder";
  const extension = attachment.name.split(".").at(-1)?.toLowerCase();
  const known = {
    "application/pdf": "PDF",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PowerPoint",
    "text/markdown": "Markdown",
    "text/plain": "Text",
    "application/json": "JSON",
  } as const;
  if (attachment.mimeType in known) {
    return known[attachment.mimeType as keyof typeof known];
  }
  if (attachment.mimeType.startsWith("image/")) {
    return extension ? `${extension.toUpperCase()} image` : "Image";
  }
  return extension && extension !== attachment.name.toLowerCase()
    ? extension.toUpperCase()
    : "File";
}

const MAX_COMPOSER_ROOTS = 32;
const MAX_FOLDER_FILES = 500;
const MAX_COMPOSER_FILE_BYTES = 50 * 1024 * 1024;
const MAX_COMPOSER_TOTAL_BYTES = 200 * 1024 * 1024;

interface LegacyFileSystemEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
}

interface LegacyFileSystemFileEntry extends LegacyFileSystemEntry {
  file(success: (file: File) => void, error?: (cause: DOMException) => void): void;
}

interface LegacyFileSystemDirectoryEntry extends LegacyFileSystemEntry {
  createReader(): {
    readEntries(
      success: (entries: LegacyFileSystemEntry[]) => void,
      error?: (cause: DOMException) => void,
    ): void;
  };
}

export async function readDroppedFiles(dataTransfer: DataTransfer): Promise<File[]> {
  const items = Array.from(dataTransfer.items ?? []);
  const entries = items.flatMap((item) => {
    if (item.kind !== "file") return [];
    const entry = (
      item as DataTransferItem & {
        webkitGetAsEntry?: () => LegacyFileSystemEntry | null;
      }
    ).webkitGetAsEntry?.();
    return entry ? [entry] : [];
  });
  if (entries.length > MAX_COMPOSER_ROOTS) {
    throw new Error(`Composer supports at most ${MAX_COMPOSER_ROOTS} attachment roots`);
  }
  const files =
    entries.length > 0
      ? (await Promise.all(entries.map((entry) => readFileSystemEntry(entry, entry.name)))).flat()
      : Array.from(dataTransfer.files ?? []);
  validateComposerFiles(files);
  return files;
}

async function readFileSystemEntry(
  entry: LegacyFileSystemEntry,
  relativePath: string,
): Promise<File[]> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => {
      (entry as LegacyFileSystemFileEntry).file(resolve, reject);
    });
    Object.defineProperty(file, "webkitRelativePath", {
      configurable: true,
      value: relativePath,
    });
    return [file];
  }
  if (!entry.isDirectory) return [];
  const reader = (entry as LegacyFileSystemDirectoryEntry).createReader();
  const children: LegacyFileSystemEntry[] = [];
  while (true) {
    const batch = await new Promise<LegacyFileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (batch.length === 0) break;
    children.push(...batch);
    if (children.length > MAX_FOLDER_FILES) {
      throw new Error(`Dropped folder exceeds the ${MAX_FOLDER_FILES} file limit`);
    }
  }
  return (
    await Promise.all(
      children.map((child) => readFileSystemEntry(child, `${relativePath}/${child.name}`)),
    )
  ).flat();
}

export function validateComposerFiles(files: readonly File[]) {
  const roots = new Map<string, number>();
  files.forEach((file, index) => {
    const relativePath = file.webkitRelativePath;
    const root = relativePath ? relativePath.split("/")[0] || file.name : `file:${index}`;
    const key = relativePath ? `folder:${root}` : root;
    roots.set(key, (roots.get(key) ?? 0) + 1);
  });
  if (roots.size > MAX_COMPOSER_ROOTS) {
    throw new Error(`Composer supports at most ${MAX_COMPOSER_ROOTS} attachment roots`);
  }
  for (const count of roots.values()) {
    if (count > MAX_FOLDER_FILES) {
      throw new Error(`Selected folder exceeds the ${MAX_FOLDER_FILES} file limit`);
    }
  }
  let totalBytes = 0;
  for (const file of files) {
    if (file.size > MAX_COMPOSER_FILE_BYTES) {
      throw new Error(`${file.name} exceeds the 50 MiB file limit`);
    }
    totalBytes += file.size;
  }
  if (totalBytes > MAX_COMPOSER_TOTAL_BYTES) {
    throw new Error("Selected files exceed the 200 MiB Turn limit");
  }
}
