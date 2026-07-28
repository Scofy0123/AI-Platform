import type {
  ComposerCapability,
  ExecutionPermissionSelection,
  TaskEvent,
  Turn,
} from "@codexplatform/contracts";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  type CSSProperties,
  createContext,
  type FormEvent,
  type ReactNode,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  BrowserRouter,
  Link,
  MemoryRouter,
  Navigate,
  NavLink,
  Route,
  Routes,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { ApiError, httpApi } from "./api.js";
import { ThreadNavItem } from "./components/navigation/ThreadNavItem.js";
import { BottomPanel } from "./components/thread/BottomPanel.js";
import { ComposerAddMenu } from "./components/thread/ComposerAddMenu.js";
import { ComposerSubmitControl } from "./components/thread/ComposerSubmitControl.js";
import {
  ModelEffortPicker,
  type ModelSelection,
  resolveCatalogSelection,
} from "./components/thread/ModelEffortPicker.js";
import {
  type ExecutionPermissionOption,
  PermissionModePicker,
} from "./components/thread/PermissionModePicker.js";
import { PinnedExecutionSummary } from "./components/thread/PinnedExecutionSummary.js";
import { SidePanel } from "./components/thread/SidePanel.js";
import { Transcript } from "./components/thread/Transcript.js";
import { WorkspaceHeader } from "./components/thread/WorkspaceHeader.js";
import { subscribeTaskEvents } from "./event-stream.js";
import { Icon } from "./icons.js";
import {
  coalesceThreadEvents,
  isSafeConversationEvent,
  mergeThreadEvents,
  projectToolDetails,
  threadItemToEvent,
} from "./thread-events.js";
import {
  projectThreadPresentation,
  type TerminalDetail,
  type ThreadPresentation,
  type TranscriptApprovalRow,
} from "./thread-presentation.js";
import type {
  AccountSummary,
  PlatformApi,
  Session,
  SubagentThread,
  TaskEventSubscriber,
  TaskStatus,
  Thread,
  UserSettingsPatch,
  UserSettingsView,
} from "./types.js";
import {
  type BottomPanelTab,
  createWorkspaceLayoutState,
  reduceWorkspaceLayout,
  type SidePanelTab,
} from "./workspace-layout.js";

interface AppProps {
  api?: PlatformApi;
  initialEntries?: string[];
  subscribeToTaskEvents?: TaskEventSubscriber;
}

const ApiContext = createContext<PlatformApi>(httpApi);
const EventSubscriberContext = createContext<TaskEventSubscriber>(subscribeTaskEvents);

export function App({
  api = httpApi,
  initialEntries,
  subscribeToTaskEvents = subscribeTaskEvents,
}: AppProps) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, staleTime: 5_000 },
          mutations: { retry: false },
        },
      }),
  );
  const content = (
    <QueryClientProvider client={queryClient}>
      <ApiContext.Provider value={api}>
        <EventSubscriberContext.Provider value={subscribeToTaskEvents}>
          <ApplicationRoutes />
        </EventSubscriberContext.Provider>
      </ApiContext.Provider>
    </QueryClientProvider>
  );
  return initialEntries ? (
    <MemoryRouter initialEntries={initialEntries}>{content}</MemoryRouter>
  ) : (
    <BrowserRouter>{content}</BrowserRouter>
  );
}

function ApplicationRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/*" element={<SessionGate />} />
    </Routes>
  );
}

function SessionGate() {
  const api = useApi();
  const session = useQuery({ queryKey: ["session"], queryFn: api.getSession });
  const bootstrap = useQuery({
    queryKey: ["bootstrap"],
    queryFn: () => {
      if (!api.getBootstrap) throw new Error("Bootstrap endpoint unavailable");
      return api.getBootstrap();
    },
    enabled: session.isSuccess && session.data.authenticated,
  });
  if (session.isPending) return <FullPageState label="正在连接工作台" />;
  if (session.isError || !session.data.authenticated) return <Navigate to="/login" replace />;
  if (bootstrap.isPending) return <FullPageState label="正在确认工作区能力" />;
  if (
    bootstrap.isError ||
    bootstrap.data.enabledModes.length !== 1 ||
    bootstrap.data.enabledModes[0] !== "CODEX" ||
    !bootstrap.data.capabilities.threads ||
    !bootstrap.data.capabilities.settings ||
    !bootstrap.data.capabilities.subagents ||
    !bootstrap.data.capabilities.reasoningSummaries
  ) {
    return <PageError title="CODEX 工作区能力不可用" />;
  }
  return <Workspace session={session.data} />;
}

function Workspace({ session }: { session: Session }) {
  return (
    <Routes>
      <Route path="/admin/*" element={<AdminWorkspace session={session} />} />
      <Route path="/*" element={<UserWorkspace session={session} />} />
    </Routes>
  );
}

function UserWorkspace({ session }: { session: Session }) {
  return (
    <div className="v11-user-shell">
      <UserSidebar session={session} />
      <main className="v11-user-main">
        <Routes>
          <Route path="/" element={<Navigate to="/threads/new" replace />} />
          <Route path="/threads/new" element={<NewThreadPage />} />
          <Route path="/threads" element={<ThreadIndexPage />} />
          <Route path="/threads/:threadId" element={<ThreadPage />} />
          <Route path="/tasks/new" element={<Navigate to="/threads/new" replace />} />
          <Route path="/tasks/:taskId" element={<LegacyTaskRedirect />} />
          <Route path="/tasks" element={<Navigate to="/threads" replace />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/settings" element={<Navigate to="/settings/general" replace />} />
          <Route path="/settings/:section" element={<SettingsPage session={session} />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
    </div>
  );
}

function AdminWorkspace({ session }: { session: Session }) {
  if (session.user.role !== "ADMIN") return <PageError title="无权访问管理功能" />;
  return (
    <div className="v11-admin-shell">
      <aside className="v11-admin-sidebar">
        <Link className="v11-back-link" to="/" aria-label="Back to Codex">
          <Icon name="arrow" /> Back to Codex
        </Link>
        <div className="v11-admin-title">
          <span className="brand-mark">
            <Icon name="shield" />
          </span>
          <div>
            <strong>管理后台</strong>
            <span>CodexPlatform</span>
          </div>
        </div>
        <nav aria-label="管理后台导航">
          <NavLink to="/admin/accounts">
            <Icon name="bot" /> 账号池
          </NavLink>
          <NavLink to="/admin/audit">
            <Icon name="audit" /> 审计记录
          </NavLink>
          <NavLink to="/admin/policies">
            <Icon name="shield" /> Policies
          </NavLink>
          <NavLink to="/admin/connectors">
            <Icon name="tool" /> Connectors
          </NavLink>
          <NavLink to="/admin/usage">
            <Icon name="activity" /> Usage
          </NavLink>
          <NavLink to="/admin/runtime-health">
            <Icon name="terminal" /> Runtime health
          </NavLink>
        </nav>
      </aside>
      <main className="v11-admin-main">
        <Routes>
          <Route path="/" element={<Navigate to="/admin/accounts" replace />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/threads/:threadId" element={<AdminThreadPage />} />
          <Route path="/policies" element={<AdminPoliciesPage />} />
          <Route path="/connectors" element={<AdminConnectorsPage />} />
          <Route path="/usage" element={<AdminUsagePage />} />
          <Route path="/runtime-health" element={<RuntimeHealthPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
    </div>
  );
}

function LoginPage() {
  return (
    <main className="login-page">
      <section className="login-copy">
        <Brand />
        <div className="eyebrow">
          <span className="live-dot" /> 企业 AI 统一入口
        </div>
        <h1>让 AI 工作可见、可控、可追溯</h1>
        <p className="login-lead">
          使用飞书身份进入个人 Codex 工作区，企业工具继续按你的组织权限执行。
        </p>
      </section>
      <section className="login-card" aria-label="登录工作台">
        <div className="login-card-mark">
          <Icon name="spark" />
        </div>
        <p className="overline">WELCOME TO</p>
        <h2>CodexPlatform</h2>
        <p>使用组织飞书身份进入，无需创建额外账号。</p>
        <a
          className="button button-primary button-large"
          href="/api/auth/feishu/start"
          aria-label="使用飞书登录"
        >
          <span className="feishu-mark">飞</span>
          使用飞书登录
          <Icon name="arrow" />
        </a>
      </section>
    </main>
  );
}

function Brand() {
  return (
    <Link className="brand" to="/" aria-label="CodexPlatform 首页">
      <span className="brand-mark">
        <Icon name="spark" />
      </span>
      <span>CodexPlatform</span>
    </Link>
  );
}

function UserSidebar({ session }: { session: Session }) {
  const api = useApi();
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.listProjects });
  const threads = useQuery({
    queryKey: ["threads"],
    queryFn: () => (api.listThreads ? api.listThreads() : api.listTasks()),
  });
  return (
    <aside className="v11-user-sidebar">
      <Brand />
      <nav aria-label="Codex workspace" className="v11-workspace-nav">
        <Link className="v11-new-chat" to="/threads/new" aria-label="New chat">
          <Icon name="plus" /> New chat
        </Link>
        <section aria-labelledby="projects-label">
          <h2 id="projects-label">Projects</h2>
          <Link to="/projects">
            <Icon name="project" /> All projects
          </Link>
          {projects.data?.slice(0, 5).map((project) => (
            <Link to={`/projects?selected=${project.id}`} key={project.id}>
              <span className="v11-nav-dot" /> {project.name}
            </Link>
          ))}
        </section>
        <section aria-labelledby="history-label">
          <h2 id="history-label">History</h2>
          {threads.data?.slice(0, 8).map((thread) => (
            <ThreadNavItem
              id={thread.id}
              title={thread.title}
              status={thread.status}
              key={thread.id}
            />
          ))}
        </section>
        <Link to="/settings/archived">
          <Icon name="audit" /> Archived
        </Link>
      </nav>
      <div className="v11-user-sidebar-footer">
        <Link to="/settings/general" aria-label="Settings">
          <Icon name="settings" /> Settings
        </Link>
        {session.user.role === "ADMIN" ? (
          <Link to="/admin/accounts" aria-label="Open admin console">
            <Icon name="shield" /> Admin console
          </Link>
        ) : null}
        <div className="identity-card">
          <Avatar name={session.user.name} />
          <div>
            <strong>{session.user.name}</strong>
            <span>飞书用户</span>
          </div>
        </div>
      </div>
    </aside>
  );
}

function NewThreadPage() {
  const api = useApi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const routeProjectId = searchParams.get("project") ?? "";
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.listProjects });
  const settings = useQuery({
    queryKey: ["my-settings"],
    queryFn: () => {
      if (!api.getMySettings) throw new Error("Settings endpoint unavailable");
      return api.getMySettings();
    },
  });
  const models = useQuery({
    queryKey: ["models", "new-thread"],
    queryFn: () => {
      if (!api.listModels) throw new Error("Model catalog endpoint unavailable");
      return api.listModels();
    },
  });
  const capabilities = useQuery({
    queryKey: ["composer-capabilities", "new-thread"],
    queryFn: () => api.listComposerCapabilities?.() ?? Promise.resolve([]),
    enabled: Boolean(api.listComposerCapabilities),
  });
  const [prompt, setPrompt] = useState("");
  const [projectId, setProjectId] = useState(routeProjectId);
  const [modelSelection, setModelSelection] = useState<ModelSelection | null>(null);
  const [permission, setPermission] = useState<ExecutionPermissionSelection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectedModel = resolveCatalogSelection(
    models.data,
    modelSelection?.model ?? settings.data?.execution.model,
    modelSelection?.reasoningEffort ?? settings.data?.execution.reasoningEffort,
  );
  const selectedPermission =
    permission ?? permissionSelectionFromLegacy(settings.data?.execution.permissionMode);
  const turnConfig = selectedModel
    ? {
        model: selectedModel.model,
        reasoningEffort: selectedModel.reasoningEffort,
        permissionMode: permissionModeForTurn(selectedPermission),
      }
    : null;
  const create = useMutation({
    mutationFn: async () => {
      if (!turnConfig) throw new Error("Runtime 模型目录不可用");
      const targetProjectId =
        projectId ||
        routeProjectId ||
        settings.data?.general.defaultProjectId ||
        projects.data?.[0]?.id ||
        (await api.createProject("默认项目")).id;
      const title = deriveThreadTitle(prompt);
      const created = api.createThread
        ? await api.createThread({ projectId: targetProjectId, title, config: turnConfig })
        : await api.createTask({ projectId: targetProjectId, title });
      if (api.startThreadTurn) {
        await api.startThreadTurn(created.id, prompt.trim(), turnConfig);
      } else await api.startTurn(created.id, prompt.trim());
      return created.id;
    },
    onSuccess: async (id) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
        queryClient.invalidateQueries({ queryKey: ["threads"] }),
        queryClient.invalidateQueries({ queryKey: ["tasks"] }),
      ]);
      navigate(`/threads/${id}`);
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : "无法创建任务"),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!prompt.trim()) {
      setError("请描述要完成的工作");
      return;
    }
    setError(null);
    create.mutate();
  };
  return (
    <section className="v11-new-thread">
      <div className="v11-new-thread-copy">
        <span className="brand-mark">
          <Icon name="spark" />
        </span>
        <h1>What do you want to build?</h1>
        <p>描述目标，Codex 会规划、调用企业工具并持续展示执行过程。</p>
      </div>
      <form className="v11-composer v11-composer-large" onSubmit={submit}>
        <label className="sr-only" htmlFor="new-thread-prompt">
          Message Codex
        </label>
        <textarea
          id="new-thread-prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={5}
          placeholder="Message Codex"
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="v11-composer-toolbar">
          <ComposerAddMenu
            capabilities={capabilities.data ?? EMPTY_COMPOSER_CAPABILITIES}
            onSelect={(capability) => applyComposerCapability(capability, setPrompt)}
            disabled={create.isPending}
          />
          <PermissionModePicker
            value={selectedPermission}
            options={permissionOptions(settings.data?.policy.allowedPermissionModes)}
            onChange={setPermission}
            disabled={create.isPending || settings.isPending || settings.isError}
          />
          <select
            aria-label="Project"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="">Default project</option>
            {projects.data?.map((project) => (
              <option value={project.id} key={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <ModelEffortPicker
            catalog={models.data ?? null}
            value={selectedModel}
            onChange={setModelSelection}
            loading={models.isPending}
            error={models.isError}
            disabled={create.isPending}
          />
          <button
            type="submit"
            className="v11-send-button"
            aria-label="Send message"
            disabled={
              create.isPending ||
              settings.isPending ||
              settings.isError ||
              models.isPending ||
              models.isError ||
              !selectedModel
            }
          >
            <Icon name="send" />
          </button>
        </div>
        {settings.isError ? <p role="alert">无法读取个人执行配置，请刷新后重试。</p> : null}
        {error ? <p role="alert">{error}</p> : null}
      </form>
    </section>
  );
}

function LegacyTaskRedirect() {
  const { taskId = "" } = useParams();
  return <Navigate to={`/threads/${taskId}`} replace />;
}

interface ThreadView {
  id: string;
  projectId: string;
  title: string;
  status: TaskStatus;
  updatedAt: string;
  archivedAt: string | null;
  prompt: string | null;
  currentTurnId: string | null;
  currentTurnStatus: string | null;
  lastModel: string | null;
  lastReasoningEffort: string | null;
  turns: Turn[];
  queue: Thread["queue"];
  events: TaskEvent[];
}

async function loadThread(api: PlatformApi, threadId: string): Promise<ThreadView> {
  if (api.getThread) {
    return projectThreadView(await api.getThread(threadId));
  }
  const task = await api.getTask(threadId);
  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    status: task.status,
    updatedAt: task.updatedAt,
    archivedAt: null,
    prompt: task.prompt,
    currentTurnId: null,
    currentTurnStatus: null,
    lastModel: null,
    lastReasoningEffort: null,
    turns: [],
    queue: task.queue,
    events: task.events ?? [],
  };
}

function projectThreadView(thread: Thread): ThreadView {
  const latestTurn = thread.currentTurn ?? thread.turns.at(-1) ?? null;
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    status: thread.status,
    updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt,
    prompt: thread.currentTurn?.prompt ?? thread.turns.at(-1)?.prompt ?? null,
    currentTurnId: thread.currentTurn?.id ?? null,
    currentTurnStatus: thread.currentTurn?.status ?? null,
    lastModel: latestTurn?.configSnapshot.model ?? null,
    lastReasoningEffort: latestTurn?.configSnapshot.reasoningEffort ?? null,
    turns: thread.turns,
    queue: thread.queue,
    events: thread.items.map((item) => threadItemToEvent(thread.id, item)),
  };
}

function ThreadPage() {
  const { threadId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const api = useApi();
  const subscriber = useContext(EventSubscriberContext);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const openedFromArchived = searchParams.get("archived") === "1";
  const thread = useQuery({
    queryKey: ["thread", threadId],
    queryFn: () => loadThread(api, threadId),
    enabled: Boolean(threadId),
  });
  const presentationSubagents = useQuery({
    queryKey: ["subagents", threadId],
    queryFn: () => {
      if (!api.listSubagents) throw new Error("Subagent list unavailable");
      return api.listSubagents(threadId);
    },
    enabled: Boolean(threadId),
    refetchInterval: (query) =>
      query.state.data?.some((agent) => agent.status === "ACTIVE") ? 2_000 : false,
  });
  const settings = useQuery({
    queryKey: ["my-settings"],
    queryFn: () => {
      if (!api.getMySettings) throw new Error("Settings endpoint unavailable");
      return api.getMySettings();
    },
  });
  const models = useQuery({
    queryKey: ["models", threadId],
    queryFn: () => {
      if (!api.listModels) throw new Error("Model catalog endpoint unavailable");
      return api.listModels(threadId);
    },
    enabled: Boolean(threadId),
  });
  const capabilities = useQuery({
    queryKey: ["composer-capabilities", threadId],
    queryFn: () => api.listComposerCapabilities?.(threadId) ?? Promise.resolve([]),
    enabled: Boolean(threadId && api.listComposerCapabilities),
  });
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const eventsRef = useRef<TaskEvent[]>([]);
  const activeThreadIdRef = useRef(threadId);
  const [workspaceLayout, dispatchWorkspaceLayout] = useReducer(
    reduceWorkspaceLayout,
    undefined,
    createWorkspaceLayoutState,
  );
  const pinnedToggleRef = useRef<HTMLButtonElement>(null);
  const sideToggleRef = useRef<HTMLButtonElement>(null);
  const bottomToggleRef = useRef<HTMLButtonElement>(null);
  const [bottomTerminalSource, setBottomTerminalSource] = useState<TerminalDetail[] | null>(null);
  const [connection, setConnection] = useState<"connected" | "reconnecting">("connected");
  const [message, setMessage] = useState("");
  const [modelSelection, setModelSelection] = useState<ModelSelection | null>(null);
  const [permission, setPermission] = useState<ExecutionPermissionSelection | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const selectedModel = resolveCatalogSelection(
    models.data,
    modelSelection?.model ?? thread.data?.lastModel ?? settings.data?.execution.model,
    modelSelection?.reasoningEffort ??
      thread.data?.lastReasoningEffort ??
      settings.data?.execution.reasoningEffort,
  );
  const selectedPermission =
    permission ?? permissionSelectionFromLegacy(settings.data?.execution.permissionMode);
  const turnConfig = selectedModel
    ? {
        model: selectedModel.model,
        reasoningEffort: selectedModel.reasoningEffort,
        permissionMode: permissionModeForTurn(selectedPermission),
      }
    : null;
  const initialLastEventId =
    thread.data?.events.reduce((maximum, event) => Math.max(maximum, event.sequence), 0) ?? 0;

  useEffect(() => {
    if (activeThreadIdRef.current === threadId) return;
    activeThreadIdRef.current = threadId;
    eventsRef.current = [];
    setEvents([]);
    setMessage("");
    setModelSelection(null);
    setPermission(null);
    setRuntimeError(null);
    setBottomTerminalSource(null);
    dispatchWorkspaceLayout({ type: "RESET_THREAD" });
  }, [threadId]);
  useEffect(() => {
    if (!thread.data) return;
    const merged = mergeThreadEvents(eventsRef.current, thread.data.events);
    eventsRef.current = merged;
    setEvents(merged);
  }, [thread.data]);
  useEffect(() => {
    if (!threadId || !thread.isSuccess) return undefined;
    return subscriber(
      threadId,
      (event) => {
        const merged = mergeThreadEvents(eventsRef.current, [event]);
        eventsRef.current = merged;
        setEvents(merged);
        setConnection("connected");
        if (isStatusEvent(event)) {
          void Promise.all([
            queryClient.invalidateQueries({ queryKey: ["thread", threadId] }),
            queryClient.invalidateQueries({ queryKey: ["threads"] }),
          ]);
        }
        if (event.type === "SUBAGENT_ACTIVITY") {
          void Promise.all([
            queryClient.invalidateQueries({ queryKey: ["subagents", threadId] }),
            queryClient.invalidateQueries({
              queryKey: ["subagent", event.payload.agentThreadId],
            }),
          ]);
        }
      },
      {
        initialLastEventId,
        onConnectionChange: (state) =>
          setConnection(state === "reconnecting" ? "reconnecting" : "connected"),
      },
    );
  }, [initialLastEventId, queryClient, subscriber, thread.isSuccess, threadId]);

  const action = useMutation({
    mutationFn: async ({ name, input }: { name: "interrupt" | "steer"; input?: string }) => {
      if (api.threadAction) return api.threadAction(threadId, name, input);
      return api.taskAction(threadId, name, input);
    },
    onError: (cause) => setRuntimeError(runtimeErrorMessage(cause)),
  });
  const start = useMutation({
    mutationFn: async (prompt: string) => {
      if (!turnConfig) throw new Error("Runtime 模型目录不可用");
      if (api.startThreadTurn) return api.startThreadTurn(threadId, prompt, turnConfig);
      return api.startTurn(threadId, prompt);
    },
    onError: (cause) => setRuntimeError(runtimeErrorMessage(cause)),
  });
  const archive = useMutation({
    mutationFn: () => {
      if (!api.archiveThread) throw new Error("Thread archive endpoint unavailable");
      return api.archiveThread(threadId);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["threads"] }),
        queryClient.invalidateQueries({ queryKey: ["archived-threads"] }),
        queryClient.invalidateQueries({ queryKey: ["thread", threadId] }),
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
      ]);
      navigate("/settings/archived", { replace: true });
    },
    onError: (cause) => setRuntimeError(runtimeErrorMessage(cause)),
  });
  if (thread.isPending) return <FullPageState label="正在打开 Thread" />;
  if (thread.isError) return <PageError title="无法打开任务" />;

  const mergedEvents = mergeThreadEvents(thread.data.events, events);
  const status = projectStatus(thread.data.status, mergedEvents, thread.data.currentTurnId);
  const archived = thread.data.archivedAt !== null;
  const executionStatus = thread.data.currentTurnStatus ?? status;
  const canSteer =
    !archived && (executionStatus === "RUNNING" || executionStatus === "WAITING_APPROVAL");
  const configLocked =
    archived ||
    ["ALLOCATING", "QUEUED", "RUNNING", "WAITING_APPROVAL"].includes(
      thread.data.currentTurnStatus ?? status,
    );
  const waitingForAllocation = ["ALLOCATING", "QUEUED"].includes(
    thread.data.currentTurnStatus ?? status,
  );
  const canStartTurn =
    ["DRAFT", "READY", "COMPLETED", "FAILED", "INTERRUPTED", "NEEDS_RECOVERY"].includes(status) &&
    !archived;
  const canArchive =
    ["COMPLETED", "FAILED", "INTERRUPTED", "NEEDS_RECOVERY"].includes(status) && !archived;
  const projectedSubagents = mergeSubagents(
    presentationSubagents.data ?? [],
    projectEventSubagents(mergedEvents),
  );
  const presentation = projectThreadPresentation(
    mergedEvents,
    thread.data.turns,
    projectedSubagents,
  );
  const visibleTerminals = bottomTerminalSource ?? presentation.bottom.terminals;
  const availableBottomTabs: BottomPanelTab[] = [
    visibleTerminals.length > 0 ? "terminal" : null,
  ].filter((tab): tab is BottomPanelTab => tab !== null);
  const defaultBottomTab = availableBottomTabs[0] ?? "terminal";
  const approvalDecisions = new Map(
    mergedEvents.flatMap((event) =>
      event.type === "APPROVAL_DECIDED"
        ? [[event.payload.approvalId, event.payload.decision] as const]
        : [],
    ),
  );
  const approvalRequests = new Map(
    mergedEvents.flatMap((event) =>
      event.type === "APPROVAL_REQUESTED" ? [[event.payload.approvalId, event] as const] : [],
    ),
  );
  const closedTurnIds = new Set(
    mergedEvents.flatMap((event) =>
      event.turnId &&
      ["TURN_COMPLETED", "TURN_FAILED", "TURN_INTERRUPTED", "RECOVERY_REQUIRED"].includes(
        event.type,
      )
        ? [event.turnId]
        : [],
    ),
  );
  const send = (event: FormEvent) => {
    event.preventDefault();
    const prompt = message.trim();
    if (!prompt) return;
    setRuntimeError(null);
    if (canSteer) {
      action.mutate(
        { name: "steer", input: prompt },
        {
          onSuccess: () => {
            setMessage("");
          },
        },
      );
    } else if (canStartTurn) {
      start.mutate(prompt, { onSuccess: () => setMessage("") });
    }
  };
  return (
    <div className="v11-thread-page">
      <WorkspaceHeader
        title={thread.data.title}
        pinnedOpen={workspaceLayout.pinnedSummaryOpen}
        bottomOpen={workspaceLayout.bottomPanel.open}
        bottomAvailable={availableBottomTabs.length > 0}
        sideOpen={workspaceLayout.sidePanel.open}
        canArchive={canArchive}
        archivePending={archive.isPending || action.isPending || start.isPending}
        pinnedToggleRef={pinnedToggleRef}
        bottomToggleRef={bottomToggleRef}
        sideToggleRef={sideToggleRef}
        onTogglePinned={() => dispatchWorkspaceLayout({ type: "TOGGLE_PINNED" })}
        onToggleBottom={() => {
          dispatchWorkspaceLayout(
            workspaceLayout.bottomPanel.open
              ? { type: "CLOSE_BOTTOM" }
              : { type: "OPEN_BOTTOM", tab: defaultBottomTab },
          );
        }}
        onToggleSide={() =>
          dispatchWorkspaceLayout(
            workspaceLayout.sidePanel.open
              ? { type: "CLOSE_SIDE" }
              : { type: "OPEN_SIDE", tab: workspaceLayout.sidePanel.tab },
          )
        }
        onArchive={() => {
          setRuntimeError(null);
          archive.mutate();
        }}
      />
      {connection === "reconnecting" ? (
        <div className="v11-connection-notice" role="status">
          正在重新连接执行流…
        </div>
      ) : null}
      {archived ? (
        <div className="v11-capability-note">
          此 Thread 已被服务端标记为平台归档；归档仅整理 CodexPlatform 历史记录，不改变 Codex App
          Server Thread。
          {openedFromArchived ? (
            <Link to="/settings/archived" aria-label="返回 Archived">
              返回 Archived
            </Link>
          ) : null}
        </div>
      ) : null}
      {thread.data.queue && status === "QUEUED" ? (
        <QueueBanner
          position={thread.data.queue.position}
          etaMs={thread.data.queue.etaMs}
          estimated={thread.data.queue.etaEstimated}
        />
      ) : null}
      <div
        className={`v11-thread-grid${workspaceLayout.sidePanel.open ? " side-open" : ""}`}
        style={{ "--side-panel-width": `${workspaceLayout.sidePanel.width}px` } as CSSProperties}
      >
        <div className="thread-workspace-main">
          <PinnedExecutionSummary
            open={workspaceLayout.pinnedSummaryOpen}
            onClose={() => dispatchWorkspaceLayout({ type: "TOGGLE_PINNED" })}
            returnFocusRef={pinnedToggleRef}
          >
            <PinnedSummaryContent
              presentation={presentation}
              onOpenSide={(tab) => dispatchWorkspaceLayout({ type: "OPEN_SIDE", tab })}
            />
          </PinnedExecutionSummary>
          <section className="v11-conversation" aria-label="Thread conversation">
            <Transcript
              groups={presentation.transcript.groups}
              busy={["ALLOCATING", "RUNNING", "WAITING_APPROVAL"].includes(status)}
              onOpenBottom={(tab, detailId) => {
                setBottomTerminalSource(null);
                dispatchWorkspaceLayout({ type: "OPEN_BOTTOM", tab, detailId });
              }}
              onOpenSide={(tab) => dispatchWorkspaceLayout({ type: "OPEN_SIDE", tab })}
              onOpenSubagent={(id) =>
                dispatchWorkspaceLayout({
                  type: "OPEN_SIDE",
                  tab: { kind: "subagent", id },
                })
              }
              renderApproval={(row: TranscriptApprovalRow) => {
                const approval = approvalRequests.get(row.approvalId);
                if (!approval) return null;
                return (
                  <ApprovalEvent
                    event={approval}
                    api={api}
                    locked={
                      ["COMPLETED", "FAILED", "INTERRUPTED", "NEEDS_RECOVERY"].includes(status) ||
                      (approval.turnId !== null && closedTurnIds.has(approval.turnId))
                    }
                    existingDecision={approvalDecisions.get(row.approvalId)}
                  />
                );
              }}
            />
            <form className="v11-composer v11-thread-composer" onSubmit={send}>
              <label className="sr-only" htmlFor="thread-message">
                Message Codex
              </label>
              <textarea
                id="thread-message"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                rows={3}
                placeholder={
                  archived
                    ? "Thread 已归档，请先 Unarchive"
                    : waitingForAllocation
                      ? "等待运行资源…"
                      : "Message Codex"
                }
                disabled={waitingForAllocation || archived}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              <div className="v11-composer-toolbar">
                <ComposerAddMenu
                  capabilities={capabilities.data ?? EMPTY_COMPOSER_CAPABILITIES}
                  onSelect={(capability) => applyComposerCapability(capability, setMessage)}
                  disabled={configLocked || archived}
                />
                <PermissionModePicker
                  value={selectedPermission}
                  options={permissionOptions(settings.data?.policy.allowedPermissionModes)}
                  onChange={setPermission}
                  disabled={configLocked || settings.isPending || settings.isError}
                />
                <ModelEffortPicker
                  catalog={models.data ?? null}
                  value={selectedModel}
                  onChange={setModelSelection}
                  loading={models.isPending}
                  error={models.isError}
                  disabled={configLocked || settings.isPending || settings.isError}
                />
                <span className="v11-capability-note">
                  {waitingForAllocation
                    ? "正在排队，暂不能提交新的 Turn"
                    : canSteer
                      ? "Steer 沿用当前 Turn 的执行设置"
                      : capabilities.isPending
                        ? "正在读取可用能力"
                        : "Capabilities follow organization policy"}
                </span>
                <ComposerSubmitControl
                  mode={canSteer && message.trim().length === 0 ? "stop" : "send"}
                  steer={canSteer}
                  disabled={
                    action.isPending ||
                    start.isPending ||
                    settings.isPending ||
                    settings.isError ||
                    (!canSteer && (models.isPending || models.isError || !selectedModel)) ||
                    waitingForAllocation ||
                    (!canSteer && !canStartTurn) ||
                    (message.trim().length === 0 && !canSteer)
                  }
                  onStop={() => {
                    setRuntimeError(null);
                    action.mutate({ name: "interrupt" });
                  }}
                />
              </div>
            </form>
            {settings.isError ? (
              <div className="v11-runtime-error" role="alert">
                <Icon name="activity" />
                <span>无法读取个人执行配置，请刷新后重试。</span>
              </div>
            ) : null}
            {runtimeError ? (
              <div className="v11-runtime-error" role="alert">
                <Icon name="activity" />
                <span>{runtimeError}</span>
              </div>
            ) : null}
          </section>
          <BottomPanel
            open={workspaceLayout.bottomPanel.open}
            tab={workspaceLayout.bottomPanel.tab}
            height={workspaceLayout.bottomPanel.height}
            availableTabs={availableBottomTabs}
            onSelect={(tab) => dispatchWorkspaceLayout({ type: "SELECT_BOTTOM_TAB", tab })}
            onClose={() => dispatchWorkspaceLayout({ type: "CLOSE_BOTTOM" })}
            returnFocusRef={bottomToggleRef}
            renderContent={(_tab) => (
              <TerminalPanel
                terminals={visibleTerminals}
                selectedDetailId={workspaceLayout.bottomPanel.detailId}
              />
            )}
          />
        </div>
        <SidePanel
          open={workspaceLayout.sidePanel.open}
          tab={workspaceLayout.sidePanel.tab}
          width={workspaceLayout.sidePanel.width}
          onSelect={(tab) => dispatchWorkspaceLayout({ type: "SELECT_SIDE_TAB", tab })}
          onClose={() => dispatchWorkspaceLayout({ type: "CLOSE_SIDE" })}
          returnFocusRef={sideToggleRef}
          renderContent={(tab) => (
            <ThreadSideContent
              threadId={threadId}
              events={mergedEvents}
              presentation={presentation}
              tab={tab}
              onSelect={(next) => dispatchWorkspaceLayout({ type: "SELECT_SIDE_TAB", tab: next })}
              onOpenSubagentTerminal={(terminals, detailId) => {
                setBottomTerminalSource(terminals);
                dispatchWorkspaceLayout({ type: "OPEN_BOTTOM", tab: "terminal", detailId });
              }}
            />
          )}
        />
      </div>
    </div>
  );
}

function Conversation({
  prompt,
  turns,
  events,
  api,
  status,
  approvalDecisions,
  closedTurnIds,
  readOnly = false,
}: {
  prompt: string | null;
  turns: Array<{ id: string; prompt: string }>;
  events: TaskEvent[];
  api: PlatformApi;
  status: TaskStatus;
  approvalDecisions: Map<string, string>;
  closedTurnIds: Set<string>;
  readOnly?: boolean;
}) {
  const prompts =
    turns.length > 0 ? turns : prompt ? [{ id: events[0]?.turnId ?? "turn", prompt }] : [];
  const rendered = new Set<number>();
  const approvalsLocked =
    readOnly || ["COMPLETED", "FAILED", "INTERRUPTED", "NEEDS_RECOVERY"].includes(status);
  return (
    <div className="v11-conversation-stream">
      {prompts.map((turn) => {
        const turnEvents = events.filter((event) => event.turnId === turn.id);
        for (const event of turnEvents) rendered.add(event.sequence);
        return (
          <section className="v11-turn" key={turn.id}>
            <article className="v11-user-message">
              <div className="v11-message-label">You</div>
              <p>{turn.prompt}</p>
            </article>
            {turnEvents.map((event) => (
              <ConversationEvent
                event={event}
                api={api}
                approvalsLocked={
                  approvalsLocked || (event.turnId !== null && closedTurnIds.has(event.turnId))
                }
                approvalDecision={
                  event.type === "APPROVAL_REQUESTED"
                    ? approvalDecisions.get(event.payload.approvalId)
                    : undefined
                }
                key={eventIdentity(event)}
              />
            ))}
          </section>
        );
      })}
      {events
        .filter((event) => !rendered.has(event.sequence))
        .map((event) => (
          <ConversationEvent
            event={event}
            api={api}
            approvalsLocked={
              approvalsLocked || (event.turnId !== null && closedTurnIds.has(event.turnId))
            }
            approvalDecision={
              event.type === "APPROVAL_REQUESTED"
                ? approvalDecisions.get(event.payload.approvalId)
                : undefined
            }
            key={eventIdentity(event)}
          />
        ))}
      {events.length === 0 ? (
        <div className="v11-waiting">
          <span className="loader-ring" />
          <p>Waiting for Codex…</p>
        </div>
      ) : null}
    </div>
  );
}

function ConversationEvent({
  event,
  api,
  approvalsLocked,
  approvalDecision,
}: {
  event: TaskEvent;
  api: PlatformApi;
  approvalsLocked: boolean;
  approvalDecision?: string | undefined;
}) {
  switch (event.type) {
    case "USER_MESSAGE":
      return (
        <article className="v11-user-message v11-steer-message">
          <div className="v11-message-label">You · Steer</div>
          <p>{event.payload.text}</p>
        </article>
      );
    case "AGENT_MESSAGE_DELTA":
      return (
        <EventBlock icon="spark" title="Codex">
          <p>{event.payload.delta}</p>
        </EventBlock>
      );
    case "REASONING_SUMMARY_DELTA":
      return (
        <EventBlock icon="activity" title="执行摘要">
          <p>{event.payload.delta}</p>
        </EventBlock>
      );
    case "PLAN_UPDATED": {
      const steps = event.payload.plan.map((item, index) => readPlanStep(item, index));
      return (
        <EventBlock icon="grid" title="执行计划">
          {event.payload.explanation ? <p>{event.payload.explanation}</p> : null}
          <ol>
            {steps.map((step) => (
              <li key={step.label}>{step.label}</li>
            ))}
          </ol>
        </EventBlock>
      );
    }
    case "COMMAND_STARTED":
    case "COMMAND_COMPLETED":
      return (
        <EventBlock
          icon="terminal"
          title={event.type === "COMMAND_STARTED" ? "运行命令" : "命令完成"}
        >
          <pre>
            <code>{event.payload.command}</code>
          </pre>
        </EventBlock>
      );
    case "COMMAND_OUTPUT":
      return (
        <EventBlock icon="terminal" title="命令输出">
          <pre className="command-output">{event.payload.delta}</pre>
        </EventBlock>
      );
    case "TOOL_STARTED":
    case "TOOL_COMPLETED":
    case "TOOL_FAILED":
      return (
        <EventBlock
          icon="tool"
          title={
            event.type === "TOOL_FAILED"
              ? "工具调用失败"
              : event.type === "TOOL_STARTED"
                ? "调用企业工具"
                : "工具调用完成"
          }
        >
          <code>{event.payload.tool}</code>
          {event.type === "TOOL_FAILED" && event.payload.error ? (
            <p>{event.payload.error}</p>
          ) : null}
        </EventBlock>
      );
    case "DIFF_UPDATED":
      return (
        <EventBlock icon="code" title="文件变更">
          <DiffView diff={event.payload.diff} />
        </EventBlock>
      );
    case "APPROVAL_REQUESTED":
      return (
        <ApprovalEvent
          event={event}
          api={api}
          locked={approvalsLocked}
          existingDecision={approvalDecision}
        />
      );
    case "APPROVAL_DECIDED":
      return (
        <EventBlock icon="check" title="审批已处理">
          <p>决策：{event.payload.decision}</p>
        </EventBlock>
      );
    case "QUEUED":
      return (
        <QueueBanner
          position={event.payload.position}
          etaMs={event.payload.etaMs}
          estimated={event.payload.etaEstimated}
        />
      );
    case "TURN_STARTED":
      return (
        <EventBlock icon="play" title="开始执行">
          <p>Codex 正在处理本轮任务。</p>
        </EventBlock>
      );
    case "TURN_COMPLETED":
      return (
        <EventBlock icon="check" title="任务完成">
          <p>本轮执行已完成。</p>
        </EventBlock>
      );
    case "TURN_FAILED":
      return (
        <EventBlock icon="activity" title="执行失败">
          <p>{event.payload.error}</p>
        </EventBlock>
      );
    case "TURN_INTERRUPTED":
      return (
        <EventBlock icon="pause" title="执行已停止">
          <p>可以补充要求后继续。</p>
        </EventBlock>
      );
    case "RECOVERY_REQUIRED":
      return (
        <EventBlock icon="activity" title="需要恢复">
          <p>{event.payload.reason}</p>
        </EventBlock>
      );
    default:
      return null;
  }
}

function EventBlock({
  icon,
  title,
  children,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  title: string;
  children: ReactNode;
}) {
  return (
    <article className="v11-event">
      <span>
        <Icon name={icon} />
      </span>
      <div>
        <h3>{title}</h3>
        {children}
      </div>
    </article>
  );
}

function ApprovalEvent({
  event,
  api,
  locked,
  existingDecision,
}: {
  event: Extract<TaskEvent, { type: "APPROVAL_REQUESTED" }>;
  api: PlatformApi;
  locked: boolean;
  existingDecision?: string | undefined;
}) {
  const [decision, setDecision] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (next: "accept" | "decline") => api.decideApproval(event.payload.approvalId, next),
    onSuccess: (_result, next) => setDecision(next),
  });
  const effectiveDecision = decision ?? existingDecision;
  return (
    <EventBlock icon="shield" title="等待审批">
      <p>{event.payload.reason ?? "Codex 请求执行受控操作"}</p>
      {event.payload.sourceSubagent ? (
        <p className="v11-approval-source">
          <span>来自子 Agent</span>：
          {event.payload.sourceSubagentName ?? event.payload.sourceThreadId ?? "未知"}
        </p>
      ) : null}
      {event.payload.command ? (
        <pre>
          <code>{event.payload.command}</code>
        </pre>
      ) : null}
      {effectiveDecision ? (
        <p>{approvalDecisionLabel(effectiveDecision)}</p>
      ) : (
        <>
          <div className="v11-approval-actions">
            <button
              type="button"
              disabled={locked || mutation.isPending}
              onClick={() => mutation.mutate("accept")}
            >
              允许一次
            </button>
            <button
              type="button"
              disabled={locked || mutation.isPending}
              onClick={() => mutation.mutate("decline")}
            >
              拒绝
            </button>
          </div>
          <MutationNotice pending={mutation.isPending} error={mutation.error} />
        </>
      )}
    </EventBlock>
  );
}

function ThreadSideContent({
  threadId,
  events,
  presentation,
  tab,
  onSelect,
  onOpenSubagentTerminal,
}: {
  threadId: string;
  events: TaskEvent[];
  presentation: ThreadPresentation;
  tab: SidePanelTab;
  onSelect: (tab: SidePanelTab) => void;
  onOpenSubagentTerminal: (terminals: TerminalDetail[], detailId: string) => void;
}) {
  const api = useApi();
  const selectedSubagent = tab.kind === "subagent" ? tab.id : null;
  const subagents = useQuery({
    queryKey: ["subagents", threadId],
    queryFn: () => {
      if (!api.listSubagents) throw new Error("Subagent list unavailable");
      return api.listSubagents(threadId);
    },
    refetchInterval: (query) =>
      query.state.data?.some((agent) => agent.status === "ACTIVE") ||
      projectEventSubagents(events).some((agent) => agent.status === "ACTIVE")
        ? 2_000
        : false,
  });
  const detail = useQuery({
    queryKey: ["subagent", selectedSubagent],
    queryFn: () => {
      if (!selectedSubagent || !api.getSubagent) throw new Error("Subagent detail unavailable");
      return api.getSubagent(selectedSubagent);
    },
    enabled: Boolean(selectedSubagent),
    refetchInterval: (query) => (query.state.data?.status === "ACTIVE" ? 2_000 : false),
  });
  const eventAgents = projectEventSubagents(events);
  const agents = mergeSubagents(subagents.data ?? [], eventAgents);
  return (
    <div className="v11-rail-panel">
      {tab.kind === "plan" ? <PlanPanel plan={presentation.side.plan} /> : null}
      {tab.kind === "outputs" ? <OutputsPanel outputs={presentation.side.outputs} /> : null}
      {tab.kind === "sources" ? <SourcesPanel sources={presentation.side.sources} /> : null}
      {tab.kind === "changes" ? (
        <ChangesPanel changes={presentation.side.changes} detailId={tab.detailId} />
      ) : null}
      {tab.kind === "tool" ? (
        <ToolDetailPanel tools={presentation.side.tools} detailId={tab.detailId} />
      ) : null}
      {tab.kind === "subagent" ? (
        <SubagentDetail
          key={selectedSubagent}
          detail={detail.data}
          loading={detail.isPending}
          error={detail.isError}
          onBack={() => onSelect({ kind: "subagents" })}
          onRetry={() => void detail.refetch()}
          onOpenTerminal={onOpenSubagentTerminal}
        />
      ) : null}
      {tab.kind === "subagents" ? (
        <SubagentPanel
          agents={agents}
          loading={subagents.isPending}
          error={subagents.isError}
          onOpen={(id) => onSelect({ kind: "subagent", id })}
          onRetry={() => void subagents.refetch()}
        />
      ) : null}
    </div>
  );
}

function PinnedSummaryContent({
  presentation,
  onOpenSide,
}: {
  presentation: ThreadPresentation;
  onOpenSide: (tab: SidePanelTab) => void;
}) {
  const summary = presentation.pinned;
  const activeAgents = summary?.subagents.filter((agent) => agent.status === "ACTIVE").length ?? 0;
  return (
    <div className="pinned-summary-sections">
      <section>
        <h3>Plan</h3>
        <button
          type="button"
          aria-label="Open pinned Plan"
          onClick={() => onOpenSide({ kind: "plan" })}
        >
          {summary?.plan
            ? summary.plan.explanation || `${summary.plan.steps.length} steps`
            : "No plan yet"}
        </button>
      </section>
      <section>
        <h3>Outputs</h3>
        <button
          type="button"
          aria-label="Open pinned Outputs"
          onClick={() => onOpenSide({ kind: "outputs" })}
        >
          {summary && summary.outputs.length > 0
            ? `${summary.outputs.length} artifact${summary.outputs.length === 1 ? "" : "s"}`
            : "None"}
        </button>
      </section>
      <section>
        <h3>Subagents</h3>
        <button
          type="button"
          aria-label="Open pinned Subagents"
          onClick={() => onOpenSide({ kind: "subagents" })}
        >
          {activeAgents > 0
            ? `${activeAgents} Working`
            : summary && summary.subagents.length > 0
              ? "Done"
              : "None"}
        </button>
      </section>
      <section>
        <h3>Sources</h3>
        <button
          type="button"
          aria-label="Open pinned Sources"
          onClick={() => onOpenSide({ kind: "sources" })}
        >
          {summary && summary.sources.length > 0
            ? `${summary.sources.length} source${summary.sources.length === 1 ? "" : "s"}`
            : "None"}
        </button>
      </section>
      {summary?.reasoningSummary ? (
        <section>
          <h3>Current activity</h3>
          <p>
            {summary.activityCount} {summary.activityCount === 1 ? "activity" : "activities"} ·
            execution summary available in Transcript
          </p>
        </section>
      ) : null}
    </div>
  );
}

function PlanPanel({ plan }: { plan: ThreadPresentation["side"]["plan"] }) {
  if (!plan) return <EmptyRail copy="No plan has been published yet." />;
  const steps = plan.steps.map((item, index) => readPlanStep(item, index));
  return (
    <div className="v11-rail-list">
      <p>{plan.explanation}</p>
      {steps.map((step, index) => (
        <div key={step.label}>
          <span>{index + 1}</span> {step.label}
        </div>
      ))}
    </div>
  );
}

function OutputsPanel({ outputs }: { outputs: ThreadPresentation["side"]["outputs"] }) {
  if (outputs.length === 0) return <EmptyRail copy="Outputs will appear as Codex produces them." />;
  return (
    <div className="v11-rail-list">
      {outputs.map((output) => (
        <article key={output.id}>
          <strong>{output.name}</strong>
          <p>{output.mimeType ?? "Artifact"}</p>
          {output.uri ? <a href={output.uri}>Open output</a> : null}
        </article>
      ))}
    </div>
  );
}

function SourcesPanel({ sources }: { sources: ThreadPresentation["side"]["sources"] }) {
  if (sources.length === 0)
    return <EmptyRail copy="Enterprise sources used by tools will appear here." />;
  return (
    <div className="v11-rail-list">
      {sources.map((source) => (
        <article key={source.id}>
          <Icon name="tool" /> <strong>{source.title}</strong>
          {source.uri ? <a href={source.uri}>Open source</a> : <span>Citation</span>}
        </article>
      ))}
    </div>
  );
}

function ChangesPanel({
  changes,
  detailId,
}: {
  changes: ThreadPresentation["side"]["changes"];
  detailId: string | null;
}) {
  const visible = detailId ? changes.filter((change) => change.id === detailId) : changes;
  if (visible.length === 0) return <EmptyRail copy="No file changes are available." />;
  return (
    <div className="v11-rail-list">
      {visible.map((change) => (
        <article key={change.id}>
          <strong>
            {change.changedFiles} file{change.changedFiles === 1 ? "" : "s"} changed
          </strong>
          <DiffView diff={change.diff} />
        </article>
      ))}
    </div>
  );
}

function ToolDetailPanel({
  tools,
  detailId,
}: {
  tools: ThreadPresentation["side"]["tools"];
  detailId: string | null;
}) {
  const visible = detailId ? tools.filter((tool) => tool.id === detailId) : tools;
  if (visible.length === 0) return <EmptyRail copy="No Tool details are available." />;
  return (
    <div className="v11-rail-list">
      {visible.map((tool) => (
        <article key={tool.id}>
          <strong>{tool.tool}</strong>
          <span>{tool.status.slice(0, 1).toUpperCase() + tool.status.slice(1)}</span>
          <dl>
            <div>
              <dt>Arguments</dt>
              <dd>
                <pre>{formatInspectorValue(tool.arguments)}</pre>
              </dd>
            </div>
            <div>
              <dt>{tool.status === "failed" ? "Error" : "Result"}</dt>
              <dd>
                <pre>
                  {formatInspectorValue(tool.status === "failed" ? tool.error : tool.result)}
                </pre>
              </dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>{tool.durationMs === null ? "—" : `${tool.durationMs} ms`}</dd>
            </div>
          </dl>
        </article>
      ))}
    </div>
  );
}

function SubagentPanel({
  agents,
  loading,
  error,
  onOpen,
  onRetry,
}: {
  agents: SubagentThread[];
  loading: boolean;
  error: boolean;
  onOpen: (id: string) => void;
  onRetry: () => void;
}) {
  if (loading) return <FullPageState label="Loading subagents" />;
  if (error) {
    return (
      <section className="v11-subagent-list-error">
        <InlineError copy="无法读取子 Agent 列表，请重试。" />
        <button type="button" onClick={onRetry}>
          重试
        </button>
      </section>
    );
  }
  const active = agents.filter((agent) => agent.status === "ACTIVE");
  const done = agents.filter((agent) => agent.status !== "ACTIVE");
  return (
    <div className="v11-subagent-groups">
      <SubagentGroup title="Active" agents={active} onOpen={onOpen} />
      <SubagentGroup title="Done" agents={done} onOpen={onOpen} />
    </div>
  );
}

function SubagentGroup({
  title,
  agents,
  onOpen,
}: {
  title: string;
  agents: SubagentThread[];
  onOpen: (id: string) => void;
}) {
  return (
    <section>
      <h3>{title}</h3>
      {agents.length === 0 ? <p className="v11-muted">None</p> : null}
      {agents.map((agent) => (
        <article className="v11-subagent-card" key={agent.threadId}>
          <div>
            <span className={`v11-agent-status ${agent.status.toLowerCase()}`} />
            <strong>{agent.name}</strong>
          </div>
          <span>{formatElapsed(agent.elapsedMs)}</span>
          <p>{agent.resultSummary ?? agent.role}</p>
          <button
            type="button"
            aria-label={`Open ${agent.name} details`}
            onClick={() => onOpen(agent.threadId)}
          >
            Open details
          </button>
        </article>
      ))}
    </section>
  );
}

function SubagentDetail({
  detail,
  loading,
  error,
  onBack,
  onRetry,
  onOpenTerminal,
}: {
  detail: Awaited<ReturnType<NonNullable<PlatformApi["getSubagent"]>>> | undefined;
  loading: boolean;
  error: boolean;
  onBack: () => void;
  onRetry: () => void;
  onOpenTerminal: (terminals: TerminalDetail[], detailId: string) => void;
}) {
  const api = useApi();
  const [selectedDetail, setSelectedDetail] = useState<{
    kind: "changes" | "tool";
    detailId: string;
  } | null>(null);
  if (loading) return <FullPageState label="Loading subagent" />;
  if (error || !detail) {
    return (
      <section className="v11-subagent-detail">
        <button type="button" onClick={onBack}>
          Back to subagents
        </button>
        <InlineError copy="无法读取子 Agent 详情，请重试。" />
        <button type="button" onClick={onRetry}>
          重试
        </button>
      </section>
    );
  }
  const detailEvents = coalesceThreadEvents(
    detail.items.map((item) => threadItemToEvent(detail.threadId, item)),
  );
  const approvalDecisions = new Map(
    detailEvents.flatMap((event) =>
      event.type === "APPROVAL_DECIDED"
        ? [[event.payload.approvalId, event.payload.decision] as const]
        : [],
    ),
  );
  const approvalRequests = new Map(
    detailEvents.flatMap((event) =>
      event.type === "APPROVAL_REQUESTED" ? [[event.payload.approvalId, event] as const] : [],
    ),
  );
  const presentation = projectThreadPresentation(detailEvents, [], []);
  return (
    <section className="v11-subagent-detail">
      <button type="button" onClick={onBack}>
        Back to subagents
      </button>
      <h2>{detail.name}</h2>
      <p>{detail.resultSummary}</p>
      <dl>
        <div>
          <dt>Status</dt>
          <dd>{detail.status}</dd>
        </div>
        <div>
          <dt>Role</dt>
          <dd>{detail.role}</dd>
        </div>
        <div>
          <dt>Elapsed</dt>
          <dd>{formatElapsed(detail.elapsedMs)}</dd>
        </div>
      </dl>
      <div className="v11-subagent-events">
        {selectedDetail ? (
          <section>
            <button type="button" onClick={() => setSelectedDetail(null)}>
              Back to subagent activity
            </button>
            {selectedDetail.kind === "changes" ? (
              <ChangesPanel
                changes={presentation.side.changes}
                detailId={selectedDetail.detailId}
              />
            ) : (
              <ToolDetailPanel tools={presentation.side.tools} detailId={selectedDetail.detailId} />
            )}
          </section>
        ) : (
          <Transcript
            groups={presentation.transcript.groups}
            busy={detail.status === "ACTIVE"}
            onOpenBottom={(_tab, detailId) =>
              onOpenTerminal(presentation.bottom.terminals, detailId)
            }
            onOpenSide={(tab) => {
              if ((tab.kind === "changes" || tab.kind === "tool") && tab.detailId) {
                setSelectedDetail({ kind: tab.kind, detailId: tab.detailId });
              }
            }}
            renderApproval={(row) => {
              const approval = approvalRequests.get(row.approvalId);
              if (!approval) return null;
              return (
                <ApprovalEvent
                  event={approval}
                  api={api}
                  locked
                  existingDecision={approvalDecisions.get(row.approvalId)}
                />
              );
            }}
          />
        )}
      </div>
    </section>
  );
}

function ReadOnlyInspector({ events }: { events: TaskEvent[] }) {
  const tabs = [
    events.some((event) => event.type.startsWith("COMMAND_")) ? "Terminal" : null,
    events.some((event) => event.type === "DIFF_UPDATED") ? "Changes" : null,
    events.some((event) => event.type === "DIFF_UPDATED") ? "Files" : null,
    events.some((event) => event.type.startsWith("TOOL_")) ? "Tool details" : null,
  ].filter((item): item is string => item !== null);
  const [open, setOpen] = useState<string | null>(null);
  if (tabs.length === 0) return null;
  return (
    <section className="v11-inspector">
      <nav aria-label="Thread inspector">
        {tabs.map((tab) => (
          <button
            type="button"
            aria-pressed={open === tab}
            onClick={() => setOpen(open === tab ? null : tab)}
            key={tab}
          >
            {tab}
          </button>
        ))}
      </nav>
      {open ? <InspectorContent tab={open} events={events} /> : null}
    </section>
  );
}

function TerminalPanel({
  terminals,
  selectedDetailId,
}: {
  terminals: TerminalDetail[];
  selectedDetailId: string | null;
}) {
  const visible = selectedDetailId
    ? terminals.filter((terminal) => terminal.id === selectedDetailId)
    : terminals;
  if (visible.length === 0) return <EmptyRail copy="No terminal output is available." />;
  return (
    <div className="terminal-session-list">
      {visible.map((terminal) => (
        <article className="terminal-session" key={terminal.id}>
          <header>
            <strong>{terminal.command ?? "Command"}</strong>
            <span>
              {terminal.status}
              {terminal.exitCode === null ? "" : ` · exit ${terminal.exitCode}`}
              {terminal.durationMs === null ? "" : ` · ${terminal.durationMs} ms`}
            </span>
          </header>
          <pre>{terminal.output || "No output"}</pre>
        </article>
      ))}
    </div>
  );
}

function InspectorContent({
  tab,
  events,
  selectedItemId = null,
}: {
  tab: string;
  events: TaskEvent[];
  selectedItemId?: string | null;
}) {
  const visibleEvents = selectedItemId
    ? events.filter((event) => event.itemId === selectedItemId)
    : events;
  if (tab === "Terminal") {
    return (
      <pre>
        {visibleEvents
          .flatMap((event) => (event.type === "COMMAND_OUTPUT" ? [event.payload.delta] : []))
          .join("")}
      </pre>
    );
  }
  if (tab === "Changes") {
    return (
      <div>
        {visibleEvents.flatMap((event) =>
          event.type === "DIFF_UPDATED"
            ? [<DiffView diff={event.payload.diff} key={eventIdentity(event)} />]
            : [],
        )}
      </div>
    );
  }
  if (tab === "Files") {
    const files = new Set(
      visibleEvents.flatMap((event) =>
        event.type === "DIFF_UPDATED" ? extractDiffFiles(event.payload.diff) : [],
      ),
    );
    return (
      <ul>
        {[...files].map((file) => (
          <li key={file}>{file}</li>
        ))}
      </ul>
    );
  }
  const tools = projectToolDetails(visibleEvents);
  return (
    <ul>
      {tools.map((tool) => (
        <li key={toolDetailIdentity(tool)}>
          <strong>{tool.tool}</strong>
          <span>{toolStatusLabel(tool.status)}</span>
          <dl>
            <div>
              <dt>Arguments</dt>
              <dd>
                <pre>{formatInspectorValue(tool.arguments)}</pre>
              </dd>
            </div>
            {tool.status === "FAILED" ? (
              <div>
                <dt>Error</dt>
                <dd>
                  <pre>{formatInspectorValue(tool.error)}</pre>
                </dd>
              </div>
            ) : (
              <div>
                <dt>Result</dt>
                <dd>
                  <pre>{formatInspectorValue(tool.result)}</pre>
                </dd>
              </div>
            )}
            <div>
              <dt>Duration</dt>
              <dd>{tool.durationMs === null ? "—" : `${tool.durationMs} ms`}</dd>
            </div>
          </dl>
        </li>
      ))}
    </ul>
  );
}

function ProjectsPage() {
  const api = useApi();
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.listProjects });
  return (
    <section className="v11-index-page">
      <header>
        <h1>Projects</h1>
        <Link to="/threads/new">New chat</Link>
      </header>
      <div className="v11-index-list">
        {projects.data?.map((project) => (
          <article key={project.id}>
            <Icon name="project" />
            <h2>{project.name}</h2>
            <p>{project.taskCount} Threads</p>
            <Link to={`/threads/new?project=${project.id}`}>Start Thread</Link>
          </article>
        ))}
      </div>
    </section>
  );
}

function ThreadIndexPage() {
  const api = useApi();
  const threads = useQuery({
    queryKey: ["threads"],
    queryFn: () => (api.listThreads ? api.listThreads() : api.listTasks()),
  });
  return (
    <section className="v11-index-page">
      <header>
        <h1>History</h1>
        <Link to="/threads/new">New chat</Link>
      </header>
      <div className="v11-index-list">
        {threads.data?.map((thread) => (
          <Link to={`/threads/${thread.id}`} key={thread.id}>
            <strong>{thread.title}</strong>
            <StatusBadge status={thread.status} />
          </Link>
        ))}
      </div>
    </section>
  );
}

const SETTINGS_SECTIONS = [
  ["general", "General"],
  ["profile", "Profile"],
  ["execution", "Execution"],
  ["personalization", "Personalization"],
  ["connections", "Connections"],
  ["plugins", "Plugins"],
  ["usage", "Usage"],
  ["archived", "Archived"],
] as const;

function SettingsPage({ session }: { session: Session }) {
  const { section = "general" } = useParams();
  const selected = SETTINGS_SECTIONS.find(([id]) => id === section);
  if (!selected) return <NotFoundPage />;
  return (
    <div className="v11-settings">
      <aside>
        <Link to="/" className="v11-back-link">
          <Icon name="arrow" /> Back to app
        </Link>
        <h1>Settings</h1>
        <nav aria-label="Settings sections">
          {SETTINGS_SECTIONS.map(([id, label]) => (
            <NavLink to={`/settings/${id}`} key={id}>
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main>
        <h1>{selected[1]}</h1>
        <SettingsSection section={selected[0]} session={session} />
      </main>
    </div>
  );
}

function SettingsSection({ section, session }: { section: string; session: Session }) {
  if (section === "archived") return <ArchivedSettings />;
  return <PersonalSettingsSection section={section} session={session} />;
}

function PersonalSettingsSection({ section, session }: { section: string; session: Session }) {
  const api = useApi();
  const settings = useQuery({
    queryKey: ["my-settings"],
    queryFn: () => {
      if (!api.getMySettings) throw new Error("Settings endpoint unavailable");
      return api.getMySettings();
    },
  });
  if (settings.isPending) return <FullPageState label="Loading settings" />;
  if (settings.isError) {
    return (
      <section className="v11-settings-load-error">
        <InlineError copy="无法读取个人设置。为避免覆盖已有配置，编辑功能已暂停。" />
        <button type="button" onClick={() => void settings.refetch()}>
          重试
        </button>
      </section>
    );
  }
  const value = settings.data;
  switch (section) {
    case "general":
      return <GeneralSettings value={value} />;
    case "profile":
      return <ProfileSettings session={session} />;
    case "execution":
      return <ExecutionSettings value={value} />;
    case "personalization":
      return <PersonalizationSettings value={value} />;
    case "connections":
      return <ConnectionsSettings />;
    case "plugins":
      return <PluginsSettings />;
    case "usage":
      return <UsageSettings />;
    default:
      return null;
  }
}

function ArchivedSettings() {
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const archived = useQuery({
    queryKey: ["archived-threads"],
    queryFn: () => {
      if (!api.listArchivedThreads) throw new Error("Archived Thread endpoint unavailable");
      return api.listArchivedThreads();
    },
  });
  const unarchive = useMutation({
    mutationFn: (threadId: string) => {
      if (!api.unarchiveThread) throw new Error("Thread unarchive endpoint unavailable");
      return api.unarchiveThread(threadId);
    },
    onSuccess: async (_result, threadId) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["archived-threads"] }),
        queryClient.invalidateQueries({ queryKey: ["threads"] }),
        queryClient.invalidateQueries({ queryKey: ["thread", threadId] }),
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
      ]);
      navigate(`/threads/${encodeURIComponent(threadId)}`);
    },
  });

  return (
    <section className="v11-archived-settings">
      <p>
        归档仅整理 CodexPlatform 中的历史记录，不会改变 Codex App Server Thread，也不会删除任务
        事件或产物。
      </p>
      {archived.isPending ? <FullPageState label="Loading archived Threads" /> : null}
      {archived.isError ? (
        <div>
          <InlineError copy="无法读取归档 Thread。为避免误操作，归档操作已暂停。" />
          <button type="button" onClick={() => void archived.refetch()}>
            重试
          </button>
        </div>
      ) : null}
      {archived.isSuccess && archived.data.length === 0 ? (
        <EmptySettings title="No archived chats" copy="Archived Threads will appear here." />
      ) : null}
      {archived.isSuccess && archived.data.length > 0 ? (
        <div className="v11-index-list">
          {archived.data.map((thread) => (
            <article key={thread.id}>
              <Link
                to={`/threads/${encodeURIComponent(thread.id)}?archived=1`}
                aria-label={`查看 ${thread.title}`}
              >
                <strong>{thread.title}</strong>
                <StatusBadge status={thread.status} />
              </Link>
              <button
                type="button"
                aria-label={`Unarchive ${thread.title}`}
                disabled={unarchive.isPending}
                onClick={() => unarchive.mutate(thread.id)}
              >
                Unarchive
              </button>
            </article>
          ))}
        </div>
      ) : null}
      {unarchive.isError ? (
        <InlineError
          copy={
            unarchive.error instanceof Error
              ? unarchive.error.message
              : "Unarchive failed. Please retry."
          }
        />
      ) : null}
    </section>
  );
}

function useSaveSettings() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: UserSettingsPatch) => {
      if (!api.patchMySettings) throw new Error("Settings update endpoint unavailable");
      return api.patchMySettings(patch);
    },
    onSuccess: (settings) => queryClient.setQueryData(["my-settings"], settings),
  });
}

function GeneralSettings({ value }: { value: UserSettingsView }) {
  const api = useApi();
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.listProjects });
  const [theme, setTheme] = useState(value.general.theme);
  const [language, setLanguage] = useState(value.general.language);
  const [notifications, setNotifications] = useState(value.general.notificationsEnabled);
  const [defaultProjectId, setDefaultProjectId] = useState(value.general.defaultProjectId ?? "");
  const save = useSaveSettings();
  return (
    <SettingsCard title="General preferences">
      <SettingRow label="Language">
        <select
          aria-label="Language"
          value={language}
          onChange={(event) => setLanguage(event.target.value)}
        >
          <option value="zh-CN">简体中文</option>
          <option value="en">English</option>
        </select>
      </SettingRow>
      <SettingRow label="Appearance">
        <select
          aria-label="Appearance"
          value={theme}
          onChange={(event) => setTheme(event.target.value as typeof theme)}
        >
          <option value="SYSTEM">System</option>
          <option value="DARK">Dark</option>
          <option value="LIGHT">Light</option>
        </select>
      </SettingRow>
      <SettingRow label="Default project">
        <select
          aria-label="Default project"
          value={defaultProjectId}
          onChange={(event) => setDefaultProjectId(event.target.value)}
          disabled={projects.isPending || projects.isError}
        >
          <option value="">No default</option>
          {projects.data?.map((project) => (
            <option value={project.id} key={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </SettingRow>
      <SettingRow label="Notifications">
        <input
          aria-label="Notifications"
          type="checkbox"
          checked={notifications}
          onChange={(event) => setNotifications(event.target.checked)}
        />
      </SettingRow>
      <button
        type="button"
        disabled={save.isPending || projects.isError}
        onClick={() =>
          save.mutate({
            general: {
              theme,
              language,
              defaultProjectId: defaultProjectId || null,
              notificationsEnabled: notifications,
            },
          })
        }
      >
        Save settings
      </button>
      {projects.isError ? <InlineError copy="Projects could not be loaded." /> : null}
      <MutationNotice pending={save.isPending} error={save.error} success={save.isSuccess} />
    </SettingsCard>
  );
}

function ProfileSettings({ session }: { session: Session }) {
  return (
    <SettingsCard title="Feishu profile">
      <SettingRow label="Name">
        <strong>{session.user.name}</strong>
      </SettingRow>
      <SettingRow label="Identity">
        <span>Managed by your organization</span>
      </SettingRow>
    </SettingsCard>
  );
}

function ExecutionSettings({ value }: { value: UserSettingsView }) {
  const api = useApi();
  const models = useQuery({
    queryKey: ["models", "settings"],
    queryFn: () => {
      if (!api.listModels) throw new Error("Model catalog endpoint unavailable");
      return api.listModels();
    },
  });
  const [modelSelection, setModelSelection] = useState<ModelSelection | null>(null);
  const [permission, setPermission] = useState(value.execution.permissionMode);
  const save = useSaveSettings();
  const selectedModel = resolveCatalogSelection(
    models.data,
    modelSelection?.model ?? value.execution.model,
    modelSelection?.reasoningEffort ?? value.execution.reasoningEffort,
  );
  return (
    <SettingsCard title="Execution defaults">
      <SettingRow label="Model">
        <ModelEffortPicker
          catalog={models.data ?? null}
          value={selectedModel}
          onChange={setModelSelection}
          loading={models.isPending}
          error={models.isError}
          disabled={save.isPending}
        />
      </SettingRow>
      <SettingRow label="Permission mode">
        <select
          aria-label="Permission mode"
          value={permission}
          onChange={(event) => setPermission(event.target.value as typeof permission)}
        >
          {value.policy.allowedPermissionModes.map((option) => (
            <option value={option} key={option}>
              {option}
            </option>
          ))}
        </select>
      </SettingRow>
      <SettingRow label="Approvals">
        <strong>Always ask</strong>
      </SettingRow>
      <button
        type="button"
        disabled={save.isPending || models.isPending || models.isError || !selectedModel}
        onClick={() => {
          if (!selectedModel) return;
          save.mutate({
            execution: {
              model: selectedModel.model,
              reasoningEffort: selectedModel.reasoningEffort,
              permissionMode: permission,
              approvalPreference: value.execution.approvalPreference,
            },
          });
        }}
      >
        Save settings
      </button>
      <MutationNotice pending={save.isPending} error={save.error} success={save.isSuccess} />
    </SettingsCard>
  );
}

function PersonalizationSettings({ value }: { value: UserSettingsView }) {
  const [personality, setPersonality] = useState(value.personalization.personality);
  const [instructions, setInstructions] = useState(value.personalization.instructions);
  const save = useSaveSettings();
  return (
    <SettingsCard title="Personalization">
      <SettingRow label="Style">
        <select
          aria-label="Style"
          value={personality}
          onChange={(event) => setPersonality(event.target.value as typeof personality)}
        >
          <option value="NONE">None</option>
          <option value="FRIENDLY">Friendly</option>
          <option value="PRAGMATIC">Pragmatic</option>
        </select>
      </SettingRow>
      <label>
        Personal instructions
        <textarea
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          rows={8}
        />
      </label>
      <button
        type="button"
        disabled={save.isPending}
        onClick={() => save.mutate({ personalization: { personality, instructions } })}
      >
        Save settings
      </button>
      <MutationNotice pending={save.isPending} error={save.error} success={save.isSuccess} />
    </SettingsCard>
  );
}

function ConnectionsSettings() {
  const api = useApi();
  const connections = useQuery({
    queryKey: ["my-connections"],
    queryFn: () => {
      if (!api.listMyConnections) throw new Error("Connections endpoint unavailable");
      return api.listMyConnections();
    },
    refetchOnMount: "always",
  });
  const ready = connections.isSuccess && !connections.isFetching;
  return (
    <SettingsCard title="Organization connections">
      {connections.isFetching ? <InlineQueryState label="Loading connections" /> : null}
      {connections.isError ? (
        <RetryableQueryError
          copy="无法读取组织连接状态。"
          onRetry={() => void connections.refetch()}
        />
      ) : null}
      {ready && connections.data.length === 0 ? (
        <p>暂无可用的组织连接，请联系管理员确认连接器配置。</p>
      ) : null}
      {ready
        ? connections.data.map((item) => (
            <SettingRow label={item.name} key={item.id}>
              <strong>{item.connected ? "Connected" : "Not connected"}</strong>
              <span>{item.managed ? "Managed by organization" : "Personal"}</span>
            </SettingRow>
          ))
        : null}
    </SettingsCard>
  );
}

function PluginsSettings() {
  const api = useApi();
  const plugins = useQuery({
    queryKey: ["my-plugins"],
    queryFn: () => (api.listMyPlugins ? api.listMyPlugins() : Promise.resolve([])),
  });
  if (!plugins.data?.length)
    return (
      <EmptySettings
        title="No plugins enabled"
        copy="Your organization has not enabled personal plugins."
      />
    );
  return (
    <SettingsCard title="Plugins">
      {plugins.data.map((plugin) => (
        <SettingRow label={plugin.name} key={plugin.id}>
          <span>{plugin.status}</span>
        </SettingRow>
      ))}
    </SettingsCard>
  );
}

function UsageSettings() {
  const api = useApi();
  const usage = useQuery({
    queryKey: ["my-usage"],
    queryFn: () => {
      if (!api.getMyUsage) throw new Error("Usage endpoint unavailable");
      return api.getMyUsage();
    },
    refetchOnMount: "always",
  });
  const ready = usage.isSuccess && !usage.isFetching;
  return (
    <SettingsCard title="Personal activity">
      {usage.isFetching ? <InlineQueryState label="Loading usage" /> : null}
      {usage.isError ? (
        <RetryableQueryError copy="无法读取个人使用数据。" onRetry={() => void usage.refetch()} />
      ) : null}
      {ready ? (
        <>
          <div className="v11-usage-grid">
            <Metric label="Threads" value={usage.data.threads} />
            <Metric label="Turns" value={usage.data.turns} />
            <Metric label="Tools" value={usage.data.toolCalls} />
            <Metric label="Subagents" value={usage.data.subagents} />
          </div>
          <p>Shared runtime quota is not attributed to individual users.</p>
        </>
      ) : null}
    </SettingsCard>
  );
}

function SettingsCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="v11-settings-card">
      <h2>{title}</h2>
      {children}
    </section>
  );
}
function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="v11-setting-row">
      <div>
        <strong>{label}</strong>
      </div>
      <div>{children}</div>
    </div>
  );
}
function EmptySettings({ title, copy }: { title: string; copy: string }) {
  return (
    <section className="v11-empty-settings">
      <Icon name="spark" />
      <h2>{title}</h2>
      <p>{copy}</p>
    </section>
  );
}
function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function AccountsPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [alias, setAlias] = useState("");
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: api.listAccounts });
  const add = useMutation({
    mutationFn: () => api.addAccount(alias.trim()),
    onSuccess: async () => {
      setAlias("");
      setAdding(false);
      await queryClient.invalidateQueries({ queryKey: ["accounts"] });
    },
  });
  const action = useMutation({
    mutationFn: ({
      id,
      name,
    }: {
      id: string;
      name: "login" | "drain" | "quarantine" | "restore" | "refresh-quota";
    }) => api.accountAction(id, name),
    onSuccess: async (result) => {
      if (
        typeof result === "object" &&
        result !== null &&
        "authUrl" in result &&
        typeof result.authUrl === "string"
      ) {
        window.location.assign(result.authUrl);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["accounts"] });
    },
  });
  return (
    <section className="v11-admin-page">
      <header>
        <div>
          <p>RUNTIME GOVERNANCE</p>
          <h1>Codex 账号池</h1>
          <span>管理员独立管理运行容量和认证状态。</span>
        </div>
        <button type="button" onClick={() => setAdding(true)}>
          添加账号
        </button>
      </header>
      {adding ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (alias.trim()) add.mutate();
          }}
        >
          <label htmlFor="account-alias">账号别名</label>
          <input
            id="account-alias"
            value={alias}
            onChange={(event) => setAlias(event.target.value)}
          />
          <button type="submit" disabled={add.isPending}>
            保存账号
          </button>
          <MutationNotice pending={add.isPending} error={add.error} />
        </form>
      ) : null}
      {accounts.isPending ? <FullPageState label="Loading accounts" /> : null}
      {accounts.isError ? <InlineError copy="账号池读取失败，请重试。" /> : null}
      {accounts.data ? (
        <div className="v11-account-grid">
          {accounts.data.map((account) => (
            <AccountCard
              account={account}
              actionPending={action.isPending}
              onAction={(name) => action.mutate({ id: account.id, name })}
              key={account.id}
            />
          ))}
        </div>
      ) : null}
      <MutationNotice pending={action.isPending} error={action.error} />
    </section>
  );
}

function AccountCard({
  account,
  actionPending,
  onAction,
}: {
  account: AccountSummary;
  actionPending: boolean;
  onAction: (action: "login" | "drain" | "quarantine" | "restore" | "refresh-quota") => void;
}) {
  const restorable = account.status === "DRAINING" || account.status === "QUARANTINED";
  const quotaUsed =
    account.weeklyRemainingPercent === null ? null : 100 - account.weeklyRemainingPercent;
  return (
    <article className="v11-account-card">
      <header>
        <Icon name="bot" />
        <h2>{account.alias}</h2>
        <span>{account.status}</span>
      </header>
      <div>
        <span>活跃用户</span>
        <strong>
          {account.activeUsers} / {account.maxUsers}
        </strong>
      </div>
      <div>
        <span>本周额度</span>
        {quotaUsed === null ? (
          <strong>待确认</strong>
        ) : (
          <strong className="v11-quota-values">
            <span>本周已用 {quotaUsed}%</span>
            <span>剩余 {account.weeklyRemainingPercent}%</span>
          </strong>
        )}
      </div>
      <div>
        <span>认证状态</span>
        <strong>{accountAuthLabel(account)}</strong>
      </div>
      <div className="v11-account-quota-times">
        <span>
          额度更新{" "}
          {account.quotaUpdatedAt ? formatAccountTimestamp(account.quotaUpdatedAt) : "尚未采集"}
        </span>
        <span>
          下次重置{" "}
          {account.quotaResetsAt ? formatAccountTimestamp(account.quotaResetsAt) : "待确认"}
        </span>
      </div>
      <footer className="v11-account-actions">
        {restorable ? (
          <button type="button" disabled={actionPending} onClick={() => onAction("restore")}>
            恢复
          </button>
        ) : (
          <>
            <button type="button" disabled={actionPending} onClick={() => onAction("drain")}>
              排空
            </button>
            <button type="button" disabled={actionPending} onClick={() => onAction("quarantine")}>
              隔离
            </button>
          </>
        )}
        <button
          type="button"
          disabled={actionPending || account.authStatus === "UNAUTHENTICATED"}
          onClick={() => onAction("refresh-quota")}
        >
          刷新额度
        </button>
        <button type="button" disabled={actionPending} onClick={() => onAction("login")}>
          {account.status === "REAUTH_REQUIRED" ? "登录 Codex" : "重新认证"}
        </button>
      </footer>
    </article>
  );
}

function accountAuthLabel(account: AccountSummary): string {
  if (account.authStatus === "AUTHENTICATED") return "已认证";
  if (account.authStatus === "EXPIRED" || account.status === "REAUTH_REQUIRED") return "认证已失效";
  if (account.authStatus === "UNAUTHENTICATED") return "未认证";
  return "状态待确认";
}

function formatAccountTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间异常";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function AuditPage() {
  const api = useApi();
  const audit = useQuery({
    queryKey: ["audit"],
    queryFn: api.listAudit,
    refetchOnMount: "always",
  });
  const ready = audit.isSuccess && !audit.isFetching;
  return (
    <section className="v11-admin-page">
      <header>
        <div>
          <p>TRACEABILITY</p>
          <h1>审计记录</h1>
        </div>
      </header>
      {audit.isFetching ? <InlineQueryState label="Loading audit" /> : null}
      {audit.isError ? (
        <RetryableQueryError copy="无法读取审计记录。" onRetry={() => void audit.refetch()} />
      ) : null}
      {ready && audit.data.length === 0 ? <p>暂无审计记录。</p> : null}
      <div className="v11-audit-list">
        {ready
          ? audit.data.map((entry) => (
              <article key={entry.id}>
                <time data-label="Time">{formatDateTime(entry.timestamp)}</time>
                <strong data-label="Actor">{entry.actorName}</strong>
                <code data-label="Action">{entry.action}</code>
                <span data-label="Resource">{entry.resource}</span>
                <span data-label="Account">{entry.accountAlias ?? "—"}</span>
                {entry.taskId ? (
                  <Link
                    data-label="Thread"
                    to={`/admin/threads/${encodeURIComponent(entry.taskId)}`}
                  >
                    Thread {entry.taskId}
                  </Link>
                ) : (
                  <span data-label="Thread">Thread —</span>
                )}
                <span data-label="Result">{entry.result}</span>
              </article>
            ))
          : null}
      </div>
    </section>
  );
}

function AdminThreadPage() {
  const { threadId = "" } = useParams();
  const api = useApi();
  const thread = useQuery({
    queryKey: ["admin-thread", threadId],
    queryFn: async () => {
      if (!api.getAdminThread) throw new Error("Administrator Thread endpoint unavailable");
      return projectThreadView(await api.getAdminThread(threadId));
    },
    enabled: Boolean(threadId),
  });
  if (thread.isPending) return <FullPageState label="正在打开审计 Thread" />;
  if (thread.isError) return <PageError title="无法打开审计 Thread" />;

  const events = coalesceThreadEvents(thread.data.events).filter(isSafeConversationEvent);
  const status = projectStatus(thread.data.status, events, thread.data.currentTurnId);
  const approvalDecisions = new Map(
    events.flatMap((event) =>
      event.type === "APPROVAL_DECIDED"
        ? [[event.payload.approvalId, event.payload.decision] as const]
        : [],
    ),
  );
  const closedTurnIds = new Set(
    events.flatMap((event) =>
      event.turnId &&
      ["TURN_COMPLETED", "TURN_FAILED", "TURN_INTERRUPTED", "RECOVERY_REQUIRED"].includes(
        event.type,
      )
        ? [event.turnId]
        : [],
    ),
  );
  return (
    <section className="v11-thread-page v11-admin-thread-page">
      <header className="v11-thread-header">
        <div>
          <Link className="v11-back-link" to="/admin/audit">
            <Icon name="arrow" /> 返回审计记录
          </Link>
          <h1>{thread.data.title}</h1>
          <StatusBadge status={status} />
        </div>
        <span className="v11-readonly-label">
          <Icon name="shield" /> 只读审计视图
        </span>
      </header>
      <section className="v11-conversation" aria-label="Read-only Thread conversation">
        <Conversation
          prompt={thread.data.prompt}
          turns={thread.data.turns}
          events={events}
          api={api}
          status={status}
          approvalDecisions={approvalDecisions}
          closedTurnIds={closedTurnIds}
          readOnly
        />
        <ReadOnlyInspector events={events} />
      </section>
    </section>
  );
}

function AdminPoliciesPage() {
  const api = useApi();
  const policies = useQuery({
    queryKey: ["admin-policies"],
    queryFn: () => {
      if (!api.getAdminPolicies) throw new Error("Policies endpoint unavailable");
      return api.getAdminPolicies();
    },
  });
  return (
    <AdminReadOnlyPage eyebrow="GOVERNANCE" title="Policies">
      {policies.isPending ? <FullPageState label="Loading policies" /> : null}
      {policies.isError ? <InlineError copy="Policies could not be loaded." /> : null}
      {policies.data ? (
        <div className="v11-governance-grid">
          <ReadOnlyCard title="Product modes">
            <InfoLine label="Enabled" value={policies.data.productModes.enabled.join(", ")} />
            <InfoLine label="Disabled" value={policies.data.productModes.disabled.join(", ")} />
          </ReadOnlyCard>
          <ReadOnlyCard title="Deployment">
            <InfoLine label="Stage" value={policies.data.deploymentStage} />
            <InfoLine
              label="Production multi-user"
              value={policies.data.productionMultiUserEnabled ? "Enabled" : "Not enabled"}
            />
          </ReadOnlyCard>
          <ReadOnlyCard title="Memory">
            <InfoLine
              label="Native shared-account memory"
              value={policies.data.memory.nativeSharedAccountMemory ? "Enabled" : "Disabled"}
            />
          </ReadOnlyCard>
          <ReadOnlyCard title="Users and roles">
            <p>User and role directory management is not connected in 1.1A.</p>
          </ReadOnlyCard>
        </div>
      ) : null}
    </AdminReadOnlyPage>
  );
}

function AdminConnectorsPage() {
  const api = useApi();
  const connectors = useQuery({
    queryKey: ["admin-connectors"],
    queryFn: () => {
      if (!api.listAdminConnectors) throw new Error("Connectors endpoint unavailable");
      return api.listAdminConnectors();
    },
  });
  return (
    <AdminReadOnlyPage eyebrow="INTEGRATIONS" title="Connectors">
      {connectors.isPending ? <FullPageState label="Loading connectors" /> : null}
      {connectors.isError ? <InlineError copy="Connectors could not be loaded." /> : null}
      <div className="v11-governance-grid">
        {connectors.data?.map((connector) => (
          <ReadOnlyCard title={connector.name} key={connector.id}>
            <InfoLine label="Mode" value={connector.mode} />
            <InfoLine label="Status" value={connector.status} />
            <InfoLine label="Ownership" value={connector.managed ? "Organization" : "Personal"} />
          </ReadOnlyCard>
        ))}
      </div>
    </AdminReadOnlyPage>
  );
}

function AdminUsagePage() {
  const api = useApi();
  const usage = useQuery({
    queryKey: ["admin-usage"],
    queryFn: () => {
      if (!api.getAdminUsage) throw new Error("Usage endpoint unavailable");
      return api.getAdminUsage();
    },
  });
  return (
    <AdminReadOnlyPage eyebrow="OBSERVABILITY" title="Usage">
      {usage.isPending ? <FullPageState label="Loading usage" /> : null}
      {usage.isError ? <InlineError copy="Usage could not be loaded." /> : null}
      {usage.data ? (
        <>
          <div className="v11-usage-grid">
            <Metric label="Users" value={usage.data.users} />
            <Metric label="Threads" value={usage.data.threads} />
            <Metric label="Turns" value={usage.data.turns} />
            <Metric label="Tools" value={usage.data.toolCalls} />
            <Metric label="Subagents" value={usage.data.subagents} />
          </div>
          <p className="v11-admin-note">
            Shared runtime quota cannot be attributed to an individual employee.
          </p>
        </>
      ) : null}
    </AdminReadOnlyPage>
  );
}

function RuntimeHealthPage() {
  const api = useApi();
  const health = useQuery({
    queryKey: ["admin-runtime-health"],
    queryFn: () => {
      if (!api.getAdminRuntimeHealth) throw new Error("Runtime health endpoint unavailable");
      return api.getAdminRuntimeHealth();
    },
  });
  return (
    <AdminReadOnlyPage eyebrow="RUNTIME" title="Runtime health">
      {health.isPending ? <FullPageState label="Loading runtime health" /> : null}
      {health.isError ? <InlineError copy="Runtime health could not be loaded." /> : null}
      {health.data ? (
        <div className="v11-governance-grid">
          <ReadOnlyCard title="Deployment">
            <InfoLine label="Stage" value={health.data.deploymentStage} />
            <InfoLine label="Worker isolation" value={health.data.workerIsolation} />
            <InfoLine
              label="Multi-user ready"
              value={health.data.multiUserReady ? "Ready" : "Not ready"}
            />
          </ReadOnlyCard>
          <ReadOnlyCard title="Safety">
            <InfoLine label="Mode" value={health.data.safetyMode} />
            <InfoLine
              label="Allowed for actor"
              value={health.data.safetyAllowedForActor ? "Yes" : "No"}
            />
          </ReadOnlyCard>
          <ReadOnlyCard title="Accounts">
            <InfoLine label="Total" value={String(health.data.accounts.total)} />
            <InfoLine label="Available" value={String(health.data.accounts.available)} />
            <InfoLine label="Unhealthy" value={String(health.data.accounts.unhealthy)} />
          </ReadOnlyCard>
        </div>
      ) : null}
    </AdminReadOnlyPage>
  );
}

function AdminReadOnlyPage({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="v11-admin-page">
      <header>
        <div>
          <p>{eyebrow}</p>
          <h1>{title}</h1>
          <span>Read-only organization view</span>
        </div>
      </header>
      {children}
    </section>
  );
}

function ReadOnlyCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <article className="v11-readonly-card">
      <h2>{title}</h2>
      {children}
    </article>
  );
}

function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="v11-info-line">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function InlineError({ copy }: { copy: string }) {
  return (
    <div className="inline-error" role="alert">
      <Icon name="activity" />
      <span>{copy}</span>
    </div>
  );
}

function RetryableQueryError({ copy, onRetry }: { copy: string; onRetry: () => void }) {
  return (
    <div>
      <InlineError copy={copy} />
      <button type="button" onClick={onRetry}>
        重试
      </button>
    </div>
  );
}

function InlineQueryState({ label }: { label: string }) {
  return (
    <div className="v11-inline-query-state" role="status">
      <span className="loader-ring" />
      <p>{label}</p>
    </div>
  );
}

function MutationNotice({
  pending,
  error,
  success = false,
}: {
  pending: boolean;
  error: unknown;
  success?: boolean;
}) {
  if (error) {
    return (
      <div className="v11-mutation-notice error" role="alert">
        <Icon name="activity" />
        <span>{error instanceof Error ? error.message : "请求失败，请重试。"}</span>
      </div>
    );
  }
  if (pending) {
    return (
      <div className="v11-mutation-notice" role="status">
        <span className="loader-ring" />
        <span>正在保存…</span>
      </div>
    );
  }
  if (success) {
    return (
      <div className="v11-mutation-notice success" role="status">
        <Icon name="check" />
        <span>已保存</span>
      </div>
    );
  }
  return null;
}

function runtimeErrorMessage(cause: unknown) {
  const message = cause instanceof Error ? cause.message : "请求失败，请稍后重试。";
  const code = cause instanceof ApiError ? cause.code : undefined;
  if (code === "ACTIVE_TURN_RESUME_CONFLICT" || message.includes("ACTIVE_TURN_RESUME_CONFLICT")) {
    return "当前仍有活动 Turn，无法恢复（ACTIVE_TURN_RESUME_CONFLICT）。请等待当前 Turn 完成或先停止。";
  }
  if (code === "NEEDS_RECOVERY" || message.includes("NEEDS_RECOVERY")) {
    return "Thread 需要先恢复运行环境（NEEDS_RECOVERY）。请稍后重试或联系管理员查看 Runtime health。";
  }
  return message;
}

function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span className={`status-badge status-${status.toLowerCase()}`}>
      <i />
      {statusLabel(status)}
    </span>
  );
}

function QueueBanner({
  position,
  etaMs,
  estimated,
}: {
  position: number;
  etaMs: number;
  estimated: boolean;
}) {
  return (
    <div className="queue-banner">
      <Icon name="clock" />
      <div>
        <strong>队列第 {position} 位</strong>
        <span>
          预计等待 {formatDuration(etaMs)}
          {estimated ? " · 估算" : ""}
        </span>
      </div>
    </div>
  );
}

function Avatar({ name }: { name: string }) {
  return (
    <span className="avatar" role="img" aria-label={`${name}的头像`}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function DiffView({ diff }: { diff: string }) {
  const occurrences = new Map<string, number>();
  const lines = diff
    .replace(/\.data\/real-runtime\/workspaces\/[^/]+\//g, "")
    .split("\n")
    .map((line) => {
      const occurrence = (occurrences.get(line) ?? 0) + 1;
      occurrences.set(line, occurrence);
      return { key: `${line}-${occurrence}`, line };
    });
  return (
    <pre className="diff-block">
      {lines.map(({ key, line }) => (
        <span
          className={line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-remove" : ""}
          key={key}
        >
          {line}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

function EmptyRail({ copy }: { copy: string }) {
  return (
    <div className="v11-empty-rail">
      <Icon name="spark" />
      <p>{copy}</p>
    </div>
  );
}

function FullPageState({ label }: { label: string }) {
  return (
    <div className="full-state" role="status">
      <span className="loader-ring" />
      <p>{label}</p>
    </div>
  );
}

function PageError({ title }: { title: string }) {
  return (
    <div className="page-error">
      <Icon name="shield" />
      <h1>{title}</h1>
      <Link to="/">返回工作台</Link>
    </div>
  );
}

function NotFoundPage() {
  return <PageError title="页面不存在" />;
}

function useApi(): PlatformApi {
  return useContext(ApiContext);
}

function projectStatus(
  base: TaskStatus,
  events: TaskEvent[],
  currentTurnId: string | null,
): TaskStatus {
  const projectedEvents = coalesceThreadEvents(events);
  const latestQueue = [...projectedEvents]
    .reverse()
    .find((event) => event.type === "QUEUED" || event.type === "LEASE_ACQUIRED");
  if (latestQueue?.type === "QUEUED") return "QUEUED";
  const activeTurnId =
    latestQueue?.turnId ??
    currentTurnId ??
    [...projectedEvents].reverse().find((event) => event.type === "TURN_STARTED")?.turnId;
  const relevant = [...projectedEvents]
    .reverse()
    .find((event) => event.turnId === activeTurnId && isStatusEvent(event));
  if (!relevant) return base;
  switch (relevant.type) {
    case "TURN_STARTED":
      return "RUNNING";
    case "TURN_COMPLETED":
      return "COMPLETED";
    case "TURN_FAILED":
      return "FAILED";
    case "TURN_INTERRUPTED":
      return "INTERRUPTED";
    case "RECOVERY_REQUIRED":
      return "NEEDS_RECOVERY";
    case "APPROVAL_REQUESTED":
      return "WAITING_APPROVAL";
    case "APPROVAL_DECIDED":
      return "RUNNING";
    default:
      return base;
  }
}

function isStatusEvent(event: TaskEvent): boolean {
  return [
    "QUEUED",
    "LEASE_ACQUIRED",
    "TURN_STARTED",
    "TURN_COMPLETED",
    "TURN_FAILED",
    "TURN_INTERRUPTED",
    "RECOVERY_REQUIRED",
    "APPROVAL_REQUESTED",
    "APPROVAL_DECIDED",
  ].includes(event.type);
}

function projectEventSubagents(events: TaskEvent[]): SubagentThread[] {
  const map = new Map<string, SubagentThread>();
  for (const event of events) {
    if (event.type !== "SUBAGENT_ACTIVITY") continue;
    const previous = map.get(event.payload.agentThreadId);
    map.set(event.payload.agentThreadId, {
      threadId: event.payload.agentThreadId,
      parentThreadId: event.threadId ?? event.taskId,
      parentTurnId: event.turnId,
      sessionId: null,
      name: event.payload.name ?? previous?.name ?? "Subagent",
      role: event.payload.role ?? previous?.role ?? "worker",
      model: event.payload.model,
      effort: event.payload.effort,
      status: event.payload.status,
      startedAt: previous?.startedAt ?? event.timestamp,
      completedAt: event.payload.status === "ACTIVE" ? null : event.timestamp,
      elapsedMs: Math.max(
        previous?.elapsedMs ?? 0,
        Math.max(
          0,
          new Date(event.timestamp).getTime() -
            new Date(previous?.startedAt ?? event.timestamp).getTime(),
        ),
      ),
      resultSummary: event.payload.resultSummary,
      tokenUsage: null,
    });
  }
  return [...map.values()];
}

function mergeSubagents(base: SubagentThread[], updates: SubagentThread[]): SubagentThread[] {
  const agents = new Map(base.map((agent) => [agent.threadId, agent]));
  for (const update of updates) {
    const previous = agents.get(update.threadId);
    if (previous && previous.status !== "ACTIVE" && update.status === "ACTIVE") {
      continue;
    }
    agents.set(
      update.threadId,
      previous
        ? {
            ...previous,
            ...update,
            sessionId: update.sessionId ?? previous.sessionId,
            model: update.model ?? previous.model,
            effort: update.effort ?? previous.effort,
            startedAt: previous.startedAt,
            elapsedMs: Math.max(previous.elapsedMs, update.elapsedMs),
            resultSummary: update.resultSummary ?? previous.resultSummary,
            tokenUsage: update.tokenUsage ?? previous.tokenUsage,
          }
        : update,
    );
  }
  return [...agents.values()];
}

function eventIdentity(event: TaskEvent): string {
  return `${event.taskId}:${event.threadId ?? "none"}:${event.turnId ?? "none"}:${event.itemId ?? "none"}:${event.sequence}`;
}

function toolDetailIdentity(tool: {
  taskId: string;
  threadId: string | null;
  turnId: string | null;
  itemId: string;
}): string {
  return `${tool.taskId}:${tool.threadId ?? "none"}:${tool.turnId ?? "none"}:${tool.itemId}`;
}

function toolStatusLabel(status: "IN_PROGRESS" | "COMPLETED" | "FAILED"): string {
  if (status === "COMPLETED") return "Completed";
  if (status === "FAILED") return "Failed";
  return "In progress";
}

function formatInspectorValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function approvalDecisionLabel(decision: string): string {
  switch (decision.toLowerCase()) {
    case "accept":
    case "accepted":
      return "已允许";
    case "decline":
    case "declined":
    case "reject":
    case "rejected":
      return "已拒绝";
    default:
      return "已处理";
  }
}

const EMPTY_COMPOSER_CAPABILITIES: ComposerCapability[] = [];

function permissionSelectionFromLegacy(
  mode: string | null | undefined,
): ExecutionPermissionSelection {
  if (mode === "APPROVE_FOR_ME") return { mode: "APPROVE_FOR_ME", profileId: null };
  if (mode === "FULL_ACCESS") return { mode: "FULL_ACCESS", profileId: null };
  return { mode: "ASK_FOR_APPROVAL", profileId: null };
}

function permissionModeForTurn(
  selection: ExecutionPermissionSelection,
): "ASK_FOR_APPROVAL" | "APPROVE_FOR_ME" | "FULL_ACCESS" {
  if (selection.mode === "CUSTOM") return "ASK_FOR_APPROVAL";
  return selection.mode;
}

function permissionOptions(
  allowedModes: readonly string[] | undefined,
): ExecutionPermissionOption[] {
  const allowed = new Set(allowedModes ?? ["ASK_FOR_APPROVAL"]);
  return [
    {
      mode: "ASK_FOR_APPROVAL",
      label: "Ask for approval",
      description: "Always ask to edit external files and use the internet",
      available: allowed.has("ASK_FOR_APPROVAL") || allowed.has("DEFAULT"),
      unavailableReason: "Disabled by organization policy",
    },
    {
      mode: "APPROVE_FOR_ME",
      label: "Approve for me",
      description: "Only ask for actions detected as potentially unsafe",
      available: allowed.has("APPROVE_FOR_ME"),
      unavailableReason: "Auto review is disabled by organization policy",
    },
    {
      mode: "FULL_ACCESS",
      label: "Full access",
      description: "Unrestricted access inside the isolated Worker",
      available: allowed.has("FULL_ACCESS"),
      unavailableReason: "Requires the isolated Worker production gate",
    },
    {
      mode: "CUSTOM",
      profileId: null,
      label: "Custom",
      description: "Uses an administrator-published permission profile",
      available: false,
      unavailableReason: "No permission profile is available",
    },
  ];
}

function applyComposerCapability(
  capability: ComposerCapability,
  setText: (update: (current: string) => string) => void,
): void {
  if (capability.kind !== "THREAD_REFERENCE" && capability.kind !== "SKILL") return;
  setText((current) => `${current}${current.trim() ? " " : ""}@${capability.label} `);
}

function deriveThreadTitle(prompt: string): string {
  const firstLine = prompt.trim().split("\n")[0]?.trim() ?? "";
  return firstLine.slice(0, 72) || "Untitled Thread";
}

function readPlanStep(item: unknown, index: number): { label: string } {
  if (typeof item === "object" && item !== null && "step" in item && typeof item.step === "string")
    return { label: item.step };
  return { label: typeof item === "string" ? item : `Step ${index + 1}` };
}

function extractDiffFiles(diff: string): string[] {
  return diff
    .split("\n")
    .flatMap((line) =>
      line.startsWith("+++ b/")
        ? [line.slice(6).replace(/^\.data\/real-runtime\/workspaces\/[^/]+\//, "")]
        : [],
    );
}

function formatElapsed(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${Math.round(milliseconds / 1_000)}s`;
  return `${Math.round(milliseconds / 60_000)}m`;
}

function statusLabel(status: TaskStatus): string {
  return {
    DRAFT: "草稿",
    READY: "待执行",
    QUEUED: "排队中",
    RUNNING: "执行中",
    WAITING_APPROVAL: "等待审批",
    COMPLETED: "已完成",
    FAILED: "失败",
    INTERRUPTED: "已停止",
    NEEDS_RECOVERY: "待恢复",
  }[status];
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 60_000) return "不到 1 分钟";
  return `约 ${Math.max(1, Math.round(milliseconds / 60_000))} 分钟`;
}

function formatDateTime(timestamp: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}
