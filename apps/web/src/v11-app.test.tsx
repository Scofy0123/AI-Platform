// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "./api.js";
import { App } from "./app.js";
import type { Session } from "./types.js";

const adminSession = {
  authenticated: true as const,
  user: { id: "user-1", name: "林可", role: "ADMIN" as const },
};

const memberSession = {
  authenticated: true as const,
  user: { id: "user-2", name: "周宁", role: "MEMBER" as const },
};

const projects = [
  { id: "project-1", name: "企业知识助手", taskCount: 1, updatedAt: "2026-07-25T12:00:00.000Z" },
];

const task = {
  id: "thread-1",
  projectId: "project-1",
  title: "梳理客户成功周报",
  status: "RUNNING" as const,
  updatedAt: "2026-07-25T12:02:00.000Z",
};

const modelCatalog = {
  models: [
    {
      id: "fake-codex-standard",
      model: "fake-codex-standard",
      displayName: "Fake Codex Standard",
      description: "Deterministic standard model",
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        { value: "low", description: "Fast" },
        { value: "medium", description: "Balanced" },
        { value: "high", description: "Deep" },
      ],
      inputModalities: ["text"],
      supportsPersonality: false,
    },
    {
      id: "fake-codex-deep",
      model: "fake-codex-deep",
      displayName: "Fake Codex Deep",
      description: "Deterministic deep model",
      hidden: false,
      isDefault: false,
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: [
        { value: "medium", description: "Balanced" },
        { value: "high", description: "Deep" },
        { value: "xhigh", description: "Extended" },
      ],
      inputModalities: ["text"],
      supportsPersonality: false,
    },
  ],
  scope: "ELIGIBLE_ACCOUNT_INTERSECTION" as const,
  accountCount: 1,
  observedAt: "2026-07-25T12:00:00.000Z",
  stale: false,
};

const thread = {
  ...task,
  archivedAt: null,
  currentTurn: {
    id: "turn-1",
    threadId: "thread-1",
    prompt: "读取飞书知识库并形成摘要",
    status: "RUNNING" as const,
    startedAt: "2026-07-25T12:00:00.000Z",
    completedAt: null,
    durationMs: null,
    model: null,
    effort: "MEDIUM",
    permissionMode: "DEFAULT",
    configSnapshot: {
      model: null,
      reasoningEffort: "MEDIUM",
      permissionMode: "DEFAULT" as const,
      approvalMode: "ASK" as const,
      personality: "PRAGMATIC" as const,
      instructions: "",
      sourceVersion: "org-policy-1.1a-v1",
    },
  },
  turns: [
    {
      id: "turn-1",
      threadId: "thread-1",
      prompt: "读取飞书知识库并形成摘要",
      status: "RUNNING" as const,
      startedAt: "2026-07-25T12:00:00.000Z",
      completedAt: null,
      durationMs: null,
      model: null,
      effort: "MEDIUM",
      permissionMode: "DEFAULT",
      configSnapshot: {
        model: null,
        reasoningEffort: "MEDIUM",
        permissionMode: "DEFAULT" as const,
        approvalMode: "ASK" as const,
        personality: "PRAGMATIC" as const,
        instructions: "",
        sourceVersion: "org-policy-1.1a-v1",
      },
    },
  ],
  queue: null,
  items: [],
};

function createApi(session: Session = adminSession) {
  return {
    getSession: vi.fn().mockResolvedValue(session),
    getBootstrap: vi.fn().mockResolvedValue({
      platformVersion: "0.1.0",
      defaultMode: "CODEX",
      enabledModes: ["CODEX"],
      capabilities: {
        threads: true,
        settings: true,
        subagents: true,
        reasoningSummaries: true,
      },
    }),
    listProjects: vi.fn().mockResolvedValue(projects),
    createProject: vi.fn().mockResolvedValue({ id: "project-created" }),
    listTasks: vi.fn().mockResolvedValue([task]),
    listModels: vi.fn().mockResolvedValue(modelCatalog),
    getTask: vi.fn().mockResolvedValue({
      ...task,
      prompt: "读取飞书知识库并形成摘要",
      accountAlias: "SECRET SHARED ACCOUNT",
      queue: null,
    }),
    createTask: vi.fn().mockResolvedValue({ id: "thread-created" }),
    startTurn: vi.fn().mockResolvedValue({ status: "RUNNING" }),
    taskAction: vi.fn().mockResolvedValue({ ok: true }),
    listThreads: vi.fn().mockResolvedValue([thread]),
    listArchivedThreads: vi.fn().mockResolvedValue([]),
    getThread: vi.fn().mockResolvedValue(thread),
    getAdminThread: vi.fn().mockResolvedValue({
      ...thread,
      title: "成员的审计 Thread",
      status: "COMPLETED",
      currentTurn: null,
    }),
    createThread: vi.fn().mockResolvedValue({ ...thread, id: "thread-created" }),
    startThreadTurn: vi.fn().mockResolvedValue({ status: "RUNNING", turnId: "turn-created" }),
    threadAction: vi.fn().mockResolvedValue({ ok: true }),
    archiveThread: vi.fn().mockResolvedValue({ ok: true }),
    unarchiveThread: vi.fn().mockResolvedValue({ ok: true }),
    listSubagents: vi.fn().mockResolvedValue([
      {
        threadId: "agent-active",
        parentThreadId: "thread-1",
        parentTurnId: "turn-1",
        sessionId: "session-1",
        name: "文档检索",
        role: "researcher",
        model: null,
        effort: "MEDIUM",
        status: "ACTIVE",
        startedAt: "2026-07-25T12:00:00.000Z",
        completedAt: null,
        elapsedMs: 15_000,
        resultSummary: "正在检索飞书知识库",
        tokenUsage: null,
      },
      {
        threadId: "agent-done",
        parentThreadId: "thread-1",
        parentTurnId: "turn-1",
        sessionId: "session-2",
        name: "摘要整理",
        role: "writer",
        model: null,
        effort: "MEDIUM",
        status: "DONE",
        startedAt: "2026-07-25T12:00:00.000Z",
        completedAt: "2026-07-25T12:00:08.000Z",
        elapsedMs: 8_000,
        resultSummary: "已形成周报摘要",
        tokenUsage: null,
      },
    ]),
    getSubagent: vi.fn().mockResolvedValue({
      threadId: "agent-done",
      parentThreadId: "thread-1",
      parentTurnId: "turn-1",
      sessionId: "session-2",
      name: "摘要整理",
      role: "writer",
      model: null,
      effort: "MEDIUM",
      status: "DONE",
      startedAt: "2026-07-25T12:00:00.000Z",
      completedAt: "2026-07-25T12:00:08.000Z",
      elapsedMs: 8_000,
      resultSummary: "已形成周报摘要",
      tokenUsage: null,
      items: [
        {
          id: "agent-message",
          threadId: "agent-done",
          turnId: "agent-turn",
          sequence: 1,
          type: "AGENT_MESSAGE_DELTA",
          timestamp: "2026-07-25T12:00:07.000Z",
          payload: { itemId: "agent-message", delta: "子任务详情正文" },
        },
      ],
    }),
    getMySettings: vi.fn().mockResolvedValue({
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
      personalization: { personality: "PRAGMATIC", instructions: "回答要简洁" },
      updatedAt: "2026-07-25T12:00:00.000Z",
      policy: {
        allowedModels: null,
        allowedReasoningEfforts: ["LOW", "MEDIUM", "HIGH"],
        allowedPermissionModes: ["DEFAULT", "READ_ONLY", "WORKSPACE_WRITE"],
        allowedApprovalPreferences: ["ASK"],
        lockedFields: [],
      },
    }),
    patchMySettings: vi.fn().mockImplementation(async (patch) => ({
      ...(await createApi(session).getMySettings()),
      ...patch,
    })),
    getMyUsage: vi.fn().mockResolvedValue({
      threads: 1,
      turns: 2,
      toolCalls: 3,
      subagents: 2,
      tokenUsage: null,
      tokenUsageStatus: "UNKNOWN",
      quota: { scope: "SHARED_CODEX_ACCOUNT", attributableToUser: false },
    }),
    listMyConnections: vi.fn().mockResolvedValue([
      {
        id: "feishu",
        name: "飞书",
        managed: true,
        connected: true,
        status: "CONNECTED",
        scopes: ["docx:document:readonly"],
      },
    ]),
    listMyPlugins: vi.fn().mockResolvedValue([]),
    decideApproval: vi.fn().mockResolvedValue({ ok: true }),
    addAccount: vi.fn().mockResolvedValue({ id: "account-created" }),
    listAccounts: vi.fn().mockResolvedValue([
      {
        id: "account-1",
        alias: "Codex 01",
        status: "AVAILABLE",
        authStatus: "AUTHENTICATED",
        activeUsers: 2,
        maxUsers: 4,
        weeklyRemainingPercent: 73,
        health: 98,
      },
    ]),
    accountAction: vi.fn().mockResolvedValue({ ok: true }),
    listAudit: vi.fn().mockResolvedValue([]),
    getAdminPolicies: vi.fn().mockResolvedValue({
      productModes: { enabled: ["CODEX"], disabled: ["CHAT", "WORK"] },
      settings: {
        allowedModels: null,
        allowedReasoningEfforts: ["LOW", "MEDIUM", "HIGH"],
        allowedPermissionModes: ["DEFAULT", "READ_ONLY", "WORKSPACE_WRITE"],
        allowedApprovalPreferences: ["ASK"],
        lockedFields: [],
      },
      memory: { nativeSharedAccountMemory: false },
      deploymentStage: "LOCAL_1_1A",
      productionMultiUserEnabled: false,
    }),
    listAdminConnectors: vi.fn().mockResolvedValue([
      {
        id: "feishu",
        name: "飞书",
        managed: true,
        mode: "USER_DELEGATED",
        status: "CONNECTED",
      },
    ]),
    getAdminUsage: vi.fn().mockResolvedValue({
      users: 1,
      threads: 1,
      turns: 2,
      toolCalls: 3,
      subagents: 2,
      tokenUsage: null,
      tokenUsageStatus: "UNKNOWN",
      quota: { scope: "SHARED_CODEX_ACCOUNT", attributableToUser: false },
    }),
    getAdminRuntimeHealth: vi.fn().mockResolvedValue({
      deploymentStage: "LOCAL_1_1A",
      multiUserReady: false,
      workerIsolation: "SHARED_LOCAL_PROCESS",
      safetyMode: "SINGLE_OPERATOR_REAL_EXECUTION",
      safetyAllowedForActor: true,
      accounts: { total: 1, available: 1, unhealthy: 0 },
    }),
  };
}

