// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { PlatformApi } from "../../types.js";
import { useComposerSession } from "./useComposerSession.js";

function createApi() {
  return {
    createDraft: vi.fn().mockResolvedValue({ id: "draft-1" }),
    getDraft: vi.fn().mockResolvedValue(null),
    getThreadComposer: vi.fn().mockResolvedValue({ planMode: false, revision: 0 }),
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  sessionStorage.clear();
});

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

  test("keeps multiple dropped directory roots as independent attachment uploads", async () => {
    const api = createApi();
    const { result } = renderHook(() =>
      useComposerSession({ api, resolveProjectId: async () => "project-1" }),
    );
    const first = new File(["one"], "one.txt", { type: "text/plain" });
    Object.defineProperty(first, "webkitRelativePath", { value: "alpha/one.txt" });
    const second = new File(["two"], "two.txt", { type: "text/plain" });
    Object.defineProperty(second, "webkitRelativePath", { value: "beta/two.txt" });
    const loose = new File(["loose"], "loose.txt", { type: "text/plain" });

    await act(() => result.current.chooseFiles([first, second, loose]));

    expect(api.uploadAttachments).toHaveBeenCalledTimes(3);
    expect(api.uploadAttachments).toHaveBeenNthCalledWith(1, "draft-1", [first]);
    expect(api.uploadAttachments).toHaveBeenNthCalledWith(2, "draft-1", [second]);
    expect(api.uploadAttachments).toHaveBeenNthCalledWith(3, "draft-1", [loose]);
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

  test("restores a tab-scoped hidden Draft with attachments, Goal, and Composer state", async () => {
    sessionStorage.setItem(
      "codexplatform.composer-draft.v1",
      JSON.stringify({ draftId: "draft-restored", projectId: "project-1" }),
    );
    const api = createApi();
    if (!api.getDraft || !api.getThreadComposer || !api.listThreadAttachments) {
      throw new Error("Draft restore mocks missing");
    }
    vi.mocked(api.getDraft).mockResolvedValue({
      id: "draft-restored",
      projectId: "project-1",
      lifecycleState: "DRAFT",
    });
    vi.mocked(api.getThreadComposer).mockResolvedValue({ planMode: true, revision: 4 });
    vi.mocked(api.listThreadAttachments).mockResolvedValue([
      {
        id: "restored-file",
        threadId: "draft-restored",
        kind: "FILE",
        name: "restored.txt",
        relativePath: ".codexplatform/attachments/restored-file/restored.txt",
        mimeType: "text/plain",
        sizeBytes: 8,
        fileCount: 1,
        scanStatus: "READY",
        createdAt: "2026-07-28T10:00:00.000Z",
      },
    ]);
    if (!api.getThreadGoal) throw new Error("getThreadGoal mock missing");
    vi.mocked(api.getThreadGoal).mockResolvedValue({
      threadId: "draft-restored",
      objective: "恢复草稿",
      status: "PAUSED",
      tokenBudget: 200_000,
      tokensUsed: 20_000,
      timeBudgetSeconds: 3_600,
      timeUsedSeconds: 600,
      runtimeSyncState: "SYNCED",
      createdAt: "2026-07-28T10:00:00.000Z",
      updatedAt: "2026-07-28T10:10:00.000Z",
    });

    const { result } = renderHook(() =>
      useComposerSession({ api, resolveProjectId: async () => "project-1" }),
    );

    await waitFor(() => expect(result.current.resourceThreadId).toBe("draft-restored"));
    await waitFor(() => expect(result.current.readyAttachmentIds).toEqual(["restored-file"]));
    expect(result.current.goal?.objective).toBe("恢复草稿");
    expect(result.current.planMode).toBe(true);
    expect(api.createDraft).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("codexplatform.composer-draft.v1")).toBe(
      '{"draftId":"draft-restored","projectId":"project-1"}',
    );
  });

  test("awaits one pending Draft restore when Files, Goal, and Plan are used immediately", async () => {
    sessionStorage.setItem(
      "codexplatform.composer-draft.v1",
      JSON.stringify({ draftId: "draft-restored", projectId: "project-1" }),
    );
    const restore = deferred<{
      id: string;
      projectId: string;
      lifecycleState: "DRAFT";
    }>();
    const api = createApi();
    if (!api.getDraft || !api.getThreadComposer) throw new Error("Draft restore mocks missing");
    vi.mocked(api.getDraft).mockReturnValue(restore.promise);
    vi.mocked(api.getThreadComposer).mockResolvedValue({ planMode: false, revision: 7 });
    const { result } = renderHook(() =>
      useComposerSession({ api, resolveProjectId: async () => "project-1" }),
    );
    await waitFor(() => expect(api.getDraft).toHaveBeenCalledTimes(1));

    let actions!: Promise<unknown[]>;
    act(() => {
      actions = Promise.all([
        result.current.chooseFiles([new File(["one"], "one.txt", { type: "text/plain" })]),
        result.current.saveGoal({
          objective: "恢复后继续",
          tokenBudget: 200_000,
          timeBudgetSeconds: 3_600,
        }),
        result.current.togglePlanMode(),
      ]);
    });
    expect(api.createDraft).not.toHaveBeenCalled();

    restore.resolve({
      id: "draft-restored",
      projectId: "project-1",
      lifecycleState: "DRAFT",
    });
    await act(() => actions);

    expect(api.getDraft).toHaveBeenCalledTimes(1);
    expect(api.createDraft).not.toHaveBeenCalled();
    expect(api.uploadAttachments).toHaveBeenCalledWith("draft-restored", [expect.any(File)]);
    expect(api.putThreadGoal).toHaveBeenCalledWith(
      "draft-restored",
      expect.objectContaining({ objective: "恢复后继续" }),
    );
    expect(api.patchThreadComposer).toHaveBeenCalledWith("draft-restored", {
      planMode: true,
      revision: 7,
    });
    expect(result.current.resourceThreadId).toBe("draft-restored");
    expect(result.current.goal?.objective).toBe("恢复后继续");
    expect(result.current.planMode).toBe(true);
  });

  test("ignores a stale Draft restore after the hook moves to another Thread generation", async () => {
    sessionStorage.setItem(
      "codexplatform.composer-draft.v1",
      JSON.stringify({ draftId: "draft-stale", projectId: "project-1" }),
    );
    const restore = deferred<{
      id: string;
      projectId: string;
      lifecycleState: "DRAFT";
    }>();
    const api = createApi();
    if (!api.getDraft || !api.listThreadAttachments) throw new Error("Draft restore mocks missing");
    vi.mocked(api.getDraft).mockReturnValue(restore.promise);
    vi.mocked(api.listThreadAttachments).mockImplementation(async (threadId) =>
      threadId === "draft-stale"
        ? [
            {
              id: "stale-file",
              threadId,
              kind: "FILE",
              name: "stale.txt",
              relativePath: ".codexplatform/attachments/stale-file/stale.txt",
              mimeType: "text/plain",
              sizeBytes: 5,
              fileCount: 1,
              scanStatus: "READY",
              createdAt: "2026-07-28T10:00:00.000Z",
            },
          ]
        : [],
    );
    const initialProps: { threadId: string | undefined } = { threadId: undefined };
    const { result, rerender } = renderHook(
      ({ threadId }: { threadId: string | undefined }) =>
        useComposerSession({
          api,
          threadId,
          resolveProjectId: async () => "project-1",
        }),
      { initialProps },
    );
    await waitFor(() => expect(api.getDraft).toHaveBeenCalledTimes(1));

    rerender({ threadId: "thread-active" });
    restore.resolve({
      id: "draft-stale",
      projectId: "project-1",
      lifecycleState: "DRAFT",
    });

    await waitFor(() => expect(result.current.resourceThreadId).toBe("thread-active"));
    await act(async () => {
      await restore.promise;
      await Promise.resolve();
    });
    expect(result.current.resourceThreadId).toBe("thread-active");
    expect(result.current.readyAttachmentIds).not.toContain("stale-file");
  });

  test("clears an expired Draft key, creates a replacement, and clears it after activation", async () => {
    sessionStorage.setItem(
      "codexplatform.composer-draft.v1",
      JSON.stringify({ draftId: "draft-expired", projectId: "project-1" }),
    );
    const api = createApi();
    if (!api.getDraft) throw new Error("getDraft mock missing");
    vi.mocked(api.getDraft).mockRejectedValue({ status: 404 });
    const { result } = renderHook(() =>
      useComposerSession({ api, resolveProjectId: async () => "project-1" }),
    );

    await waitFor(() =>
      expect(sessionStorage.getItem("codexplatform.composer-draft.v1")).toBeNull(),
    );
    await act(() =>
      result.current.chooseFiles([new File(["new"], "new.txt", { type: "text/plain" })]),
    );
    expect(sessionStorage.getItem("codexplatform.composer-draft.v1")).toBe(
      '{"draftId":"draft-1","projectId":"project-1"}',
    );

    act(() => result.current.markActivated());
    expect(sessionStorage.getItem("codexplatform.composer-draft.v1")).toBeNull();
  });
});
