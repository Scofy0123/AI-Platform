import { describe, expect, test } from "vitest";
import {
  AgentMessagePhaseSchema,
  BootstrapSchema,
  ModelCatalogSchema,
  PLATFORM_VERSION,
  ProductModeSchema,
  ReasoningPresentationSchema,
  SubagentThreadDetailSchema,
  SubagentThreadSchema,
  TASK_EVENT_TYPES,
  TaskDetailSchema,
  TaskSummarySchema,
  ThreadSchema,
  UserSettingsPatchSchema,
  UserSettingsSchema,
  UserSettingsViewSchema,
} from "./index.js";

describe("shared contracts scaffold", () => {
  test("exports the platform protocol version", () => {
    expect(PLATFORM_VERSION).toBe("0.1.0");
  });

  test("defines strict shared task summaries and details", () => {
    const summary = {
      id: "task-1",
      projectId: "project-1",
      title: "Summarize the wiki",
      status: "QUEUED",
      updatedAt: "2026-07-21T00:00:00.000Z",
    };
    expect(TaskSummarySchema.parse(summary)).toEqual(summary);
    expect(
      TaskDetailSchema.parse({
        ...summary,
        prompt: "Read the source and summarize it",
        accountAlias: null,
        queue: { position: 1, etaMs: 600_000, etaEstimated: true },
      }),
    ).toMatchObject({ prompt: "Read the source and summarize it" });
    expect(() => TaskSummarySchema.parse({ ...summary, status: "UNKNOWN" })).toThrow();
    expect(() => TaskDetailSchema.parse({ ...summary, prompt: null })).toThrow();
  });

  test("models the 1.1 product shell while enabling only Codex", () => {
    expect(ProductModeSchema.options).toEqual(["CODEX", "CHAT", "WORK"]);
    expect(
      BootstrapSchema.parse({
        platformVersion: PLATFORM_VERSION,
        defaultMode: "CODEX",
        enabledModes: ["CODEX"],
        capabilities: {
          threads: true,
          settings: true,
          subagents: true,
          reasoningSummaries: true,
        },
      }),
    ).toMatchObject({ enabledModes: ["CODEX"] });
    expect(() =>
      BootstrapSchema.parse({
        platformVersion: PLATFORM_VERSION,
        defaultMode: "CODEX",
        enabledModes: ["CODEX", "CHAT"],
        capabilities: {
          threads: true,
          settings: true,
          subagents: true,
          reasoningSummaries: true,
        },
      }),
    ).toThrow();
  });

  test("defines provider-neutral model-routing and runtime notice events", () => {
    expect(TASK_EVENT_TYPES).toEqual(
      expect.arrayContaining(["MODEL_REROUTED", "RUNTIME_WARNING", "CONTEXT_COMPACTED"]),
    );
  });

  test("accepts only safe agent message presentation phases", () => {
    expect(AgentMessagePhaseSchema.parse("commentary")).toBe("commentary");
    expect(AgentMessagePhaseSchema.parse("final_answer")).toBe("final_answer");
    expect(() => AgentMessagePhaseSchema.parse("raw_reasoning")).toThrow();
    expect(TASK_EVENT_TYPES).toContain("AGENT_MESSAGE_PHASE");
  });

  test("accepts a strict runtime model catalog with ordered provider effort strings", () => {
    const catalog = ModelCatalogSchema.parse({
      models: [
        {
          id: "gpt-5.6-codex",
          model: "gpt-5.6-codex",
          displayName: "5.6 Sol",
          description: "Coding model",
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: [
            { value: "high", description: "Deep work" },
            { value: "ultra", description: "Maximum delegation" },
          ],
          inputModalities: ["text", "provider-future-modality"],
          supportsPersonality: true,
        },
      ],
      scope: "SINGLE_ACCOUNT",
      accountCount: 1,
      observedAt: "2026-07-27T04:00:00.000Z",
      stale: false,
    });

    expect(catalog.models[0]?.supportedReasoningEfforts.map((item) => item.value)).toEqual([
      "high",
      "ultra",
    ]);
    expect(catalog.models[0]?.inputModalities).toEqual(["text", "provider-future-modality"]);
    expect(JSON.stringify(catalog)).not.toMatch(/accountId|accountAlias|codexHome/i);
  });

  test("rejects invalid or credential-bearing runtime model catalogs", () => {
    const validCatalog = {
      models: [
        {
          id: "fake-codex-standard",
          model: "fake-codex-standard",
          displayName: "Fake Codex Standard",
          description: "Deterministic test model",
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [{ value: "medium", description: "" }],
          inputModalities: ["text"],
          supportsPersonality: false,
        },
      ],
      scope: "ELIGIBLE_ACCOUNT_INTERSECTION",
      accountCount: 2,
      observedAt: "2026-07-27T04:00:00.000Z",
      stale: true,
    } as const;

    expect(ModelCatalogSchema.parse(validCatalog).scope).toBe("ELIGIBLE_ACCOUNT_INTERSECTION");
    expect(() => ModelCatalogSchema.parse({ ...validCatalog, accountCount: 0 })).toThrow();
    expect(() => ModelCatalogSchema.parse({ ...validCatalog, observedAt: "yesterday" })).toThrow();
    expect(() =>
      ModelCatalogSchema.parse({
        ...validCatalog,
        models: [{ ...validCatalog.models[0], defaultReasoningEffort: "high" }],
      }),
    ).toThrow();
    expect(() =>
      ModelCatalogSchema.parse({
        ...validCatalog,
        models: [
          {
            ...validCatalog.models[0],
            supportedReasoningEfforts: [
              { value: "medium", description: "First" },
              { value: "medium", description: "Duplicate" },
            ],
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      ModelCatalogSchema.parse({
        ...validCatalog,
        scope: "SINGLE_ACCOUNT",
        accountCount: 2,
      }),
    ).toThrow();
    expect(() =>
      ModelCatalogSchema.parse({
        ...validCatalog,
        models: [
          {
            ...validCatalog.models[0],
            supportedReasoningEfforts: [{ value: " ", description: "" }],
          },
        ],
      }),
    ).toThrow();
    for (const leakedField of ["accountId", "accountAlias", "codexHome"]) {
      expect(() =>
        ModelCatalogSchema.parse({ ...validCatalog, [leakedField]: "must-not-reach-browser" }),
      ).toThrow();
    }
  });

  test("exposes strict Thread, Turn and Item projections without owner credentials", () => {
    const configSnapshot = {
      model: null,
      reasoningEffort: "MEDIUM",
      permissionMode: "WORKSPACE_WRITE",
      approvalMode: "ASK",
      personality: "PRAGMATIC",
      instructions: "Use concise Chinese.",
      sourceVersion: "org-policy-v1",
    };
    const thread = ThreadSchema.parse({
      id: "thread-1",
      projectId: "project-1",
      title: "Build it",
      status: "RUNNING",
      updatedAt: "2026-07-21T00:00:00.000Z",
      archivedAt: null,
      currentTurn: {
        id: "turn-1",
        threadId: "thread-1",
        prompt: "Implement the feature",
        status: "RUNNING",
        startedAt: "2026-07-21T00:00:00.000Z",
        completedAt: null,
        durationMs: null,
        model: null,
        effort: "MEDIUM",
        permissionMode: "WORKSPACE_WRITE",
        configSnapshot,
      },
      turns: [
        {
          id: "turn-1",
          threadId: "thread-1",
          prompt: "Implement the feature",
          status: "RUNNING",
          startedAt: "2026-07-21T00:00:00.000Z",
          completedAt: null,
          durationMs: null,
          model: null,
          effort: "MEDIUM",
          permissionMode: "WORKSPACE_WRITE",
          configSnapshot,
        },
      ],
      queue: null,
      items: [
        {
          id: "item-1",
          threadId: "thread-1",
          turnId: "turn-1",
          sequence: 1,
          type: "AGENT_MESSAGE_DELTA",
          timestamp: "2026-07-21T00:00:01.000Z",
          payload: { itemId: "item-1", delta: "Done" },
        },
      ],
    });
    expect(thread.currentTurn?.prompt).toBe("Implement the feature");
    expect(thread.archivedAt).toBeNull();
    expect(thread.turns).toHaveLength(1);
    expect(JSON.stringify(thread)).not.toMatch(/ownerId|leaseId|credential|accountAlias/i);
    expect(() => ThreadSchema.parse({ ...thread, accountAlias: "Codex A" })).toThrow();
    const { archivedAt: _archivedAt, ...withoutArchiveState } = thread;
    expect(() => ThreadSchema.parse(withoutArchiveState)).toThrow();
  });

  test("keeps reasoning presentation explicitly non-auditable", () => {
    expect(
      ReasoningPresentationSchema.parse({
        provider: "openai",
        kind: "SUMMARY",
        summary: "I will inspect the repository first.",
        displayable: true,
        auditEligible: false,
      }),
    ).toMatchObject({ kind: "SUMMARY", auditEligible: false });
    expect(() =>
      ReasoningPresentationSchema.parse({
        provider: "openai",
        kind: "RAW_CHAIN_OF_THOUGHT",
        summary: "secret",
        displayable: true,
        auditEligible: true,
      }),
    ).toThrow();
  });

  test("defines isolated user settings and safe partial updates", () => {
    const settings = UserSettingsSchema.parse({
      general: {
        language: "zh-CN",
        theme: "SYSTEM",
        defaultProjectId: null,
        notificationsEnabled: true,
      },
      execution: {
        model: null,
        reasoningEffort: "MEDIUM",
        permissionMode: "DEFAULT",
        approvalPreference: "ASK",
      },
      personalization: {
        personality: "PRAGMATIC",
        instructions: "",
      },
      updatedAt: "2026-07-21T00:00:00.000Z",
    });
    expect(settings.execution.permissionMode).toBe("DEFAULT");
    expect(
      UserSettingsPatchSchema.parse({
        personalization: { instructions: "Use concise Chinese." },
      }),
    ).toEqual({ personalization: { instructions: "Use concise Chinese." } });
    expect(() => UserSettingsPatchSchema.parse({ rawToml: "dangerous = true" })).toThrow();
    expect(
      UserSettingsViewSchema.parse({
        ...settings,
        policy: {
          allowedModels: null,
          allowedReasoningEfforts: ["LOW", "MEDIUM", "HIGH", "XHIGH"],
          allowedPermissionModes: ["DEFAULT", "READ_ONLY", "WORKSPACE_WRITE"],
          allowedApprovalPreferences: ["ASK"],
          lockedFields: ["execution.permissionMode"],
        },
      }).policy.lockedFields,
    ).toEqual(["execution.permissionMode"]);
    expect(() =>
      UserSettingsPatchSchema.parse({ execution: { permissionMode: "FULL_ACCESS" } }),
    ).toThrow();
    expect(() =>
      UserSettingsPatchSchema.parse({ execution: { approvalPreference: "NEVER" } }),
    ).toThrow();
    expect(UserSettingsPatchSchema.parse({ execution: { reasoningEffort: "ULTRA" } })).toEqual({
      execution: { reasoningEffort: "ULTRA" },
    });
  });

  test("defines subagent summary and detail metadata from observable facts", () => {
    expect(
      SubagentThreadSchema.parse({
        threadId: "agent-thread-1",
        parentThreadId: "thread-1",
        parentTurnId: "turn-1",
        sessionId: null,
        name: "Repository audit",
        role: "subagent",
        model: "gpt-5",
        effort: "HIGH",
        status: "ACTIVE",
        startedAt: "2026-07-21T00:00:00.000Z",
        completedAt: null,
        elapsedMs: 10,
        resultSummary: null,
        tokenUsage: null,
      }),
    ).toMatchObject({ status: "ACTIVE", parentThreadId: "thread-1" });
    expect(
      SubagentThreadDetailSchema.parse({
        threadId: "agent-thread-1",
        parentThreadId: "thread-1",
        parentTurnId: "turn-1",
        sessionId: null,
        name: "Repository audit",
        role: "subagent",
        model: "gpt-5",
        effort: "HIGH",
        status: "DONE",
        startedAt: "2026-07-21T00:00:00.000Z",
        completedAt: "2026-07-21T00:00:01.000Z",
        elapsedMs: 1_000,
        resultSummary: "Done",
        tokenUsage: null,
        items: [
          {
            id: "child-message-1",
            threadId: "agent-thread-1",
            turnId: "agent-turn-1",
            sequence: 1,
            type: "AGENT_MESSAGE_DELTA",
            timestamp: "2026-07-21T00:00:00.500Z",
            payload: { itemId: "child-message-1", delta: "Inspecting" },
          },
        ],
      }).items,
    ).toHaveLength(1);
  });

  test("defines a provider-neutral persisted user message event for Steer input", () => {
    expect(TASK_EVENT_TYPES).toContain("USER_MESSAGE");
  });
});
