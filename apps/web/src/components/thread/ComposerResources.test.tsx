// @vitest-environment jsdom

import type { BrowserDraftAttachment, ThreadGoalView } from "@codexplatform/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ComposerResources, readDroppedFiles } from "./ComposerResources.js";

afterEach(cleanup);

const attachment: BrowserDraftAttachment = {
  id: "attachment-1",
  threadId: "thread-1",
  kind: "FILE",
  name: "spec.md",
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

    expect(
      screen.getByRole("listitem", { name: "spec.md · Markdown · 1 KB · Ready" }),
    ).toBeInTheDocument();
    const dropped = new File(["draft"], "draft.md", { type: "text/markdown" });
    fireEvent.drop(screen.getByTestId("composer-drop-zone"), {
      dataTransfer: { files: [dropped] },
    });
    return waitFor(() => expect(onChooseFiles).toHaveBeenCalledWith([dropped]));
  });

  test("keeps an invisible empty drop target and shows compact drag-over feedback", async () => {
    render(
      <ComposerResources
        attachments={[]}
        goal={null}
        goalEditorOpen={false}
        onChooseFiles={vi.fn()}
        onDropError={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onSaveGoal={vi.fn()}
        onGoalAction={vi.fn()}
        onClearGoal={vi.fn()}
        onCloseGoal={vi.fn()}
      />,
    );

    const zone = screen.getByTestId("composer-drop-zone");
    expect(zone).toBeInTheDocument();
    expect(zone).toHaveAttribute("data-drag-active", "false");

    fireEvent.dragEnter(document, { dataTransfer: { types: ["Files"] } });
    await waitFor(() => expect(zone).toHaveAttribute("data-drag-active", "true"));
    expect(screen.getByText("Drop files or folders")).toBeVisible();
  });

  test("recursively reads dropped directories and preserves relative paths", async () => {
    const nested = new File(["nested"], "nested.md", { type: "text/markdown" });
    const top = new File(["top"], "top.txt", { type: "text/plain" });
    const directory = directoryEntry("reports", [
      fileEntry("top.txt", top),
      directoryEntry("assets", [fileEntry("nested.md", nested)]),
    ]);
    const dataTransfer = {
      items: [{ kind: "file", webkitGetAsEntry: () => directory }],
      files: [top, nested],
    } as unknown as DataTransfer;

    const files = await readDroppedFiles(dataTransfer);

    expect(files).toEqual([top, nested]);
    expect(files.map((file) => file.webkitRelativePath)).toEqual([
      "reports/top.txt",
      "reports/assets/nested.md",
    ]);
  });

  test("rejects oversized dropped files with an explicit client limit", async () => {
    const oversized = new File(["x"], "huge.bin");
    Object.defineProperty(oversized, "size", { value: 50 * 1024 * 1024 + 1 });
    const dataTransfer = {
      items: [],
      files: [oversized],
    } as unknown as DataTransfer;

    await expect(readDroppedFiles(dataTransfer)).rejects.toThrow(
      "huge.bin exceeds the 50 MiB file limit",
    );
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

    expect(screen.getByText("ACTIVE · 10/60 min · 10k/200k tokens · Synced")).toBeInTheDocument();
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

interface TestEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
}

function fileEntry(name: string, file: File): TestEntry {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file(success: (value: File) => void) {
      success(file);
    },
  } as TestEntry;
}

function directoryEntry(name: string, children: TestEntry[]): TestEntry {
  let delivered = false;
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader() {
      return {
        readEntries(success: (entries: TestEntry[]) => void) {
          if (delivered) success([]);
          else {
            delivered = true;
            success(children);
          }
        },
      };
    },
  } as TestEntry;
}
