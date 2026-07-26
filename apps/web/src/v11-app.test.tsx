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

const thread = {
  ...task,
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

    render(
      <App
        initialEntries={["/tasks/thread-1"]}
        api={createApi()}
        subscribeToTaskEvents={subscribe}
      />,
    );

    expect(await screen.findByRole("heading", { name: "梳理客户成功周报" })).toBeInTheDocument();
    expect(screen.getByText("读取飞书知识库并形成摘要")).toBeInTheDocument();
    expect(screen.getByText("已完成知识库检索。")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Plan" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Outputs" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Subagents" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Sources" })).toBeInTheDocument();
    expect(screen.getByText("Runtime default")).toBeInTheDocument();
    expect(screen.getByText(/Model catalog not connected/)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("SECRET SHARED ACCOUNT");
    expect(document.body).not.toHaveTextContent("RAW_CHAIN_OF_THOUGHT");
    expect(screen.queryByRole("button", { name: /attach/i })).not.toBeInTheDocument();
  });

  test("shows Active and Done subagents and opens independent subagent detail", async () => {
    const api = createApi();
    render(<App initialEntries={["/threads/thread-1"]} api={api} />);

    fireEvent.click(await screen.findByRole("tab", { name: "Subagents" }));
    const panel = screen.getByRole("tabpanel", { name: "Subagents" });
    expect(within(panel).getByRole("heading", { name: "Active" })).toBeInTheDocument();
    expect(within(panel).getByRole("heading", { name: "Done" })).toBeInTheDocument();
    expect(within(panel).getByText("文档检索")).toBeInTheDocument();
    expect(within(panel).getByText("摘要整理")).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: "Open 摘要整理 details" }));
    expect(await screen.findByRole("heading", { name: "摘要整理" })).toBeInTheDocument();
    expect(await screen.findByText("子任务详情正文")).toBeInTheDocument();
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

    fireEvent.click(await screen.findByRole("tab", { name: "Subagents" }));
    const done = screen.getByRole("heading", { name: "Done" }).closest("section");

    expect(done).not.toBeNull();
    expect(within(done as HTMLElement).getByText("文档检索")).toBeInTheDocument();
    expect(within(done as HTMLElement).getByText("飞书知识库检索完成")).toBeInTheDocument();
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
          id: "agent-tool",
          threadId: "agent-done",
          turnId: "agent-turn",
          sequence: 2,
          type: "TOOL_STARTED",
          timestamp: "2026-07-25T12:00:02.000Z",
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
          sequence: 3,
          type: "DIFF_UPDATED",
          timestamp: "2026-07-25T12:00:03.000Z",
          payload: { diff: "+++ b/report.md\n+summary" },
        },
        {
          id: "agent-approval",
          threadId: "agent-done",
          turnId: "agent-turn",
          sequence: 4,
          type: "APPROVAL_REQUESTED",
          timestamp: "2026-07-25T12:00:04.000Z",
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

    fireEvent.click(await screen.findByRole("tab", { name: "Subagents" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open 摘要整理 details" }));

    expect(await screen.findByRole("heading", { name: "运行命令" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "调用企业工具" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "文件变更" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "等待审批" })).toBeInTheDocument();
    expect(screen.getByText("来自子 Agent")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "允许一次" })).toBeDisabled();
  });

  test("shows a recoverable Subagent-detail error instead of an endless loading state", async () => {
    const api = createApi();
    api.getSubagent.mockRejectedValue(new Error("SUBAGENT_DETAIL_UNAVAILABLE"));
    render(<App initialEntries={["/threads/thread-1"]} api={api} />);

    fireEvent.click(await screen.findByRole("tab", { name: "Subagents" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open 摘要整理 details" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("无法读取子 Agent 详情");
    expect(screen.queryByText("Loading subagent")).not.toBeInTheDocument();
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

  test("passes only policy-allowed Turn configuration and gives an explicit project priority", async () => {
    const api = createApi();
    const settings = await api.getMySettings();
    api.getMySettings.mockResolvedValue({
      ...settings,
      general: { ...settings.general, defaultProjectId: "default-project" },
    });
    render(<App initialEntries={["/threads/new?project=project-1"]} api={api} />);

    const effort = await screen.findByLabelText("Turn reasoning effort");
    const permission = screen.getByLabelText("Turn permission mode");
    await within(effort).findByRole("option", { name: "HIGH" });
    expect(within(effort).queryByRole("option", { name: "ULTRA" })).not.toBeInTheDocument();
    expect(
      within(permission).queryByRole("option", { name: "FULL_ACCESS" }),
    ).not.toBeInTheDocument();
    fireEvent.change(effort, { target: { value: "HIGH" } });
    fireEvent.change(permission, { target: { value: "READ_ONLY" } });
    fireEvent.change(screen.getByLabelText("Message Codex"), {
      target: { value: "整理知识库" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(api.createThread).toHaveBeenCalledWith({
        projectId: "project-1",
        title: "整理知识库",
        config: { reasoningEffort: "HIGH", permissionMode: "READ_ONLY" },
      }),
    );
    expect(api.startThreadTurn).toHaveBeenCalledWith("thread-created", "整理知识库", {
      reasoningEffort: "HIGH",
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

  test("disables Continue while a resume request is pending", async () => {
    const api = createApi();
    api.getThread.mockResolvedValue({ ...thread, status: "COMPLETED" });
    api.startThreadTurn.mockImplementation(() => new Promise(() => undefined));
    render(<App initialEntries={["/threads/thread-1"]} api={api} />);

    const resume = await screen.findByRole("button", { name: "继续" });
    fireEvent.click(resume);

    await waitFor(() => expect(resume).toBeDisabled());
  });

  test("passes the selected Turn configuration to a continuous follow-up", async () => {
    const api = createApi();
    api.getThread.mockResolvedValue({ ...thread, status: "COMPLETED" });
    render(<App initialEntries={["/threads/thread-1"]} api={api} />);

    fireEvent.change(await screen.findByLabelText("Turn reasoning effort"), {
      target: { value: "HIGH" },
    });
    fireEvent.change(screen.getByLabelText("Turn permission mode"), {
      target: { value: "WORKSPACE_WRITE" },
    });
    fireEvent.change(screen.getByLabelText("Message Codex"), {
      target: { value: "继续完善交付物" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送调整" }));

    await waitFor(() =>
      expect(api.startThreadTurn).toHaveBeenCalledWith("thread-1", "继续完善交付物", {
        reasoningEffort: "HIGH",
        permissionMode: "WORKSPACE_WRITE",
      }),
    );
  });

  test("locks Turn configuration while a running Turn can only accept Steer input", async () => {
    render(<App initialEntries={["/threads/thread-1"]} api={createApi()} />);

    expect(await screen.findByLabelText("Turn reasoning effort")).toBeDisabled();
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

    expect(await screen.findByLabelText("Turn reasoning effort")).toBeDisabled();
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

    fireEvent.click(await screen.findByRole("tab", { name: "Subagents" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("无法读取子 Agent 列表");
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});

describe("CodexPlatform 1.1 personal settings", () => {
  test("contains only the approved personal sections and reports unavailable catalogs honestly", async () => {
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
    expect(await screen.findByText("Runtime default")).toBeInTheDocument();
    expect(await screen.findByText(/Model catalog not connected in 1.1A/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/config\.toml|CODEX_HOME|password|cookie|token/i);
  });

  test("saves personal execution settings through the current Feishu user API", async () => {
    const api = createApi();
    render(<App initialEntries={["/settings/execution"]} api={api} />);

    const effort = await screen.findByLabelText("Reasoning effort");
    fireEvent.change(effort, { target: { value: "HIGH" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() =>
      expect(api.patchMySettings).toHaveBeenCalledWith({
        execution: expect.objectContaining({ reasoningEffort: "HIGH" }),
      }),
    );
  });

  test("shows a save failure instead of silently discarding personal settings", async () => {
    const api = createApi();
    api.patchMySettings.mockRejectedValue(new Error("SETTINGS_POLICY_REJECTED"));
    render(<App initialEntries={["/settings/execution"]} api={api} />);

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
