import type {
  ComposerState,
  DraftAttachment,
  ThreadGoalInput,
  ThreadGoalPatch,
  ThreadGoalView,
} from "@codexplatform/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PlatformApi } from "../../types.js";
import {
  type ComposerAttachment,
  composerAttachmentsBlockSubmission,
  type PendingComposerAttachment,
} from "./ComposerResources.js";

const DRAFT_SESSION_KEY = "codexplatform.composer-draft.v1";

interface UseComposerSessionInput {
  api: PlatformApi;
  threadId?: string | undefined;
  initialComposerState?: ComposerState | undefined;
  resolveProjectId(): Promise<string>;
}

export function useComposerSession({
  api,
  threadId,
  initialComposerState,
  resolveProjectId,
}: UseComposerSessionInput) {
  const [resourceThreadId, setResourceThreadId] = useState(threadId ?? null);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [goal, setGoal] = useState<ThreadGoalView | null>(null);
  const [goalEditorOpen, setGoalEditorOpen] = useState(false);
  const [planMode, setPlanMode] = useState(initialComposerState?.planMode ?? false);
  const [composerRevision, setComposerRevision] = useState(initialComposerState?.revision ?? 0);
  const [busyCount, setBusyCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const resourceThreadIdRef = useRef(threadId ?? null);
  const draftPromiseRef = useRef<Promise<string> | null>(null);
  const restorePromiseRef = useRef<Promise<string | null> | null>(null);
  const restoreAttemptedRef = useRef(false);
  const sessionGenerationRef = useRef(0);
  const revisionRef = useRef(initialComposerState?.revision ?? 0);
  const pendingSequenceRef = useRef(0);
  const initialPlanMode = initialComposerState?.planMode ?? false;
  const initialComposerRevision = initialComposerState?.revision ?? 0;

  useEffect(() => {
    sessionGenerationRef.current += 1;
    resourceThreadIdRef.current = threadId ?? null;
    setResourceThreadId(threadId ?? null);
    setAttachments([]);
    setGoalEditorOpen(false);
    setError(null);
    setPlanMode(initialPlanMode);
    setComposerRevision(initialComposerRevision);
    revisionRef.current = initialComposerRevision;
    draftPromiseRef.current = null;
    restorePromiseRef.current = null;
    restoreAttemptedRef.current = false;
  }, [initialComposerRevision, initialPlanMode, threadId]);

  const restoreStoredDraft = useCallback(async (): Promise<string | null> => {
    if (restorePromiseRef.current) return restorePromiseRef.current;
    if (threadId || restoreAttemptedRef.current) return resourceThreadIdRef.current;
    restoreAttemptedRef.current = true;
    const stored = readStoredDraft();
    if (!stored || !api.getDraft) return null;
    const generation = sessionGenerationRef.current;
    const isCurrentRestore = () =>
      sessionGenerationRef.current === generation &&
      resourceThreadIdRef.current === null &&
      storedDraftMatches(stored);
    const pending = (async () => {
      try {
        const restored = await api.getDraft?.(stored.draftId);
        if (!isCurrentRestore()) return resourceThreadIdRef.current;
        if (!restored || restored.projectId !== stored.projectId) {
          clearStoredDraft();
          return null;
        }
        const [loadedAttachments, loadedGoal, loadedComposer] = await Promise.all([
          api.listThreadAttachments?.(restored.id) ?? Promise.resolve([]),
          api.getThreadGoal
            ? api.getThreadGoal(restored.id).catch((cause: unknown) => {
                if (hasStatus(cause, 404)) return null;
                throw cause;
              })
            : Promise.resolve(null),
          api.getThreadComposer?.(restored.id) ?? Promise.resolve({ planMode: false, revision: 0 }),
        ]);
        if (!isCurrentRestore()) return resourceThreadIdRef.current;
        resourceThreadIdRef.current = restored.id;
        setResourceThreadId(restored.id);
        setAttachments(loadedAttachments);
        setGoal(loadedGoal);
        revisionRef.current = loadedComposer.revision;
        setComposerRevision(loadedComposer.revision);
        setPlanMode(loadedComposer.planMode);
        return restored.id;
      } catch (cause) {
        if (hasStatus(cause, 404) && isCurrentRestore()) {
          clearStoredDraft();
          return null;
        }
        if (!isCurrentRestore()) return resourceThreadIdRef.current;
        setError(errorMessage(cause));
        return null;
      }
    })();
    restorePromiseRef.current = pending;
    try {
      return await pending;
    } finally {
      if (restorePromiseRef.current === pending) restorePromiseRef.current = null;
    }
  }, [api, threadId]);

  useEffect(() => {
    if (threadId) return;
    void restoreStoredDraft();
  }, [restoreStoredDraft, threadId]);

  useEffect(() => {
    if (!threadId || !api.getThreadGoal) {
      setGoal(null);
      return;
    }
    let cancelled = false;
    void api
      .getThreadGoal(threadId)
      .then((nextGoal) => {
        if (!cancelled) setGoal(nextGoal);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (hasStatus(cause, 404)) {
          setGoal(null);
          return;
        }
        setError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [api, threadId]);

  useEffect(() => {
    if (!threadId || !api.listThreadAttachments) return;
    let cancelled = false;
    void api
      .listThreadAttachments(threadId)
      .then((loaded) => {
        if (cancelled) return;
        setAttachments((current) => mergeComposerAttachments(loaded, current));
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [api, threadId]);

  const runBusy = async <T>(operation: () => Promise<T>): Promise<T> => {
    setBusyCount((count) => count + 1);
    try {
      return await operation();
    } finally {
      setBusyCount((count) => Math.max(0, count - 1));
    }
  };

  const ensureResourceThread = async (): Promise<string> => {
    if (resourceThreadIdRef.current) return resourceThreadIdRef.current;
    const restored = await restoreStoredDraft();
    if (restored) return restored;
    if (resourceThreadIdRef.current) return resourceThreadIdRef.current;
    if (draftPromiseRef.current) return draftPromiseRef.current;
    if (!api.createDraft) throw new Error("Draft endpoint unavailable");
    const pending = (async () => {
      const projectId = await resolveProjectId();
      const created = await api.createDraft?.({ projectId });
      if (!created) throw new Error("Draft endpoint unavailable");
      resourceThreadIdRef.current = created.id;
      setResourceThreadId(created.id);
      storeDraft({ draftId: created.id, projectId });
      return created.id;
    })();
    draftPromiseRef.current = pending;
    try {
      return await pending;
    } finally {
      draftPromiseRef.current = null;
    }
  };

  const chooseFiles = async (files: readonly File[]) => {
    if (files.length === 0) return;
    setError(null);
    await runBusy(async () => {
      const targetThreadId = await ensureResourceThread();
      if (!api.uploadAttachments) throw new Error("Attachment upload endpoint unavailable");
      const groups = groupFilesByAttachmentRoot(files);
      await Promise.all(
        groups.map(async (group) => {
          const localId = `upload-${++pendingSequenceRef.current}`;
          const pending = pendingAttachment(localId, group);
          setAttachments((current) => [...current, pending]);
          try {
            const uploaded = await api.uploadAttachments?.(targetThreadId, group);
            if (!uploaded) throw new Error("Attachment upload endpoint unavailable");
            setAttachments((current) =>
              current.map((item) =>
                "localId" in item && item.localId === localId ? uploaded : item,
              ),
            );
          } catch (cause) {
            setAttachments((current) =>
              current.map((item) =>
                "localId" in item && item.localId === localId
                  ? { ...item, scanStatus: "FAILED", error: errorMessage(cause) }
                  : item,
              ),
            );
          }
        }),
      );
    }).catch((cause) => setError(errorMessage(cause)));
  };

  const removeAttachment = async (attachment: ComposerAttachment) => {
    setError(null);
    if ("localId" in attachment) {
      setAttachments((current) => current.filter((item) => item !== attachment));
      return;
    }
    if (!api.deleteAttachment) {
      setError("Attachment delete endpoint unavailable");
      return;
    }
    await runBusy(async () => {
      await api.deleteAttachment?.(attachment.threadId, attachment.id);
      setAttachments((current) =>
        current.filter((item) => !("id" in item) || item.id !== attachment.id),
      );
    }).catch((cause) => setError(errorMessage(cause)));
  };

  const openGoal = async () => {
    setError(null);
    try {
      await ensureResourceThread();
      setGoalEditorOpen(true);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const saveGoal = async (input: ThreadGoalInput) => {
    setError(null);
    await runBusy(async () => {
      const targetThreadId = await ensureResourceThread();
      if (!api.putThreadGoal) throw new Error("Goal endpoint unavailable");
      const updated = await api.putThreadGoal(targetThreadId, input);
      setGoal(updated);
      setGoalEditorOpen(false);
    }).catch((cause) => setError(errorMessage(cause)));
  };

  const goalAction = async (action: NonNullable<ThreadGoalPatch["action"]>) => {
    const targetThreadId = resourceThreadIdRef.current;
    if (!targetThreadId || !api.patchThreadGoal) {
      setError("Goal endpoint unavailable");
      return;
    }
    setError(null);
    await runBusy(async () => {
      const updated = await api.patchThreadGoal?.(targetThreadId, { action });
      if (updated) setGoal(updated);
    }).catch((cause) => setError(errorMessage(cause)));
  };

  const clearGoal = async () => {
    const targetThreadId = resourceThreadIdRef.current;
    if (!targetThreadId || !api.deleteThreadGoal) {
      setError("Goal endpoint unavailable");
      return;
    }
    setError(null);
    await runBusy(async () => {
      await api.deleteThreadGoal?.(targetThreadId);
      setGoal(null);
      setGoalEditorOpen(false);
    }).catch((cause) => setError(errorMessage(cause)));
  };

  const togglePlanMode = async () => {
    setError(null);
    await runBusy(async () => {
      const targetThreadId = await ensureResourceThread();
      if (!api.patchThreadComposer) throw new Error("Composer state endpoint unavailable");
      const updated = await api.patchThreadComposer(targetThreadId, {
        planMode: !planMode,
        revision: revisionRef.current,
      });
      revisionRef.current = updated.revision;
      setComposerRevision(updated.revision);
      setPlanMode(updated.planMode);
    }).catch((cause) => setError(errorMessage(cause)));
  };

  const clearSubmittedAttachments = () => {
    setAttachments((current) => current.filter((item) => item.scanStatus !== "READY"));
  };

  return {
    resourceThreadId,
    attachments,
    readyAttachmentIds: attachments.flatMap((attachment) =>
      "id" in attachment && attachment.scanStatus === "READY" ? [attachment.id] : [],
    ),
    submissionBlocked: composerAttachmentsBlockSubmission(attachments),
    goal,
    goalEditorOpen,
    planMode,
    composerRevision,
    busy: busyCount > 0,
    error,
    chooseFiles,
    removeAttachment,
    openGoal,
    closeGoal: () => setGoalEditorOpen(false),
    saveGoal,
    goalAction,
    clearGoal,
    togglePlanMode,
    clearSubmittedAttachments,
    markActivated: () => {
      sessionGenerationRef.current += 1;
      restoreAttemptedRef.current = true;
      restorePromiseRef.current = null;
      clearStoredDraft();
    },
    reportError: (message: string) => setError(message),
  };
}

function readStoredDraft(): { draftId: string; projectId: string } | null {
  if (typeof sessionStorage === "undefined") return null;
  const raw = sessionStorage.getItem(DRAFT_SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.draftId !== "string" || typeof parsed.projectId !== "string") {
      clearStoredDraft();
      return null;
    }
    return { draftId: parsed.draftId, projectId: parsed.projectId };
  } catch {
    clearStoredDraft();
    return null;
  }
}

function storeDraft(value: { draftId: string; projectId: string }) {
  if (typeof sessionStorage === "undefined") return;
  sessionStorage.setItem(DRAFT_SESSION_KEY, JSON.stringify(value));
}

function storedDraftMatches(value: { draftId: string; projectId: string }) {
  const current = readStoredDraft();
  return current?.draftId === value.draftId && current.projectId === value.projectId;
}

function clearStoredDraft() {
  if (typeof sessionStorage === "undefined") return;
  sessionStorage.removeItem(DRAFT_SESSION_KEY);
}

function pendingAttachment(localId: string, files: readonly File[]): PendingComposerAttachment {
  const first = files[0];
  const relativePath = first?.webkitRelativePath ?? "";
  return {
    localId,
    name: relativePath
      ? relativePath.split("/")[0] || first?.name || "folder"
      : first?.name || "file",
    mimeType: relativePath ? "application/x-directory" : first?.type || "application/octet-stream",
    sizeBytes: files.reduce((sum, file) => sum + file.size, 0),
    scanStatus: "SCANNING",
  };
}

function hasStatus(value: unknown, status: number): boolean {
  return Boolean(
    value && typeof value === "object" && "status" in value && value.status === status,
  );
}

function mergeComposerAttachments(
  loaded: readonly DraftAttachment[],
  current: readonly ComposerAttachment[],
): ComposerAttachment[] {
  const byKey = new Map<string, ComposerAttachment>();
  for (const attachment of loaded) byKey.set(attachment.id, attachment);
  for (const attachment of current) {
    const key = "id" in attachment ? attachment.id : attachment.localId;
    byKey.set(key, attachment);
  }
  return [...byKey.values()];
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Composer operation failed";
}

function groupFilesByAttachmentRoot(files: readonly File[]): File[][] {
  const groups = new Map<string, File[]>();
  files.forEach((file, index) => {
    const relativePath = file.webkitRelativePath;
    const root = relativePath ? relativePath.split("/")[0] || file.name : `file:${index}`;
    const key = relativePath ? `folder:${root}` : root;
    const group = groups.get(key) ?? [];
    group.push(file);
    groups.set(key, group);
  });
  return [...groups.values()];
}