async function openSidePanel() {
  const toggle = await screen.findByRole("button", { name: "Toggle side panel" });
  fireEvent.click(toggle);
  return screen.findByRole("region", { name: "Side panel" });
}

afterEach(cleanup);

describe("CodexPlatform 1.1 user workspace", () => {
  test("is CODEX-only and presents Codex navigation instead of unavailable product shells", async () => {
    const api = createApi();
    render(<App initialEntries={["/"]} api={api} />);

    expect(await screen.findByRole("link", { name: "New chat" })).toBeInTheDocument();
    await waitFor(() => expect(api.getBootstrap).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("navigation", { name: "Codex workspace" })).toBeInTheDocument();
    expect((await screen.findAllByText("企业知识助手")).length).toBeGreaterThan(0);
    expect(await screen.findByText("梳理客户成功周报")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open admin console" })).toBeInTheDocument();
    expect(screen.queryByText("ChatGPT")).not.toBeInTheDocument();
    expect(screen.queryByText("Work")).not.toBeInTheDocument();
  });

  test("redirects the legacy task URL into a three-pane Thread and never exposes account aliases", async () => {
    const subscribe = vi.fn((_threadId, onEvent) => {
      onEvent({
        taskId: "thread-1",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "message-1",
        sequence: 1,
        timestamp: "2026-07-25T12:00:01.000Z",
        type: "AGENT_MESSAGE_DELTA",
        payload: { itemId: "message-1", delta: "已完成知识库检索。" },
      });
      onEvent({
        taskId: "thread-1",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "reasoning-secret",
        sequence: 2,
        timestamp: "2026-07-25T12:00:02.000Z",
        type: "PROVIDER_REASONING_TEXT",
        payload: { itemId: "reasoning-secret", delta: "RAW_CHAIN_OF_THOUGHT" },
      });
      return () => undefined;
    });

    const api = createApi();
    render(
      <App initialEntries={["/tasks/thread-1"]} api={api} subscribeToTaskEvents={subscribe} />,
    );

    expect(await screen.findByRole("heading", { name: "梳理客户成功周报" })).toBeInTheDocument();
    expect(screen.getByText("读取飞书知识库并形成摘要")).toBeInTheDocument();
    expect(screen.getByText("已完成知识库检索。")).toBeInTheDocument();
    const sidePanel = await openSidePanel();
    expect(within(sidePanel).getByRole("tab", { name: "Plan" })).toBeInTheDocument();
    expect(within(sidePanel).getByRole("tab", { name: "Outputs" })).toBeInTheDocument();
    expect(within(sidePanel).getByRole("tab", { name: "Subagents" })).toBeInTheDocument();
    expect(within(sidePanel).getByRole("tab", { name: "Sources" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Model and Effort: Fake Codex Standard · medium",
      }),
    ).toBeDisabled();
    expect(api.listModels).toHaveBeenCalledWith("thread-1");
    expect(document.body).not.toHaveTextContent("SECRET SHARED ACCOUNT");
    expect(document.body).not.toHaveTextContent("RAW_CHAIN_OF_THOUGHT");
    expect(screen.queryByRole("button", { name: /attach/i })).not.toBeInTheDocument();
  });

  test("renders a completed Codex Turn as collapsed execution followed by a visible final answer", async () => {
    const api = createApi();
    api.getThread.mockResolvedValue({
      ...thread,
      status: "COMPLETED",
      currentTurn: {
        ...thread.currentTurn,
        status: "COMPLETED",
        completedAt: "2026-07-25T12:00:12.000Z",
        durationMs: 12_000,
      },
      turns: [
        {
          ...thread.turns[0],
          status: "COMPLETED",
          completedAt: "2026-07-25T12:00:12.000Z",
          durationMs: 12_000,
        },
      ],
      items: [
        {
          id: "commentary",
          threadId: "thread-1",
          turnId: "turn-1",
          sequence: 1,
          type: "AGENT_MESSAGE_DELTA",
          timestamp: "2026-07-25T12:00:01.000Z",
          payload: { itemId: "commentary", delta: "正在读取企业知识库。" },
        },
        {
          id: "commentary-phase",
          threadId: "thread-1",
          turnId: "turn-1",
          sequence: 2,
          type: "AGENT_MESSAGE_PHASE",
          timestamp: "2026-07-25T12:00:02.000Z",
          payload: { itemId: "commentary", phase: "commentary" },
        },
        {
          id: "tool",
          threadId: "thread-1",
          turnId: "turn-1",
          sequence: 3,
          type: "TOOL_STARTED",
          timestamp: "2026-07-25T12:00:03.000Z",
          payload: { itemId: "tool", tool: "feishu_doc_read", arguments: { id: "doc-1" } },
        },
        {
          id: "tool-completed",
          threadId: "thread-1",
          turnId: "turn-1",
          sequence: 4,
          type: "TOOL_COMPLETED",
          timestamp: "2026-07-25T12:00:04.000Z",
          payload: {
            itemId: "tool",
            tool: "feishu_doc_read",
            result: { title: "企业周报" },
            durationMs: 240,
          },
        },
        {
          id: "final",
          threadId: "thread-1",
          turnId: "turn-1",
          sequence: 5,
          type: "AGENT_MESSAGE_DELTA",
          timestamp: "2026-07-25T12:00:05.000Z",
          payload: { itemId: "final", delta: "企业知识库摘要已经完成。" },
        },
        {
          id: "final-phase",
          threadId: "thread-1",
          turnId: "turn-1",
          sequence: 6,
          type: "AGENT_MESSAGE_PHASE",
          timestamp: "2026-07-25T12:00:06.000Z",
          payload: { itemId: "final", phase: "final_answer" },
        },
        {
          id: "turn-completed",
          threadId: "thread-1",
          turnId: "turn-1",
          sequence: 7,
          type: "TURN_COMPLETED",
          timestamp: "2026-07-25T12:00:12.000Z",
          payload: { status: "completed", durationMs: 12_000 },
        },
      ],
    });

    render(<App initialEntries={["/threads/thread-1"]} api={api} />);

    expect(await screen.findByText("企业知识库摘要已经完成。")).toBeInTheDocument();
    expect(screen.queryByText("正在读取企业知识库。")).not.toBeInTheDocument();
    const execution = screen.getByRole("button", { name: "Worked for 12s" });
    expect(execution).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(execution);

    expect(screen.getByText("正在读取企业知识库。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /查看工具 .*feishu_doc_read/ }));
    expect(await screen.findByRole("region", { name: "Side panel" })).toHaveTextContent(
      "feishu_doc_read",
    );
  });

  test("opens pinned summary, side panel and bottom panel as independent workspace surfaces", async () => {
    const api = createApi();
    api.getThread.mockResolvedValue({
      ...thread,
      items: [
        {
          id: "plan-1",
          threadId: "thread-1",
          turnId: "turn-1",
          sequence: 1,
          type: "PLAN_UPDATED",
          timestamp: "2026-07-25T12:00:01.000Z",
          payload: {
            explanation: "先读取资料，再生成交付物",
            plan: [{ step: "读取资料", status: "completed" }],
          },
        },
        {
          id: "command-1",
          threadId: "thread-1",
          turnId: "turn-1",
          sequence: 2,
          type: "COMMAND_OUTPUT",
          timestamp: "2026-07-25T12:00:02.000Z",
          payload: { itemId: "command-1", delta: "UAT_COMMAND_OK\n" },
        },
      ],
    });

    render(<App initialEntries={["/threads/thread-1"]} api={api} />);

    const pinnedToggle = await screen.findByRole("button", { name: "Toggle pinned summary" });
    const sideToggle = screen.getByRole("button", { name: "Toggle side panel" });
    const bottomToggle = screen.getByRole("button", { name: "Toggle bottom panel" });
    expect(pinnedToggle).toHaveAttribute("aria-expanded", "false");
    expect(sideToggle).toHaveAttribute("aria-expanded", "false");
    expect(bottomToggle).toHaveAttribute("aria-expanded", "false");
    expect(
      within(screen.getByLabelText("Thread conversation")).queryByText("UAT_COMMAND_OK"),
    ).toBeNull();

    fireEvent.click(pinnedToggle);
    const pinnedSummary = screen.getByLabelText("Pinned execution summary");
    expect(pinnedSummary).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Side panel" })).not.toBeInTheDocument();

    fireEvent.click(within(pinnedSummary).getByRole("button", { name: "Open pinned Outputs" }));
    const sidePanel = screen.getByRole("region", { name: "Side panel" });
    expect(sidePanel).toBeInTheDocument();
    expect(within(sidePanel).getByRole("tab", { name: "Outputs" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByLabelText("Pinned execution summary")).toBeInTheDocument();

    fireEvent.click(bottomToggle);
    const bottomPanel = screen.getByRole("region", { name: "Bottom panel" });
    expect(bottomPanel).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Terminal" })).toHaveAttribute("aria-selected", "true");
    expect(within(bottomPanel).getByText("UAT_COMMAND_OK")).toBeInTheDocument();
    expect(sidePanel).toBeInTheDocument();
    expect(screen.getByLabelText("Pinned execution summary")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close side panel" }));
    expect(screen.queryByRole("region", { name: "Side panel" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Bottom panel" })).toBeInTheDocument();
    expect(screen.getByLabelText("Pinned execution summary")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close pinned summary" }));
    await waitFor(() => expect(pinnedToggle).toHaveFocus());
  });

  test("opens only the selected command when provider item ids repeat across Turns", async () => {
    const api = createApi();
    const completedTurn = {
      ...thread.turns[0],
      status: "COMPLETED" as const,
      completedAt: "2026-07-25T12:01:00.000Z",
    };
    const latestTurn = {
      ...completedTurn,
      id: "turn-2",
      prompt: "Second turn",
      startedAt: "2026-07-25T12:02:00.000Z",
      completedAt: "2026-07-25T12:03:00.000Z",
    };
    api.getThread.mockResolvedValue({
      ...thread,
      status: "COMPLETED",
      currentTurn: latestTurn,
      turns: [completedTurn, latestTurn],
      items: [
        {
          id: "first-command-row",
          threadId: "thread-1",
          turnId: "turn-1",
          sequence: 1,
          type: "COMMAND_STARTED",
          timestamp: "2026-07-25T12:00:01.000Z",
          payload: { itemId: "provider-command-1", command: "printf first", cwd: "/workspace" },
        },
        {
          id: "first-output-row",
          threadId: "thread-1",
          turnId: "turn-1",
          sequence: 2,
          type: "COMMAND_OUTPUT",
          timestamp: "2026-07-25T12:00:02.000Z",
          payload: { itemId: "provider-command-1", delta: "FIRST_TURN_ONLY" },
        },
        {
          id: "second-command-row",
          threadId: "thread-1",
          turnId: "turn-2",
          sequence: 3,
          type: "COMMAND_STARTED",
          timestamp: "2026-07-25T12:02:01.000Z",
          payload: { itemId: "provider-command-1", command: "printf second", cwd: "/workspace" },
        },
        {
          id: "second-output-row",
          threadId: "thread-1",
          turnId: "turn-2",
          sequence: 4,
          type: "COMMAND_OUTPUT",
          timestamp: "2026-07-25T12:02:02.000Z",
          payload: { itemId: "provider-command-1", delta: "SECOND_TURN_ONLY" },
        },
      ],
    });

    render(<App initialEntries={["/threads/thread-1"]} api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: /^查看命令 .*printf first/ }));
    const bottomPanel = screen.getByRole("region", { name: "Bottom panel" });
    expect(bottomPanel).toHaveTextContent("FIRST_TURN_ONLY");
    expect(bottomPanel).not.toHaveTextContent("SECOND_TURN_ONLY");
    expect(bottomPanel.querySelectorAll(".terminal-session")).toHaveLength(1);
  });

  test("shows Active and Done subagents and opens independent subagent detail", async () => {
    const api = createApi();
    render(<App initialEntries={["/threads/thread-1"]} api={api} />);

    const sidePanel = await openSidePanel();
    fireEvent.click(within(sidePanel).getByRole("tab", { name: "Subagents" }));
    expect(within(sidePanel).getByRole("heading", { name: "Active" })).toBeInTheDocument();
    expect(within(sidePanel).getByRole("heading", { name: "Done" })).toBeInTheDocument();
    expect(within(sidePanel).getByText("文档检索")).toBeInTheDocument();
    expect(within(sidePanel).getByText("摘要整理")).toBeInTheDocument();

    fireEvent.click(within(sidePanel).getByRole("button", { name: "Open 摘要整理 details" }));
    expect(await within(sidePanel).findByRole("heading", { name: "摘要整理" })).toBeInTheDocument();
    expect(await within(sidePanel).findByText("子任务详情正文")).toBeInTheDocument();
    expect(api.getSubagent).toHaveBeenCalledWith("agent-done");
  });

  test("lets newer Subagent activity move an agent from Active to Done", async () => {
    const subscribe = vi.fn((_threadId, onEvent) => {
      onEvent({
        taskId: "thread-1",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "agent-active-completed",
        sequence: 12,
        timestamp: "2026-07-25T12:00:20.000Z",
        type: "SUBAGENT_ACTIVITY",
        payload: {
          itemId: "agent-active-completed",
          agentThreadId: "agent-active",
          kind: "completed",
          name: "文档检索",
          role: "researcher",
          model: null,
          effort: "MEDIUM",
          status: "DONE",
          resultSummary: "飞书知识库检索完成",
        },
      });
      return () => undefined;
    });
    render(
      <App
        initialEntries={["/threads/thread-1"]}
        api={createApi()}
        subscribeToTaskEvents={subscribe}
      />,
    );

    const sidePanel = await openSidePanel();
    fireEvent.click(within(sidePanel).getByRole("tab", { name: "Subagents" }));
    const done = within(sidePanel).getByRole("heading", { name: "Done" }).closest("section");

    expect(done).not.toBeNull();
    expect(within(done as HTMLElement).getByText("文档检索")).toBeInTheDocument();
    expect(within(done as HTMLElement).getByText("飞书知识库检索完成")).toBeInTheDocument();
  });

  test("does not let a historical Active event downgrade an API-terminal Subagent", async () => {
    const api = createApi();
    const terminalAgent = (await api.listSubagents())[1];
    api.listSubagents.mockResolvedValue([
      {
        ...terminalAgent,
        threadId: "agent-terminal",
        name: "终态核验",
        status: "DONE",
        completedAt: "2026-07-25T12:00:20.000Z",
        resultSummary: "核验完成",
      },
    ]);
    const subscribe = vi.fn((_threadId, onEvent) => {
      onEvent({
        taskId: "thread-1",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "agent-terminal-active",
        sequence: 11,
        timestamp: "2026-07-25T12:00:05.000Z",
        type: "SUBAGENT_ACTIVITY",
        payload: {
          itemId: "agent-terminal-active",
          agentThreadId: "agent-terminal",
          kind: "started",
          name: "终态核验",
          role: "worker",
          model: null,
          effort: "MEDIUM",
          status: "ACTIVE",
          resultSummary: "仍在执行",
        },
      });
      return () => undefined;
    });

    render(
      <App initialEntries={["/threads/thread-1"]} api={api} subscribeToTaskEvents={subscribe} />,
    );

    const sidePanel = await openSidePanel();
    fireEvent.click(within(sidePanel).getByRole("tab", { name: "Subagents" }));
    const active = within(sidePanel).getByRole("heading", { name: "Active" }).closest("section");
    const done = within(sidePanel).getByRole("heading", { name: "Done" }).closest("section");

    expect(active).not.toBeNull();
    expect(done).not.toBeNull();
    expect(within(active as HTMLElement).queryByText("终态核验")).not.toBeInTheDocument();
    expect(within(done as HTMLElement).getByText("终态核验")).toBeInTheDocument();
    expect(within(done as HTMLElement).getByText("核验完成")).toBeInTheDocument();
  });

  test("shows workspace files using workspace-relative paths", async () => {
    const api = createApi();
    api.getThread.mockResolvedValue({
      ...thread,
      items: [
        {
          id: "diff-workspace",
          threadId: "thread-1",
          turnId: "turn-1",
          sequence: 1,
          type: "DIFF_UPDATED",
          timestamp: "2026-07-25T12:00:01.000Z",
          payload: {
            diff: [
              "--- a/.data/real-runtime/workspaces/thread-1/uat-workspace.md",
              "+++ b/.data/real-runtime/workspaces/thread-1/uat-workspace.md",
              "+UAT_WORKSPACE_TURN_1",
            ].join("\n"),
          },
        },
      ],
    });

    render(<App initialEntries={["/threads/thread-1"]} api={api} />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "查看文件变更 1 file changed",
      }),
    );
    const sidePanel = await screen.findByRole("region", { name: "Side panel" });
    expect(sidePanel).toHaveTextContent("uat-workspace.md");
    expect(sidePanel).not.toHaveTextContent(".data/real-runtime/workspaces/thread-1/");
  });

  test("shows one complete Tool detail with arguments, result, status and duration", async () => {
    const api = createApi();
    api.getThread.mockResolvedValue({
      ...thread,
      items: [
        {
          id: "tool-1",
          threadId: "thread-1",
          turnId: "turn-1",
          sequence: 1,
          type: "TOOL_STARTED",
          timestamp: "2026-07-25T12:00:01.000Z",
          payload: {
            itemId: "tool-1",
            tool: "business_read",
            arguments: { id: "order-1" },
          },
        },
        {
          id: "tool-1",
          threadId: "thread-1",
          turnId: "turn-1",
          sequence: 2,
          type: "TOOL_COMPLETED",
          timestamp: "2026-07-25T12:00:02.000Z",
          payload: {
            itemId: "tool-1",
            tool: "business_read",
            result: { id: "order-1", status: "PAID" },
            durationMs: 17,
          },
        },
      ],
    });

    render(<App initialEntries={["/threads/thread-1"]} api={api} />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: /^查看工具 .*business_read/,
      }),
    );
    const sidePanel = await screen.findByRole("region", { name: "Side panel" });
    expect(within(sidePanel).getAllByText("business_read")).toHaveLength(1);
    expect(within(sidePanel).getByText("Completed")).toBeInTheDocument();
    expect(sidePanel).toHaveTextContent('"id": "order-1"');
    expect(sidePanel).toHaveTextContent('"status": "PAID"');
    expect(sidePanel).toHaveTextContent("17 ms");
  });

  test("does not show a stale queue banner once the Turn has completed", async () => {
    const api = createApi();
    api.getThread.mockResolvedValue({
      ...thread,
      status: "COMPLETED",
      currentTurn: {
        ...thread.currentTurn,
        status: "COMPLETED",
        completedAt: "2026-07-25T12:00:10.000Z",
      },
      turns: [
        {
          ...thread.turns[0],
          status: "COMPLETED",
          completedAt: "2026-07-25T12:00:10.000Z",
        },
      ],
      queue: { position: 1, etaMs: 60_000, etaEstimated: true },
      items: [
        {
          id: "queue-1",
          threadId: "thread-1",
          turnId: "turn-1",
          sequence: 1,
          type: "QUEUED",
          timestamp: "2026-07-25T12:00:01.000Z",
          payload: { position: 1, etaMs: 60_000, etaEstimated: true },
        },
        {
          id: "turn-started-1",
          threadId: "thread-1",
          turnId: "turn-1",
          sequence: 2,
          type: "TURN_STARTED",
          timestamp: "2026-07-25T12:00:02.000Z",
          payload: { status: "inProgress" },
        },
        {
          id: "turn-completed-1",
          threadId: "thread-1",
          turnId: "turn-1",
          sequence: 3,
          type: "TURN_COMPLETED",
          timestamp: "2026-07-25T12:00:10.000Z",
          payload: { status: "completed" },
        },
      ],
    });

    render(<App initialEntries={["/threads/thread-1"]} api={api} />);

    expect(await screen.findByText("本轮已完成")).toBeInTheDocument();
    expect(screen.queryByText("队列第 1 位")).not.toBeInTheDocument();
  });

  test("renders observable command, Tool, Diff and approval evidence in Subagent detail", async () => {
    const api = createApi();
    api.getSubagent.mockResolvedValue({
      ...(await api.getSubagent("agent-done")),
      items: [
        {
          id: "agent-command",
          threadId: "agent-done",
          turnId: "agent-turn",
          sequence: 1,
          type: "COMMAND_STARTED",
          timestamp: "2026-07-25T12:00:01.000Z",
          payload: { itemId: "agent-command", command: "pwd", cwd: "/workspace" },
        },
        {
          id: "agent-command-output",
          threadId: "agent-done",
          turnId: "agent-turn",
          sequence: 2,
          type: "COMMAND_OUTPUT",
          timestamp: "2026-07-25T12:00:02.000Z",
          payload: { itemId: "agent-command", delta: "SUBAGENT_RAW_OUTPUT\n" },
        },
        {
          id: "agent-tool",
          threadId: "agent-done",
          turnId: "agent-turn",
          sequence: 3,
          type: "TOOL_STARTED",
          timestamp: "2026-07-25T12:00:03.000Z",
          payload: {
            itemId: "agent-tool",
            tool: "feishu_doc_read",
            arguments: { url: "https://example.invalid" },
          },
        },
        {
          id: "agent-diff",
          threadId: "agent-done",
          turnId: "agent-turn",
          sequence: 4,
          type: "DIFF_UPDATED",
          timestamp: "2026-07-25T12:00:04.000Z",
          payload: { diff: "+++ b/report.md\n+summary" },
        },
        {
          id: "agent-approval",
          threadId: "agent-done",
          turnId: "agent-turn",
          sequence: 5,
          type: "APPROVAL_REQUESTED",
          timestamp: "2026-07-25T12:00:05.000Z",
          payload: {
            approvalId: "approval-agent",
            itemId: "agent-approval",
            approvalType: "COMMAND",
            reason: "需要读取受控目录",
            command: "ls /workspace",
            sourceThreadId: "agent-done",
            sourceSubagent: true,
          },
        },
      ],
    });
    render(<App initialEntries={["/threads/thread-1"]} api={api} />);

    const sidePanel = await openSidePanel();
    fireEvent.click(within(sidePanel).getByRole("tab", { name: "Subagents" }));
    fireEvent.click(
      await within(sidePanel).findByRole("button", { name: "Open 摘要整理 details" }),
    );

    const command = await within(sidePanel).findByRole("button", {
      name: /^查看命令 .*pwd/,
    });
    expect(
      within(sidePanel).getByRole("button", { name: /^查看工具 .*feishu_doc_read/ }),
    ).toBeVisible();
    expect(
      within(sidePanel).getByRole("button", { name: "查看文件变更 1 file changed" }),
    ).toBeVisible();
    expect(within(sidePanel).getByRole("heading", { name: "等待审批" })).toBeInTheDocument();
    expect(within(sidePanel).getByText("来自子 Agent")).toBeInTheDocument();
    expect(within(sidePanel).getByRole("button", { name: "允许一次" })).toBeDisabled();
    expect(within(sidePanel).queryByText("SUBAGENT_RAW_OUTPUT")).not.toBeInTheDocument();

    fireEvent.click(command);
    const bottomPanel = await screen.findByRole("region", { name: "Bottom panel" });
    expect(bottomPanel).toHaveTextContent("SUBAGENT_RAW_OUTPUT");
    expect(within(bottomPanel).getByRole("tab", { name: "Terminal" })).toBeVisible();
    const bottomToggle = screen.getByRole("button", { name: "Toggle bottom panel" });
    expect(bottomToggle).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Close bottom panel" }));
    fireEvent.click(bottomToggle);
    expect(screen.getByRole("region", { name: "Bottom panel" })).toHaveTextContent(
      "SUBAGENT_RAW_OUTPUT",
    );
  });

  test("shows a recoverable Subagent-detail error instead of an endless loading state", async () => {
    const api = createApi();
    api.getSubagent.mockRejectedValue(new Error("SUBAGENT_DETAIL_UNAVAILABLE"));
    render(<App initialEntries={["/threads/thread-1"]} api={api} />);

    const sidePanel = await openSidePanel();
    fireEvent.click(within(sidePanel).getByRole("tab", { name: "Subagents" }));
    fireEvent.click(
      await within(sidePanel).findByRole("button", { name: "Open 摘要整理 details" }),
    );

    expect(await within(sidePanel).findByRole("alert")).toHaveTextContent("无法读取子 Agent 详情");
    expect(within(sidePanel).queryByText("Loading subagent")).not.toBeInTheDocument();
  });

  test("keeps the administrator console in a separate shell", async () => {
    render(<App initialEntries={["/admin/accounts"]} api={createApi()} />);

    expect(await screen.findByRole("heading", { name: "Codex 账号池" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "管理后台导航" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Codex" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Codex workspace" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "New chat" })).not.toBeInTheDocument();
    for (const label of ["Policies", "Connectors", "Usage", "Runtime health"]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
  });

  test("does not render an administrator switch for members", async () => {
    render(<App initialEntries={["/"]} api={createApi(memberSession)} />);

    expect(await screen.findByRole("link", { name: "New chat" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open admin console" })).not.toBeInTheDocument();
  });

  test("fails closed when the CODEX bootstrap capability contract is unavailable", async () => {
    const { getBootstrap: _getBootstrap, ...api } = createApi();
    render(<App initialEntries={["/"]} api={api} />);

    expect(
      await screen.findByRole("heading", { name: "CODEX 工作区能力不可用" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Codex workspace" })).not.toBeInTheDocument();
  });

  test("loads the read-only Runtime health page inside the administrator shell", async () => {
    const api = createApi();
    render(<App initialEntries={["/admin/runtime-health"]} api={api} />);

    expect(await screen.findByRole("heading", { name: "Runtime health" })).toBeInTheDocument();
    expect(await screen.findByText("LOCAL_1_1A")).toBeInTheDocument();
    expect(screen.getByText("SHARED_LOCAL_PROCESS")).toBeInTheDocument();
    expect(api.getAdminRuntimeHealth).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("navigation", { name: "Codex workspace" })).not.toBeInTheDocument();
  });

  test("uses the Runtime default model and resets Effort when the model changes", async () => {
    const api = createApi();
    render(<App initialEntries={["/threads/new"]} api={api} />);

    const picker = await screen.findByRole("button", {
      name: "Model and Effort: Fake Codex Standard · medium",
    });
    fireEvent.click(picker);
    fireEvent.click(screen.getByRole("option", { name: /Fake Codex Deep/ }));

    expect(
      screen.getByRole("button", {
        name: "Model and Effort: Fake Codex Deep · high",
      }),
    ).toBeInTheDocument();
  });

  test("submits both the selected Runtime model and its supported Effort", async () => {
    const api = createApi();
    render(<App initialEntries={["/threads/new?project=project-1"]} api={api} />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Model and Effort: Fake Codex Standard · medium",
      }),
    );
    fireEvent.click(screen.getByRole("option", { name: /Fake Codex Deep/ }));
    fireEvent.click(
      screen.getByRole("radio", {
        name: "xhigh",
      }),
    );
    fireEvent.change(screen.getByLabelText("Message Codex"), {
      target: { value: "整理知识库" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(api.startThreadTurn).toHaveBeenCalledWith("thread-created", "整理知识库", {
        model: "fake-codex-deep",
        reasoningEffort: "xhigh",
        permissionMode: "DEFAULT",
      }),
    );
  });

  test("shows a stale Runtime catalog and fails closed when the catalog is unavailable", async () => {
    const staleApi = createApi();
    staleApi.listModels.mockResolvedValue({ ...modelCatalog, stale: true });
    const first = render(<App initialEntries={["/threads/new"]} api={staleApi} />);

    expect(await screen.findByText("模型目录可能已过期")).toBeInTheDocument();
    first.unmount();

    const unavailableApi = createApi();
    unavailableApi.listModels.mockRejectedValue(new Error("MODEL_CATALOG_UNAVAILABLE"));
    render(<App initialEntries={["/threads/new"]} api={unavailableApi} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("无法读取 Runtime 模型目录");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  test("passes only policy-allowed Turn configuration and gives an explicit project priority", async () => {
    const api = createApi();
    const settings = await api.getMySettings();
    api.getMySettings.mockResolvedValue({
      ...settings,
      general: { ...settings.general, defaultProjectId: "default-project" },
    });
    render(<App initialEntries={["/threads/new?project=project-1"]} api={api} />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Model and Effort: Fake Codex Standard · medium",
      }),
    );
    const permission = screen.getByLabelText("Turn permission mode");
    expect(screen.queryByRole("radio", { name: "ultra" })).not.toBeInTheDocument();
    expect(
      within(permission).queryByRole("option", { name: "FULL_ACCESS" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "high" }));
    fireEvent.change(permission, { target: { value: "READ_ONLY" } });
    fireEvent.change(screen.getByLabelText("Message Codex"), {
      target: { value: "整理知识库" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(api.createThread).toHaveBeenCalledWith({
        projectId: "project-1",
        title: "整理知识库",
        config: {
          model: "fake-codex-standard",
          reasoningEffort: "high",
          permissionMode: "READ_ONLY",
        },
      }),
    );
    expect(api.startThreadTurn).toHaveBeenCalledWith("thread-created", "整理知识库", {
      model: "fake-codex-standard",
      reasoningEffort: "high",
      permissionMode: "READ_ONLY",
    });
  });

  test("uses the Feishu user's default project when a new Thread has no explicit project", async () => {
    const api = createApi();
    const settings = await api.getMySettings();
    api.getMySettings.mockResolvedValue({
      ...settings,
      general: { ...settings.general, defaultProjectId: "personal-default" },
    });
    render(<App initialEntries={["/threads/new"]} api={api} />);

    fireEvent.change(await screen.findByLabelText("Message Codex"), {
      target: { value: "生成复盘" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(api.createThread).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: "personal-default" }),
      ),
    );
  });

  test("keeps a failed follow-up in the composer and shows the runtime conflict", async () => {
    const api = createApi();
    api.getThread.mockResolvedValue({ ...thread, status: "COMPLETED" });
    api.startThreadTurn.mockRejectedValue(
      new ApiError("The current Turn is still active.", 409, "ACTIVE_TURN_RESUME_CONFLICT"),
    );
    render(<App initialEntries={["/threads/thread-1"]} api={api} />);

    const composer = await screen.findByLabelText("Message Codex");
    fireEvent.change(composer, { target: { value: "继续处理未完成部分" } });
    fireEvent.click(screen.getByRole("button", { name: "发送调整" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("ACTIVE_TURN_RESUME_CONFLICT");
    expect(composer).toHaveValue("继续处理未完成部分");
  });

  test("requires an explicit Composer follow-up instead of sending a synthetic Continue prompt", async () => {
    const api = createApi();
    api.getThread.mockResolvedValue({ ...thread, status: "COMPLETED" });
    render(<App initialEntries={["/threads/thread-1"]} api={api} />);

    expect(await screen.findByLabelText("Message Codex")).toBeEnabled();
    expect(screen.queryByRole("button", { name: "继续" })).not.toBeInTheDocument();
    expect(api.startThreadTurn).not.toHaveBeenCalled();
  });

  test("passes the selected Turn configuration to a continuous follow-up", async () => {
    const api = createApi();
    api.getThread.mockResolvedValue({
      ...thread,
      status: "COMPLETED",
      currentTurn: {
        ...thread.currentTurn,
        status: "COMPLETED",
        completedAt: "2026-07-25T12:05:00.000Z",
      },
      turns: [
        {
          ...thread.turns[0],
          status: "COMPLETED",
          completedAt: "2026-07-25T12:05:00.000Z",
        },
      ],
    });
    render(<App initialEntries={["/threads/thread-1"]} api={api} />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Model and Effort: Fake Codex Standard · medium",
      }),
    );
    fireEvent.click(screen.getByRole("radio", { name: "high" }));
    fireEvent.change(screen.getByLabelText("Turn permission mode"), {
      target: { value: "WORKSPACE_WRITE" },
    });
    fireEvent.change(screen.getByLabelText("Message Codex"), {
      target: { value: "继续完善交付物" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送调整" }));

    await waitFor(() =>
      expect(api.startThreadTurn).toHaveBeenCalledWith("thread-1", "继续完善交付物", {
        model: "fake-codex-standard",
        reasoningEffort: "high",
        permissionMode: "WORKSPACE_WRITE",
      }),
    );
  });

  test("locks Turn configuration while a running Turn can only accept Steer input", async () => {
    render(<App initialEntries={["/threads/thread-1"]} api={createApi()} />);

    expect(
      await screen.findByRole("button", {
        name: "Model and Effort: Fake Codex Standard · medium",
      }),
    ).toBeDisabled();
    expect(screen.getByLabelText("Turn permission mode")).toBeDisabled();
    expect(screen.getByText(/Steer 沿用当前 Turn 的执行设置/)).toBeInTheDocument();
  });

  test("locks queued Turn configuration and shows an explicit non-submittable waiting state", async () => {
    const api = createApi();
    api.getThread.mockResolvedValue({
      ...thread,
      status: "QUEUED",
      currentTurn: { ...thread.currentTurn, status: "QUEUED" },
      turns: [{ ...thread.turns[0], status: "QUEUED" }],
      queue: { position: 2, etaMs: 120_000, etaEstimated: true },
    });
    render(<App initialEntries={["/threads/thread-1"]} api={api} />);

    expect(
      await screen.findByRole("button", {
        name: "Model and Effort: Fake Codex Standard · medium",
      }),
    ).toBeDisabled();
    expect(screen.getByLabelText("Turn permission mode")).toBeDisabled();
    expect(screen.getByLabelText("Message Codex")).toBeDisabled();
    expect(screen.getByText(/正在排队，暂不能提交新的 Turn/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送调整" })).toBeDisabled();
  });

  test("renders a persisted Steer user item restored from the Thread DTO", async () => {
    const api = createApi();
    api.getThread.mockResolvedValue({
      ...thread,
      items: [
        {
          id: "steer-item-1",
          threadId: "thread-1",
          turnId: "turn-1",
          sequence: 8,
          type: "USER_MESSAGE",
          timestamp: "2026-07-25T12:00:08.000Z",
          payload: {
            itemId: "steer-item-1",
            kind: "STEER",
            text: "优先核对权限边界",
          },
        },
      ],
    });
    render(<App initialEntries={["/threads/thread-1"]} api={api} />);

    const conversation = await screen.findByLabelText("Thread conversation");
    expect(within(conversation).getByText("优先核对权限边界")).toBeInTheDocument();
    expect(within(conversation).getByText("You · Steer")).toBeInTheDocument();
  });

  test("does not fabricate a Steer item locally before SSE or Thread replay confirms it", async () => {
    const api = createApi();
    render(<App initialEntries={["/threads/thread-1"]} api={api} />);

    fireEvent.change(await screen.findByLabelText("Message Codex"), {
      target: { value: "优先核对权限边界" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送调整" }));

    await waitFor(() =>
      expect(api.threadAction).toHaveBeenCalledWith("thread-1", "steer", "优先核对权限边界"),
    );
    const conversation = screen.getByLabelText("Thread conversation");
    expect(within(conversation).queryByText("优先核对权限边界")).not.toBeInTheDocument();
    expect(within(conversation).queryByText("You · Steer")).not.toBeInTheDocument();
  });

  test("fails closed and offers retry when the Subagent list endpoint is missing", async () => {
    const { listSubagents: _listSubagents, ...api } = createApi();
    render(<App initialEntries={["/threads/thread-1"]} api={api} />);

    const sidePanel = await openSidePanel();
    fireEvent.click(within(sidePanel).getByRole("tab", { name: "Subagents" }));
    expect(await within(sidePanel).findByRole("alert")).toHaveTextContent("无法读取子 Agent 列表");
    expect(within(sidePanel).getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});

describe("CodexPlatform 1.1 Thread archive", () => {
  test("archives a completed Thread, refreshes history and opens Archived settings", async () => {
    const api = createApi();
    const completedThread = {
      ...thread,
      status: "COMPLETED" as const,
      currentTurn: {
        ...thread.currentTurn,
        status: "COMPLETED" as const,
        completedAt: "2026-07-25T12:00:10.000Z",
      },
      turns: [
        {
          ...thread.turns[0],
          status: "COMPLETED" as const,
          completedAt: "2026-07-25T12:00:10.000Z",
        },
      ],
    };
    api.getThread.mockResolvedValue(completedThread);
    api.listThreads.mockResolvedValueOnce([completedThread]).mockResolvedValue([]);

    render(<App initialEntries={["/threads/thread-1"]} api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: "Archive Thread" }));

    await waitFor(() => expect(api.archiveThread).toHaveBeenCalledWith("thread-1"));
    expect(await screen.findByRole("heading", { name: "Archived" })).toBeInTheDocument();
    expect(screen.getByText(/仅整理 CodexPlatform 中的历史记录/)).toBeInTheDocument();
    await waitFor(() => expect(api.listThreads.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  test.each(["RUNNING", "QUEUED", "WAITING_APPROVAL"] as const)(
    "does not offer Archive while a Thread is %s",
    async (status) => {
      const api = createApi();
      api.getThread.mockResolvedValue({
        ...thread,
        status,
        currentTurn: {
          ...thread.currentTurn,
          status,
        },
        turns: [
          {
            ...thread.turns[0],
            status,
          },
        ],
        queue: status === "QUEUED" ? { position: 1, etaMs: 60_000, etaEstimated: true } : null,
      });

      render(<App initialEntries={["/threads/thread-1"]} api={api} />);

      await screen.findByRole("heading", { name: "梳理客户成功周报" });
      expect(screen.queryByRole("button", { name: "Archive Thread" })).not.toBeInTheDocument();
    },
  );

  test("keeps the completed Thread open and reports an Archive failure", async () => {
    const api = createApi();
    api.getThread.mockResolvedValue({
      ...thread,
      status: "FAILED",
      currentTurn: {
        ...thread.currentTurn,
        status: "FAILED",
        completedAt: "2026-07-25T12:00:10.000Z",
      },
      turns: [
        {
          ...thread.turns[0],
          status: "FAILED",
          completedAt: "2026-07-25T12:00:10.000Z",
        },
      ],
    });
    api.archiveThread.mockRejectedValue(new Error("ARCHIVE_FAILED"));

    render(<App initialEntries={["/threads/thread-1"]} api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Archive Thread" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("ARCHIVE_FAILED");
    expect(screen.getByRole("heading", { name: "梳理客户成功周报" })).toBeInTheDocument();
  });

  test("uses server archivedAt to make a direct Thread URL read-only", async () => {
    const api = createApi();
    api.getThread.mockResolvedValue({
      ...thread,
      archivedAt: "2026-07-25T12:05:00.000Z",
      status: "COMPLETED",
      currentTurn: {
        ...thread.currentTurn,
        status: "COMPLETED",
        completedAt: "2026-07-25T12:00:10.000Z",
      },
      turns: [
        {
          ...thread.turns[0],
          status: "COMPLETED",
          completedAt: "2026-07-25T12:00:10.000Z",
        },
      ],
    });

    render(<App initialEntries={["/threads/thread-1"]} api={api} />);

    expect(await screen.findByRole("heading", { name: "梳理客户成功周报" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "继续" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Message Codex")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Archive Thread" })).not.toBeInTheDocument();
    expect(screen.getByText(/服务端标记为平台归档/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "返回 Archived" })).not.toBeInTheDocument();
  });
});

describe("CodexPlatform 1.1 personal settings", () => {
  test("contains only the approved personal sections and uses the Runtime model catalog", async () => {
    render(<App initialEntries={["/settings/execution"]} api={createApi()} />);

    expect(await screen.findByRole("heading", { name: "Execution" })).toBeInTheDocument();
    const navigation = screen.getByRole("navigation", { name: "Settings sections" });
    for (const label of [
      "General",
      "Profile",
      "Execution",
      "Personalization",
      "Connections",
      "Plugins",
      "Usage",
      "Archived",
    ]) {
      expect(within(navigation).getByRole("link", { name: label })).toBeInTheDocument();
    }
    expect(within(navigation).getAllByRole("link")).toHaveLength(8);
    expect(
      await screen.findByRole("button", {
        name: "Model and Effort: Fake Codex Standard · medium",
      }),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/config\.toml|CODEX_HOME|password|cookie|token/i);
  });

  test("saves personal execution settings through the current Feishu user API", async () => {
    const api = createApi();
    render(<App initialEntries={["/settings/execution"]} api={api} />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Model and Effort: Fake Codex Standard · medium",
      }),
    );
    fireEvent.click(screen.getByRole("option", { name: /Fake Codex Deep/ }));
    fireEvent.click(screen.getByRole("radio", { name: "xhigh" }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() =>
      expect(api.patchMySettings).toHaveBeenCalledWith({
        execution: expect.objectContaining({
          model: "fake-codex-deep",
          reasoningEffort: "xhigh",
        }),
      }),
    );
  });

  test("shows a save failure instead of silently discarding personal settings", async () => {
    const api = createApi();
    api.patchMySettings.mockRejectedValue(new Error("SETTINGS_POLICY_REJECTED"));
    render(<App initialEntries={["/settings/execution"]} api={api} />);

    await screen.findByRole("button", {
      name: "Model and Effort: Fake Codex Standard · medium",
    });
    fireEvent.click(await screen.findByRole("button", { name: "Save settings" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("SETTINGS_POLICY_REJECTED");
  });

  test("fails closed when personal settings cannot be read", async () => {
    const api = createApi();
    api.getMySettings.mockRejectedValue(new Error("SETTINGS_READ_FAILED"));
    render(<App initialEntries={["/settings/execution"]} api={api} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("无法读取个人设置");
    expect(screen.queryByRole("button", { name: "Save settings" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  test("fails closed when the personal settings API methods are not installed", async () => {
    const {
      getMySettings: _getMySettings,
      patchMySettings: _patchMySettings,
      ...api
    } = createApi();
    render(<App initialEntries={["/settings/execution"]} api={api} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("无法读取个人设置");
    expect(screen.queryByRole("button", { name: "Save settings" })).not.toBeInTheDocument();
  });

  test("lists archived Threads as platform organization records with view and Unarchive actions", async () => {
    const api = createApi();
    api.listArchivedThreads.mockResolvedValue([
      {
        ...thread,
        id: "archived-thread",
        title: "已归档客户周报",
        status: "COMPLETED",
        archivedAt: "2026-07-25T12:05:00.000Z",
      },
    ]);

    render(<App initialEntries={["/settings/archived"]} api={api} />);

    expect(await screen.findByText("已归档客户周报")).toBeInTheDocument();
    expect(screen.getByText(/仅整理 CodexPlatform 中的历史记录/)).toBeInTheDocument();
    expect(screen.getByText(/不会改变 Codex App Server Thread/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看 已归档客户周报" })).toHaveAttribute(
      "href",
      "/threads/archived-thread?archived=1",
    );
    expect(screen.getByRole("button", { name: "Unarchive 已归档客户周报" })).toBeInTheDocument();
  });

  test("Unarchives a Thread, invalidates lists and returns to the Thread", async () => {
    const api = createApi();
    api.listArchivedThreads.mockResolvedValue([
      {
        ...thread,
        id: "archived-thread",
        title: "已归档客户周报",
        status: "COMPLETED",
        archivedAt: "2026-07-25T12:05:00.000Z",
      },
    ]);
    api.getThread.mockResolvedValue({
      ...thread,
      id: "archived-thread",
      title: "已归档客户周报",
      status: "COMPLETED",
    });

    render(<App initialEntries={["/settings/archived"]} api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: "Unarchive 已归档客户周报" }));

    await waitFor(() => expect(api.unarchiveThread).toHaveBeenCalledWith("archived-thread"));
    expect(await screen.findByRole("heading", { name: "已归档客户周报" })).toBeInTheDocument();
    await waitFor(() => expect(api.listThreads.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(api.listArchivedThreads.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test("fails closed when the archived Thread list cannot be read", async () => {
    const api = createApi();
    api.listArchivedThreads.mockRejectedValue(new Error("ARCHIVE_READ_FAILED"));

    render(<App initialEntries={["/settings/archived"]} api={api} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("无法读取归档 Thread");
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Unarchive/ })).not.toBeInTheDocument();
  });

  test("shows a real loading state while archived Threads are unresolved", async () => {
    const api = createApi();
    api.listArchivedThreads.mockReturnValue(new Promise(() => undefined));

    render(<App initialEntries={["/settings/archived"]} api={api} />);

    expect(await screen.findByText("Loading archived Threads")).toBeInTheDocument();
    expect(screen.queryByText("No archived chats")).not.toBeInTheDocument();
  });

  test("shows an explicit empty state when the user has no archived Threads", async () => {
    render(<App initialEntries={["/settings/archived"]} api={createApi()} />);

    expect(await screen.findByText("No archived chats")).toBeInTheDocument();
    expect(screen.getByText("Archived Threads will appear here.")).toBeInTheDocument();
  });

  test("keeps an archived Thread visible when Unarchive fails", async () => {
    const api = createApi();
    api.listArchivedThreads.mockResolvedValue([
      {
        ...thread,
        id: "archived-thread",
        title: "已归档客户周报",
        status: "FAILED",
        archivedAt: "2026-07-25T12:05:00.000Z",
      },
    ]);
    api.unarchiveThread.mockRejectedValue(new Error("UNARCHIVE_FAILED"));

    render(<App initialEntries={["/settings/archived"]} api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Unarchive 已归档客户周报" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("UNARCHIVE_FAILED");
    expect(screen.getByText("已归档客户周报")).toBeInTheDocument();
  });

  test("stores the personal default project in General settings", async () => {
    const api = createApi();
    render(<App initialEntries={["/settings/general"]} api={api} />);

    fireEvent.change(await screen.findByLabelText("Default project"), {
      target: { value: "project-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() =>
      expect(api.patchMySettings).toHaveBeenCalledWith({
        general: expect.objectContaining({ defaultProjectId: "project-1" }),
      }),
    );
  });

  test("does not present pending personal usage as factual zero metrics", async () => {
    const api = createApi();
    api.getMyUsage.mockImplementation(() => new Promise(() => undefined));
    render(<App initialEntries={["/settings/usage"]} api={api} />);

    const loading = await screen.findByText("Loading usage");
    expect(loading.closest('[role="status"]')).toBeInTheDocument();
    expect(screen.queryByText("Threads")).not.toBeInTheDocument();
    expect(screen.queryByText("Turns")).not.toBeInTheDocument();
  });

  test("does not expose cached usage while a forced remount refresh is pending", async () => {
    const api = createApi();
    api.getMyUsage
      .mockResolvedValueOnce({
        threads: 7,
        turns: 8,
        toolCalls: 9,
        subagents: 10,
        tokenUsage: null,
        tokenUsageStatus: "UNKNOWN",
        quota: { scope: "SHARED_CODEX_ACCOUNT", attributableToUser: false },
      })
      .mockImplementationOnce(() => new Promise(() => undefined));
    render(<App initialEntries={["/settings/usage"]} api={api} />);

    const usageCard = (await screen.findByRole("heading", { name: "Personal activity" })).closest(
      "section",
    );
    expect(usageCard).not.toBeNull();
    expect(await within(usageCard as HTMLElement).findByText("7")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "General" }));
    await screen.findByRole("heading", { name: "General preferences" });
    fireEvent.click(screen.getByRole("link", { name: "Usage" }));

    expect(await screen.findByText("Loading usage")).toBeInTheDocument();
    expect(screen.queryByText("7")).not.toBeInTheDocument();
  });

  test("fails closed when personal usage and connection capabilities are missing", async () => {
    const { getMyUsage: _getMyUsage, listMyConnections: _listMyConnections, ...api } = createApi();
    const usageView = render(<App initialEntries={["/settings/usage"]} api={api} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("无法读取个人使用数据");
    usageView.unmount();
    render(<App initialEntries={["/settings/connections"]} api={api} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("无法读取组织连接状态");
  });

  test("shows a retryable personal usage error and recovers with fresh data", async () => {
    const api = createApi();
    api.getMyUsage.mockRejectedValueOnce(new Error("USAGE_READ_FAILED"));
    render(<App initialEntries={["/settings/usage"]} api={api} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("无法读取个人使用数据");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByText("Threads")).toBeInTheDocument();
    expect(screen.getByText("Turns")).toBeInTheDocument();
    expect(api.getMyUsage).toHaveBeenCalledTimes(2);
  });

  test("shows an explicit empty state for organization connections", async () => {
    const api = createApi();
    api.listMyConnections.mockResolvedValue([]);
    render(<App initialEntries={["/settings/connections"]} api={api} />);

    expect(await screen.findByText(/暂无可用的组织连接/)).toBeInTheDocument();
  });

  test("shows a retryable organization connection error", async () => {
    const api = createApi();
    api.listMyConnections.mockRejectedValueOnce(new Error("CONNECTIONS_READ_FAILED"));
    render(<App initialEntries={["/settings/connections"]} api={api} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("无法读取组织连接状态");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(api.listMyConnections).toHaveBeenCalledTimes(2);
  });
});

describe("CodexPlatform 1.1 account administration", () => {
  test("separates weekly quota from authentication state without presenting static health as usage", async () => {
    const api = createApi();
    api.listAccounts.mockResolvedValue([
      {
        id: "account-1",
        alias: "Codex 01",
        status: "AVAILABLE",
        authStatus: "AUTHENTICATED",
        activeUsers: 2,
        maxUsers: 4,
        weeklyRemainingPercent: 73,
        quotaUpdatedAt: "2026-07-21T12:00:00.000Z",
        quotaResetsAt: "2026-07-28T12:00:00.000Z",
        health: 100,
      },
    ]);

    render(<App initialEntries={["/admin/accounts"]} api={api} />);

    expect(await screen.findByText("本周已用 27%")).toBeInTheDocument();
    expect(screen.getByText("剩余 73%")).toBeInTheDocument();
    expect(screen.getByText("已认证")).toBeInTheDocument();
    expect(screen.getByText(/额度更新/)).toBeInTheDocument();
    expect(screen.getByText(/下次重置/)).toBeInTheDocument();
    expect(screen.queryByText("健康度")).not.toBeInTheDocument();
    expect(screen.queryByText("100%")).not.toBeInTheDocument();
  });

  test("lets an administrator explicitly refresh the account quota", async () => {
    const api = createApi();
    render(<App initialEntries={["/admin/accounts"]} api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: "刷新额度" }));

    await waitFor(() =>
      expect(api.accountAction).toHaveBeenCalledWith("account-1", "refresh-quota"),
    );
  });

  test("keeps account login, drain and quarantine controls in the admin console", async () => {
    const api = createApi();
    render(<App initialEntries={["/admin/accounts"]} api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: "重新认证" }));
    await waitFor(() => expect(api.accountAction).toHaveBeenCalledWith("account-1", "login"));

    fireEvent.click(screen.getByRole("button", { name: "排空" }));
    await waitFor(() => expect(api.accountAction).toHaveBeenCalledWith("account-1", "drain"));

    fireEvent.click(screen.getByRole("button", { name: "隔离" }));
    await waitFor(() => expect(api.accountAction).toHaveBeenCalledWith("account-1", "quarantine"));
  });

  test("offers restore for an isolated account", async () => {
    const api = createApi();
    api.listAccounts.mockResolvedValue([
      {
        id: "account-1",
        alias: "Codex 01",
        status: "QUARANTINED",
        activeUsers: 0,
        maxUsers: 4,
        weeklyRemainingPercent: 73,
        health: 98,
      },
    ]);
    render(<App initialEntries={["/admin/accounts"]} api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: "恢复" }));
    await waitFor(() => expect(api.accountAction).toHaveBeenCalledWith("account-1", "restore"));
  });

  test("shows a traceable audit actor and safe Platform Thread reference", async () => {
    const api = createApi();
    api.listAudit.mockResolvedValue([
      {
        id: "audit-1",
        timestamp: "2026-07-25T12:00:00.000Z",
        actorName: "林可",
        action: "LEASE_ACQUIRED",
        resource: "Codex account lease acquired",
        result: "SUCCESS",
        accountAlias: "Codex 01",
        taskId: "thread-1",
      },
    ]);
    render(<App initialEntries={["/admin/audit"]} api={api} />);

    expect(await screen.findByText("林可")).toBeInTheDocument();
    expect(screen.getByText("Thread thread-1")).toBeInTheDocument();
    expect(screen.getByText("Codex 01")).toBeInTheDocument();
  });

  test("opens a member-owned audit Thread in a read-only administrator view", async () => {
    const api = createApi();
    api.listAudit.mockResolvedValue([
      {
        id: "audit-1",
        timestamp: "2026-07-25T12:00:00.000Z",
        actorName: "周宁",
        action: "LEASE_ACQUIRED",
        resource: "Codex account lease acquired",
        result: "SUCCESS",
        accountAlias: "Codex 01",
        taskId: "member-thread",
      },
    ]);
    render(<App initialEntries={["/admin/audit"]} api={api} />);

    fireEvent.click(await screen.findByRole("link", { name: "Thread member-thread" }));

    expect(await screen.findByRole("heading", { name: "成员的审计 Thread" })).toBeInTheDocument();
    expect(api.getAdminThread).toHaveBeenCalledWith("member-thread");
    expect(screen.getByText("只读审计视图")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Message Codex")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "停止" })).not.toBeInTheDocument();
  });

  test("shows a retryable audit loading error instead of an empty list", async () => {
    const api = createApi();
    api.listAudit.mockRejectedValueOnce(new Error("AUDIT_READ_FAILED"));
    render(<App initialEntries={["/admin/audit"]} api={api} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("无法读取审计记录");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    await waitFor(() => expect(api.listAudit).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/暂无审计记录/)).toBeInTheDocument();
  });
});
