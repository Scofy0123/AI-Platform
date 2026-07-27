import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  ActorContext,
  EffectiveThreadConfigSnapshot,
  ModelOption,
} from "@codexplatform/contracts";
import type { InternalAccount } from "../../domain/account-admin-store.js";
import type { TaskEventDraft, TaskExecutionAdapter } from "../../domain/platform-service.js";
import type { WeeklyQuota } from "./codex-runtime.js";

export class FakeExecutionAdapter extends EventEmitter implements TaskExecutionAdapter {
  private readonly active = new Map<string, { taskId: string; turnId: string }>();

  async listModels(_account: InternalAccount): Promise<ModelOption[]> {
    return FAKE_MODEL_OPTIONS.map((model) => ({
      ...model,
      supportedReasoningEfforts: model.supportedReasoningEfforts.map((effort) => ({ ...effort })),
      inputModalities: [...model.inputModalities],
    }));
  }

  async startTask(input: {
    accountId: string;
    codexHome: string;
    taskId: string;
    userId: string;
    cwd: string;
    prompt: string;
    existingThreadId: string | null;
    effectiveConfig: EffectiveThreadConfigSnapshot;
    actorContext: ActorContext;
  }): Promise<{ threadId: string; turnId: string }> {
    const threadId = input.existingThreadId ?? `fake-thread-${randomUUID()}`;
    const turnId = `fake-turn-${randomUUID()}`;
    this.active.set(threadId, { taskId: input.taskId, turnId });
    setImmediate(() => this.emitWorkflow(input.taskId, threadId, turnId, input.prompt, input.cwd));
    return { threadId, turnId };
  }

  async steerTask(threadId: string, turnId: string, prompt: string): Promise<void> {
    const active = this.active.get(threadId);
    if (!active || active.turnId !== turnId) throw new Error("Fake turn is not active");
    this.emit("taskEvent", {
      taskId: active.taskId,
      threadId,
      turnId,
      type: "AGENT_MESSAGE_DELTA",
      payload: { itemId: `fake-steer-${randomUUID()}`, delta: `Steer received: ${prompt}` },
    } satisfies TaskEventDraft<"AGENT_MESSAGE_DELTA">);
  }

  async interruptTask(threadId: string, turnId: string): Promise<void> {
    const active = this.active.get(threadId);
    if (!active || active.turnId !== turnId) throw new Error("Fake turn is not active");
    this.emit("taskEvent", {
      taskId: active.taskId,
      threadId,
      turnId,
      type: "TURN_INTERRUPTED",
      payload: { status: "interrupted" },
    } satisfies TaskEventDraft<"TURN_INTERRUPTED">);
    this.active.delete(threadId);
  }

  async respondApproval(_requestId: string, _decision: string): Promise<void> {}

  async startAccountLogin(account: InternalAccount): Promise<{ loginId: string; authUrl: string }> {
    setImmediate(() => this.emit("accountAuthenticated", { accountId: account.id }));
    return {
      loginId: `fake-login-${randomUUID()}`,
      authUrl: "http://127.0.0.1:4310/fake-codex-login-complete",
    };
  }

  async refreshWeeklyQuota(_account: InternalAccount): Promise<WeeklyQuota> {
    return {
      status: "KNOWN",
      limitId: "fake-codex",
      usedPercent: 10,
      remainingPercent: 90,
      windowDurationMins: 10_080,
      resetsAt: Math.floor(Date.now() / 1_000) + 7 * 24 * 60 * 60,
    };
  }

  async close(): Promise<void> {
    this.active.clear();
    this.removeAllListeners();
  }

  private emitWorkflow(
    taskId: string,
    threadId: string,
    turnId: string,
    prompt: string,
    cwd: string,
  ): void {
    const item = randomUUID();
    const events: TaskEventDraft[] = [
      { taskId, threadId, turnId, type: "TURN_STARTED", payload: { status: "inProgress" } },
      {
        taskId,
        threadId,
        turnId,
        type: "PLAN_UPDATED",
        payload: {
          explanation: "Fake Runtime contract workflow",
          plan: [
            { step: "Inspect request", status: "completed" },
            { step: "Run tools", status: "completed" },
            { step: "Return result", status: "completed" },
          ],
        },
      },
      {
        taskId,
        threadId,
        turnId,
        type: "COMMAND_STARTED",
        payload: { itemId: item, command: "printf fake-codexplatform", cwd },
      },
      {
        taskId,
        threadId,
        turnId,
        type: "COMMAND_OUTPUT",
        payload: { itemId: item, delta: "fake-codexplatform\n" },
      },
      {
        taskId,
        threadId,
        turnId,
        type: "COMMAND_COMPLETED",
        payload: {
          itemId: item,
          command: "printf fake-codexplatform",
          aggregatedOutput: "fake-codexplatform\n",
          exitCode: 0,
          durationMs: 2,
        },
      },
      {
        taskId,
        threadId,
        turnId,
        type: "TOOL_STARTED",
        payload: {
          itemId: `tool-${item}`,
          tool: "demo_business_get",
          arguments: { id: "order-1" },
        },
      },
      {
        taskId,
        threadId,
        turnId,
        type: "TOOL_COMPLETED",
        payload: {
          itemId: `tool-${item}`,
          tool: "demo_business_get",
          result: null,
          durationMs: 1,
        },
      },
      {
        taskId,
        threadId,
        turnId,
        type: "DIFF_UPDATED",
        payload: { diff: "+ Fake Runtime produced a deterministic preview\n" },
      },
      {
        taskId,
        threadId,
        turnId,
        type: "AGENT_MESSAGE_DELTA",
        payload: { itemId: `message-${item}`, delta: `Fake Runtime completed: ${prompt}` },
      },
      {
        taskId,
        threadId,
        turnId,
        type: "TURN_COMPLETED",
        payload: { status: "completed", durationMs: 5 },
      },
    ];
    for (const event of events) this.emit("taskEvent", event);
    this.active.delete(threadId);
  }
}

const FAKE_MODEL_OPTIONS = [
  {
    id: "fake-codex-standard",
    model: "fake-codex-standard",
    displayName: "Fake Standard",
    description: "Deterministic local model fixture for standard test flows.",
    hidden: false,
    isDefault: true,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [
      { value: "low", description: "Fast fixture response." },
      { value: "medium", description: "Balanced fixture response." },
      { value: "high", description: "Detailed fixture response." },
    ],
    inputModalities: ["text"],
    supportsPersonality: true,
  },
  {
    id: "fake-codex-deep",
    model: "fake-codex-deep",
    displayName: "Fake Deep",
    description: "Deterministic local model fixture for deeper test flows.",
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: [
      { value: "medium", description: "Balanced fixture response." },
      { value: "high", description: "Detailed fixture response." },
      { value: "xhigh", description: "Maximum-depth fixture response." },
    ],
    inputModalities: ["text"],
    supportsPersonality: true,
  },
] as const satisfies readonly ModelOption[];
