// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { PlatformApi } from "../../types.js";
import { useComposerSession } from "./useComposerSession.js";

function createApi() {
  return {
    createDraft: vi.fn().mockResolvedValue({ id: "draft-1" }),
    listThreadAttachments: vi.fn().mockResolvedValue([]),
    uploadAttachments: vi.fn().mockImplementation(async (threadId: string, files: File[]) => ({
      id: `attachment-${files[0]?.name}`,
      threadId,
      kind: files.some((file) => file.webkitRelativePath) ? "FOLDER" : "FILE",
      name: files[0]?.name ?? "file",
      relativePath: `.codexplatform/attachments/a/${files[0]?.name}`,
      mimeType: files[0]?.type || "application/octet-stream",
      sizeBytes: files.reduce((sum: number, file: File) => sum + file.size, 0),
      fileCount: files.length,
      scanStatus: "READY",
      createdAt: "2026-07-28T10:00:00.000Z",
    })),
    deleteAttachment: vi.fn().mockResolvedValue(undefined),
    getThreadGoal: vi.fn().mockRejectedValue({ status: 404 }),
    putThreadGoal: vi.fn().mockImplementation(async (threadId, input) => ({
      threadId,
      ...input,
      status: "ACTIVE",
      tokensUsed: 0,
      timeUsedSeconds: 0,
      runtimeSyncState: "PENDING",
      createdAt: "2026-07-28T10:00:00.000Z",
      updatedAt: "2026-07-28T10:00:00.000Z",
    })),
    patchThreadGoal: vi.fn(),
    deleteThreadGoal: vi.fn(),
    patchThreadComposer: vi.fn().mockResolvedValue({ planMode: true, revision: 1 }),
  } as unknown as PlatformApi;
}

describe("useComposerSession", () => {
  test("creates one hidden Draft on first file action and preserves folder upload grouping", async () => {
    const api = createApi();
    const { result } = renderHook(() =>
      useComposerSession({
        api,
        resolveProjectId: async () => "project-1",
      }),
    );
    const first = new File(["one"], "one.txt", { type: "text/plain" });
    Object.defineProperty(first, "webkitRelativePath", { value: "reports/one.txt" });
    const second = new File(["two"], "two.txt", { type: "text/plain" });
    Object.defineProperty(second, "webkitRelativePath", { value: "reports/two.txt" });

    await act(() => result.current.chooseFiles([first, second]));

    expect(api.createDraft).toHaveBeenCalledTimes(1);
    expect(api.uploadAttachments).toHaveBeenCalledWith("draft-1", [first, second]);
    expect(result.current.resourceThreadId).toBe("draft-1");
    expect(result.current.readyAttachmentIds).toEqual(["attachment-one.txt"]);
    expect(result.current.submissionBlocked).toBe(false);
  });

  test("uploads independent files as separate attachment roots and retains a failed scan", async () => {
    const api = createApi();
    if (!api.uploadAttachments) throw new Error("uploadAttachments mock missing");
    vi.mocked(api.uploadAttachments).mockRejectedValueOnce(
      new Error("Executable files are blocked"),
    );
    const { result } = renderHook(() =>
      useComposerSession({ api, resolveProjectId: async () => "project-1" }),
    );

    await act(() =>
      result.current.chooseFiles([
        new File(["one"], "one.txt", { type: "text/plain" }),
        new File(["bad"], "bad.exe", { type: "application/octet-stream" }),
      ]),
    );

    expect(api.uploadAttachments).toHaveBeenCalledTimes(2);
    expect(result.current.attachments.some((item) => item.scanStatus === "FAILED")).toBe(true);
    expect(result.current.submissionBlocked).toBe(true);
  });

  test("persists sticky Plan state and Goal actions against the Draft", async () => {
    const api = createApi();
    const { result } = renderHook(() =>
      useComposerSession({ api, resolveProjectId: async () => "project-1" }),
    );

    await act(() => result.current.togglePlanMode());
    expect(api.patchThreadComposer).toHaveBeenCalledWith("draft-1", {
      planMode: true,
      revision: 0,
    });
    expect(result.current.planMode).toBe(true);

    await act(() =>
      result.current.saveGoal({
        objective: "持续完成真实 UAT",
        tokenBudget: 200_000,
        timeBudgetSeconds: 3_600,
      }),
    );
    expect(api.putThreadGoal).toHaveBeenCalledWith(
      "draft-1",
      expect.objectContaining({ objective: "持续完成真实 UAT" }),
    );
    expect(result.current.goal?.objective).toBe("持续完成真实 UAT");
  });

  test("loads formal Thread Goal and Composer state without creating another Draft", async () => {
    const api = createApi();
    if (!api.listThreadAttachments) throw new Error("listThreadAttachments mock missing");
    vi.mocked(api.listThreadAttachments).mockResolvedValue([
      {
        id: "attachment-pending",
        threadId: "thread-1",
        kind: "FILE",
        name: "pending.txt",
        relativePath: ".codexplatform/attachments/attachment-pending/pending.txt",
        mimeType: "text/plain",
        sizeBytes: 7,
        fileCount: 1,
        scanStatus: "READY",
        createdAt: "2026-07-28T10:00:00.000Z",
      },
    ]);
    if (!api.getThreadGoal) throw new Error("getThreadGoal mock missing");
    vi.mocked(api.getThreadGoal).mockResolvedValue({
      threadId: "thread-1",
      objective: "继续验收",
      status: "ACTIVE",
      tokenBudget: 200_000,
      tokensUsed: 0,
      timeBudgetSeconds: 3_600,
      timeUsedSeconds: 0,
      runtimeSyncState: "SYNCED",
      createdAt: "2026-07-28T10:00:00.000Z",
      updatedAt: "2026-07-28T10:00:00.000Z",
    });
    const { result } = renderHook(() =>
      useComposerSession({
        api,
        threadId: "thread-1",
        initialComposerState: { planMode: true, revision: 4 },
        resolveProjectId: async () => "project-1",
      }),
    );

    await waitFor(() => expect(result.current.goal?.objective).toBe("继续验收"));
    await waitFor(() => expect(result.current.readyAttachmentIds).toEqual(["attachment-pending"]));
    expect(result.current.planMode).toBe(true);
    expect(result.current.resourceThreadId).toBe("thread-1");
    expect(api.createDraft).not.toHaveBeenCalled();
  });
});
