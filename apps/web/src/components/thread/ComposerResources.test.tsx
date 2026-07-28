// @vitest-environment jsdom

import type { DraftAttachment, ThreadGoalView } from "@codexplatform/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ComposerResources } from "./ComposerResources.js";

afterEach(cleanup);

const attachment: DraftAttachment = {
  id: "attachment-1",
  threadId: "thread-1",
  kind: "FILE",
  name: "spec.md",
  relativePath: ".codexplatform/attachments/attachment-1/spec.md",
  mimeType: "text/markdown",
  sizeBytes: 1_024,
  fileCount: 1,
  scanStatus: "READY",
  createdAt: "2026-07-28T10:00:00.000Z",
};

const goal: ThreadGoalView = {
  threadId: "thread-1",
  objective: "持续完成工作台验收",
  status: "ACTIVE",
  tokenBudget: 200_000,
  tokensUsed: 10_000,
  timeBudgetSeconds: 3_600,
  timeUsedSeconds: 600,
  runtimeSyncState: "SYNCED",
  createdAt: "2026-07-28T10:00:00.000Z",
  updatedAt: "2026-07-28T10:10:00.000Z",
};

describe("ComposerResources", () => {
  test("renders compact attachment chips and accepts dropped files", () => {
    const onChooseFiles = vi.fn();
    render(
      <ComposerResources
        attachments={[attachment]}
        goal={null}
        goalEditorOpen={false}
        onChooseFiles={onChooseFiles}
        onRemoveAttachment={vi.fn()}
        onSaveGoal={vi.fn()}
        onGoalAction={vi.fn()}
        onClearGoal={vi.fn()}
        onCloseGoal={vi.fn()}
      />,
    );

    expect(screen.getByRole("listitem", { name: "spec.md · 1 KB · Ready" })).toBeInTheDocument();
    const dropped = new File(["draft"], "draft.md", { type: "text/markdown" });
    fireEvent.drop(screen.getByTestId("composer-drop-zone"), {
      dataTransfer: { files: [dropped] },
    });
    expect(onChooseFiles).toHaveBeenCalledWith([dropped]);
  });

  test("keeps failed scanning visible and reports that submission is blocked", () => {
    render(
      <ComposerResources
        attachments={[
          {
            localId: "upload-1",
            name: "unsafe.exe",
            mimeType: "application/octet-stream",
            sizeBytes: 1_024,
            scanStatus: "BLOCKED",
            error: "Executable files are blocked",
          },
        ]}
        goal={null}
        goalEditorOpen={false}
        onChooseFiles={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onSaveGoal={vi.fn()}
        onGoalAction={vi.fn()}
        onClearGoal={vi.fn()}
        onCloseGoal={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Executable files are blocked");
    expect(screen.getByRole("listitem", { name: /unsafe.exe.*Blocked/ })).toBeInTheDocument();
  });

  test("edits and controls a compact persistent Goal with budget and sync state", () => {
    const onGoalAction = vi.fn();
    const onSaveGoal = vi.fn();
    render(
      <ComposerResources
        attachments={[]}
        goal={goal}
        goalEditorOpen
        onChooseFiles={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onSaveGoal={onSaveGoal}
        onGoalAction={onGoalAction}
        onClearGoal={vi.fn()}
        onCloseGoal={vi.fn()}
      />,
    );

    expect(screen.getAllByText("60 min · 200k tokens · Synced")).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("Goal objective"), {
      target: { value: "持续完成真实 UAT" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Goal" }));
    expect(onSaveGoal).toHaveBeenCalledWith({
      objective: "持续完成真实 UAT",
      timeBudgetSeconds: 3_600,
      tokenBudget: 200_000,
    });

    fireEvent.click(screen.getByRole("button", { name: "Pause Goal" }));
    expect(onGoalAction).toHaveBeenCalledWith("PAUSE");
  });
});
