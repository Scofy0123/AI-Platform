import type { TaskEvent } from "@codexplatform/contracts";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createContext,
  type FormEvent,
  type ReactNode,
  useContext,
  useEffect,
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
} from "react-router-dom";
import { httpApi } from "./api.js";
import { subscribeTaskEvents } from "./event-stream.js";
import { Icon, type IconName } from "./icons.js";
import type {
  AccountSummary,
  PlatformApi,
  Session,
  TaskDetail,
  TaskEventSubscriber,
  TaskStatus,
} from "./types.js";

interface AppProps {
  api?: PlatformApi;
  initialEntries?: string[];
  subscribeToTaskEvents?: TaskEventSubscriber;
}

const ApiContext = createContext<PlatformApi>(httpApi);
const EventSubscriberContext = createContext<TaskEventSubscriber>(subscribeTaskEvents);
const TASK_SUMMARY_EVENT_TYPES = new Set<TaskEvent["type"]>([
  "QUEUED",
  "LEASE_ACQUIRED",
  "TURN_STARTED",
  "TURN_COMPLETED",
  "TURN_FAILED",
  "TURN_INTERRUPTED",
  "RECOVERY_REQUIRED",
  "APPROVAL_REQUESTED",
  "APPROVAL_DECIDED",
]);
const RESUMABLE_TASK_STATUSES = new Set<TaskStatus>([
  "COMPLETED",
  "FAILED",
  "INTERRUPTED",
  "NEEDS_RECOVERY",
]);
const APPROVAL_LOCKED_TASK_STATUSES = new Set<TaskStatus>([
  "COMPLETED",
  "FAILED",
  "INTERRUPTED",
  "NEEDS_RECOVERY",
]);

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

  if (initialEntries) {
    return <MemoryRouter initialEntries={initialEntries}>{content}</MemoryRouter>;
  }
  return <BrowserRouter>{content}</BrowserRouter>;
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

  if (session.isPending) return <FullPageState label="正在连接工作台" />;
  if (session.isError || !session.data.authenticated) return <Navigate to="/login" replace />;

  return <Workspace session={session.data} />;
}

function Workspace({ session }: { session: Session }) {
  return (
    <div className="app-shell">
      <Sidebar session={session} />
      <div className="app-stage">
        <Topbar session={session} />
        <main className="page-shell">
          <Routes>
            <Route path="/" element={<DashboardPage session={session} />} />
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="/tasks/new" element={<NewTaskPage />} />
            <Route path="/tasks/:taskId" element={<TaskPage />} />
            <Route
              path="/admin/accounts"
              element={
                <AdminGate session={session}>
                  <AccountsPage />
                </AdminGate>
              }
            />
            <Route
              path="/admin/audit"
              element={
                <AdminGate session={session}>
                  <AuditPage />
                </AdminGate>
              }
            />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

function LoginPage() {
  return (
    <main className="login-page">
      <div className="login-glow login-glow-one" />
      <div className="login-glow login-glow-two" />
      <section className="login-copy">
        <Brand />
        <div className="eyebrow">
          <span className="live-dot" /> 企业 AI 统一入口
        </div>
        <h1>让 AI 工作可见、可控、可追溯</h1>
        <p className="login-lead">
          在一个安全工作台内发起 Codex 任务，查看完整执行轨迹，并按你的飞书身份访问企业知识。
        </p>
        <div className="feature-row">
          <Feature icon="activity" title="过程透明" copy="计划、命令、工具与文件变更实时呈现" />
          <Feature icon="shield" title="权限隔离" copy="企业资源始终使用当前飞书用户权限" />
          <Feature icon="audit" title="全程审计" copy="从用户、任务到工具结果完整可追踪" />
        </div>
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
        <div className="login-trust">
          <Icon name="shield" /> 仅开放给已授权的企业成员
        </div>
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
      <span>
        <strong>Codex</strong>Platform
      </span>
    </Link>
  );
}

function Feature({ icon, title, copy }: { icon: IconName; title: string; copy: string }) {
  return (
    <div className="feature-item">
      <span className="feature-icon">
        <Icon name={icon} />
      </span>
      <div>
        <strong>{title}</strong>
        <span>{copy}</span>
      </div>
    </div>
  );
}

function Sidebar({ session }: { session: Session }) {
  return (
    <aside className="sidebar">
      <Brand />
      <nav className="sidebar-nav" aria-label="主导航">
        <NavItem to="/" icon="home" label="工作台" end />
        <NavItem to="/projects" icon="project" label="项目" />
        <NavItem to="/tasks" icon="clock" label="最近任务" />
        <div className="nav-label">管理</div>
        {session.user.role === "ADMIN" ? (
          <>
            <NavItem to="/admin/accounts" icon="bot" label="账号池" />
            <NavItem to="/admin/audit" icon="audit" label="审计记录" />
          </>
        ) : null}
      </nav>
      <div className="sidebar-bottom">
        <div className="runtime-card">
          <div>
            <span className="live-dot" />
            <strong>运行服务正常</strong>
          </div>
          <span>本机纵切环境</span>
        </div>
        <div className="identity-card">
          <Avatar name={session.user.name} />
          <div>
            <strong>{session.user.name}</strong>
            <span>{session.user.role === "ADMIN" ? "管理员" : "成员"}</span>
          </div>
          <Icon name="chevron" />
        </div>
      </div>
    </aside>
  );
}

function NavItem({
  to,
  icon,
  label,
  end = false,
}: {
  to: string;
  icon: IconName;
  label: string;
  end?: boolean;
}) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}>
      <Icon name={icon} />
      <span>{label}</span>
    </NavLink>
  );
}

function Topbar({ session }: { session: Session }) {
  return (
    <header className="topbar">
      <div className="mobile-brand">
        <Brand />
      </div>
      <div className="command-search">
        <Icon name="search" />
        <span>搜索任务或项目</span>
        <kbd>⌘ K</kbd>
      </div>
      <div className="topbar-actions">
        <span className="environment-pill">
          <span className="live-dot" /> LOCAL MVP
        </span>
        <Avatar name={session.user.name} />
      </div>
    </header>
  );
}

function DashboardPage({ session }: { session: Session }) {
  const api = useApi();
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.listProjects });
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: api.listTasks });
  const running = tasks.data?.filter((task) => task.status === "RUNNING").length ?? 0;
  const completed = tasks.data?.filter((task) => task.status === "COMPLETED").length ?? 0;

  return (
    <div className="page-stack">
      <section className="hero-row">
        <div>
          <p className="page-kicker">CODEx WORKSPACE</p>
          <h1>晚上好，{session.user.name}</h1>
          <p>今天想让 AI 帮你完成什么？</p>
        </div>
        <Link className="button button-primary" to="/tasks/new">
          <Icon name="plus" />
          新建任务
        </Link>
      </section>

      <section className="stats-grid" aria-label="任务概览">
        <MetricCard
          icon="activity"
          label="执行中"
          value={running}
          note="实时同步执行轨迹"
          tone="violet"
        />
        <MetricCard
          icon="check"
          label="已完成"
          value={completed}
          note="最近任务结果可复用"
          tone="green"
        />
        <MetricCard
          icon="project"
          label="项目"
          value={projects.data?.length ?? 0}
          note="按工作上下文组织"
          tone="blue"
        />
      </section>

      <section className="section-block">
        <SectionHeading
          title="你的项目"
          copy="用项目隔离上下文、文件和任务"
          action={<Link to="/projects">查看全部</Link>}
        />
        {projects.isPending ? (
          <CardSkeleton />
        ) : projects.isError ? (
          <InlineError />
        ) : (
          <div className="project-grid">
            {projects.data.map((project, index) => (
              <Link
                className="project-card"
                to={`/projects?selected=${project.id}`}
                key={project.id}
              >
                <span className={`project-icon project-icon-${index % 3}`}>
                  <Icon name="project" />
                </span>
                <div>
                  <h3>{project.name}</h3>
                  <p>
                    {project.taskCount} 个任务 · {relativeTime(project.updatedAt)}
                  </p>
                </div>
                <Icon className="card-arrow" name="chevron" />
              </Link>
            ))}
            <Link className="project-card project-card-new" to="/tasks/new">
              <span className="project-icon">
                <Icon name="plus" />
              </span>
              <div>
                <h3>开始新工作</h3>
                <p>创建任务并选择所属项目</p>
              </div>
            </Link>
          </div>
        )}
      </section>

      <section className="section-block">
        <SectionHeading
          title="最近任务"
          copy="继续上次工作，或查看已完成结果"
          action={<Link to="/tasks">查看全部</Link>}
        />
        {tasks.isPending ? (
          <CardSkeleton />
        ) : tasks.isError ? (
          <InlineError />
        ) : (
          <TaskList tasks={tasks.data.slice(0, 5)} />
        )}
      </section>
    </div>
  );
}

function ProjectsPage() {
  const api = useApi();
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.listProjects });
  return (
    <div className="page-stack">
      <PageHeading
        eyebrow="WORK CONTEXT"
        title="项目"
        copy="按业务目标组织任务和上下文。"
        action={
          <Link className="button button-primary" to="/tasks/new">
            <Icon name="plus" />
            新建任务
          </Link>
        }
      />
      {projects.isPending ? (
        <CardSkeleton />
      ) : projects.isError ? (
        <InlineError />
      ) : (
        <div className="project-grid project-grid-large">
          {projects.data.map((project, index) => (
            <article className="project-detail-card" key={project.id}>
              <span className={`project-icon project-icon-${index % 3}`}>
                <Icon name="project" />
              </span>
              <div className="project-detail-main">
                <h2>{project.name}</h2>
                <p>{project.taskCount} 个任务</p>
              </div>
              <div className="project-meta">
                <Icon name="clock" />
                {relativeTime(project.updatedAt)}
              </div>
              <Link to={`/tasks/new?project=${project.id}`}>
                在项目中发起任务 <Icon name="arrow" />
              </Link>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function TasksPage() {
  const api = useApi();
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: api.listTasks });
  return (
    <div className="page-stack">
      <PageHeading
        eyebrow="ACTIVITY"
        title="最近任务"
        copy="查看所有执行中、等待中和已完成的任务。"
        action={
          <Link className="button button-primary" to="/tasks/new">
            <Icon name="plus" />
            新建任务
          </Link>
        }
      />
      <section className="panel">
        <div className="filter-row">
          <button className="filter active" type="button">
            全部
          </button>
          <button className="filter" type="button">
            执行中
          </button>
          <button className="filter" type="button">
            已完成
          </button>
        </div>
        {tasks.isPending ? (
          <CardSkeleton />
        ) : tasks.isError ? (
          <InlineError />
        ) : (
          <TaskList tasks={tasks.data} />
        )}
      </section>
    </div>
  );
}

function NewTaskPage() {
  const api = useApi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.listProjects });
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [projectId, setProjectId] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: async () => {
      const selectedProjectId = projectId || projects.data?.[0]?.id;
      const targetProjectId = selectedProjectId ?? (await api.createProject("默认项目")).id;
      const task = await api.createTask({ title: title.trim(), projectId: targetProjectId });
      await api.startTurn(task.id, prompt.trim());
      return task;
    },
    onSuccess: async (task) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
        queryClient.invalidateQueries({ queryKey: ["tasks"] }),
      ]);
      navigate(`/tasks/${task.id}`);
    },
    onError: (error) => setSubmitError(error instanceof Error ? error.message : "任务创建失败"),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitError(null);
    if (!title.trim() || !prompt.trim()) {
      setSubmitError("请填写任务名称和任务说明");
      return;
    }
    create.mutate();
  };

  return (
    <div className="task-compose-page">
      <PageHeading
        eyebrow="NEW TASK"
        title="新建 AI 任务"
        copy="清晰描述目标，Codex 会先规划，再逐步执行。"
      />
      <form className="compose-card" onSubmit={submit}>
        <div className="form-row">
          <label htmlFor="task-title">任务名称</label>
          <input
            id="task-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="例如：整理本周客户成功周报"
          />
          <span>让名称便于在任务列表中识别</span>
        </div>
        <div className="form-row">
          <label htmlFor="task-project">所属项目</label>
          <select
            id="task-project"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="">不指定项目</option>
            {projects.data?.map((project) => (
              <option value={project.id} key={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label htmlFor="task-prompt">任务说明</label>
          <textarea
            id="task-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={9}
            placeholder="说明要达成的结果、可用资料和验收标准……"
          />
          <div className="prompt-hints">
            <span>
              <Icon name="file" />
              可要求读取飞书知识库
            </span>
            <span>
              <Icon name="database" />
              可查询演示数据库
            </span>
            <span>
              <Icon name="shield" />
              敏感操作会等待审批
            </span>
          </div>
        </div>
        {submitError ? (
          <p className="form-error" role="alert">
            {submitError}
          </p>
        ) : null}
        <div className="compose-actions">
          <Link className="button button-ghost" to="/">
            取消
          </Link>
          <button className="button button-primary" type="submit" disabled={create.isPending}>
            <Icon name={create.isPending ? "clock" : "play"} />
            {create.isPending ? "正在启动" : "开始执行"}
          </button>
        </div>
      </form>
    </div>
  );
}

function TaskPage() {
  const { taskId = "" } = useParams();
  const api = useApi();
  const queryClient = useQueryClient();
  const subscriber = useContext(EventSubscriberContext);
  const task = useQuery({
    queryKey: ["task", taskId],
    queryFn: () => api.getTask(taskId),
    enabled: Boolean(taskId),
  });
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const eventsRef = useRef<TaskEvent[]>([]);
  const [connection, setConnection] = useState<"connected" | "reconnecting">("connected");
  const [steer, setSteer] = useState("");
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const initialLastEventId =
    task.data?.events?.reduce((maximum, event) => Math.max(maximum, event.sequence), 0) ?? 0;

  useEffect(() => {
    eventsRef.current = eventsRef.current.filter((event) => event.taskId === taskId);
    setEvents((current) => current.filter((event) => event.taskId === taskId));
  }, [taskId]);

  useEffect(() => {
    if (!task.data?.events) return;
    const merged = mergeEvents(eventsRef.current, task.data.events);
    eventsRef.current = merged;
    setEvents(merged);
  }, [task.data?.events]);

  useEffect(() => {
    if (!taskId || !task.isSuccess) return undefined;
    return subscriber(
      taskId,
      (event) => {
        const merged = mergeEvents(eventsRef.current, [event]);
        eventsRef.current = merged;
        setEvents(merged);
        setConnection("connected");
        if (TASK_SUMMARY_EVENT_TYPES.has(event.type)) {
          queryClient.setQueryData<TaskDetail | undefined>(["task", taskId], (current) =>
            projectTaskDetail(current, event, merged),
          );
          void Promise.all([
            queryClient.invalidateQueries({ queryKey: ["task", taskId] }),
            queryClient.invalidateQueries({ queryKey: ["tasks"] }),
          ]);
        }
      },
      {
        initialLastEventId,
        onConnectionChange: (state) =>
          setConnection(state === "reconnecting" ? "reconnecting" : "connected"),
      },
    );
  }, [initialLastEventId, queryClient, subscriber, task.isSuccess, taskId]);

  const action = useMutation({
    mutationFn: ({ name, input }: { name: "interrupt" | "steer"; input?: string }) =>
      api.taskAction(taskId, name, input),
    onSuccess: () => {
      setActionMessage("操作已提交");
      void queryClient.invalidateQueries({ queryKey: ["task", taskId] });
    },
  });
  const resume = useMutation({
    mutationFn: () => api.startTurn(taskId, "继续执行当前任务"),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["task", taskId] });
    },
  });

  if (task.isPending) return <PageLoading />;
  if (task.isError) return <PageError title="无法打开任务" />;
  const canInterrupt = task.data.status === "RUNNING" || task.data.status === "WAITING_APPROVAL";
  const canResume = RESUMABLE_TASK_STATUSES.has(task.data.status);
  const approvalDecisions = new Map(
    events.flatMap((event) =>
      event.type === "APPROVAL_DECIDED"
        ? [[event.payload.approvalId, event.payload.decision] as const]
        : [],
    ),
  );
  const approvalsLocked = APPROVAL_LOCKED_TASK_STATUSES.has(task.data.status);
  const closedTurnIds = new Set(
    events.flatMap((event) =>
      event.turnId &&
      (event.type === "TURN_COMPLETED" ||
        event.type === "TURN_FAILED" ||
        event.type === "TURN_INTERRUPTED" ||
        event.type === "RECOVERY_REQUIRED")
        ? [event.turnId]
        : [],
    ),
  );
  const timelineEvents = coalesceTimelineEvents(events);

  return (
    <div className="task-page">
      <header className="task-header">
        <div className="task-heading-copy">
          <Link to="/tasks" className="back-link">
            最近任务 /
          </Link>
          <div className="task-title-line">
            <h1>{task.data.title}</h1>
            <StatusBadge status={task.data.status} />
          </div>
          <p>{task.data.prompt ?? "任务正在执行"}</p>
        </div>
        <div className="task-header-actions">
          <span className={`connection-state ${connection}`}>
            <span className="live-dot" />
            {connection === "connected" ? "实时同步" : "正在重连"}
          </span>
          <button
            className="button button-danger"
            type="button"
            onClick={() => action.mutate({ name: "interrupt" })}
            disabled={!canInterrupt || action.isPending}
          >
            <Icon name="pause" />
            停止
          </button>
          <button
            className="button button-secondary"
            type="button"
            onClick={() => resume.mutate()}
            disabled={!canResume || resume.isPending}
          >
            <Icon name="play" />
            继续
          </button>
        </div>
      </header>

      {task.data.queue ? (
        <QueueBanner
          position={task.data.queue.position}
          etaMs={task.data.queue.etaMs}
          estimated={task.data.queue.etaEstimated}
        />
      ) : null}

      <div className="task-layout">
        <section className="timeline-panel">
          <div className="timeline-heading">
            <div>
              <span className="live-dot" />
              <h2>执行时间线</h2>
            </div>
            <span>{events.length} 条事件</span>
          </div>
          {events.length === 0 ? (
            <div className="timeline-empty">
              <span className="loader-ring" />
              <h3>正在等待 Codex 响应</h3>
              <p>计划、命令和工具调用会实时出现在这里。</p>
            </div>
          ) : (
            <div className="timeline-list">
              {timelineEvents.map((event) => (
                <TimelineEvent
                  event={event}
                  api={api}
                  approvalDecision={
                    event.type === "APPROVAL_REQUESTED"
                      ? approvalDecisions.get(event.payload.approvalId)
                      : undefined
                  }
                  approvalsLocked={
                    approvalsLocked ||
                    (event.type === "APPROVAL_REQUESTED" &&
                      event.turnId !== null &&
                      closedTurnIds.has(event.turnId))
                  }
                  key={event.sequence}
                />
              ))}
            </div>
          )}
          <form
            className="steer-box"
            onSubmit={(event) => {
              event.preventDefault();
              if (!steer.trim()) return;
              action.mutate({ name: "steer", input: steer.trim() });
              setSteer("");
            }}
          >
            <Icon name="spark" />
            <label className="sr-only" htmlFor="steer-input">
              调整执行方向
            </label>
            <textarea
              id="steer-input"
              rows={2}
              value={steer}
              onChange={(event) => setSteer(event.target.value)}
              placeholder="补充要求，或调整接下来的执行方向……"
            />
            <button className="button button-primary" type="submit">
              <Icon name="send" />
              发送调整
            </button>
          </form>
          {actionMessage ? <span className="action-toast">{actionMessage}</span> : null}
        </section>

        <aside className="task-aside">
          <div className="aside-card">
            <h3>运行信息</h3>
            <InfoRow label="执行账号" value={task.data.accountAlias ?? "等待分配"} />
            <InfoRow label="任务状态" value={statusLabel(task.data.status)} />
            <InfoRow label="更新时间" value={formatTime(task.data.updatedAt)} />
          </div>
          <div className="aside-card safety-card">
            <span className="feature-icon">
              <Icon name="shield" />
            </span>
            <h3>身份隔离已启用</h3>
            <p>企业工具始终按当前飞书用户权限执行，共享运行账号不会扩大资源权限。</p>
          </div>
        </aside>
      </div>
    </div>
  );
}

function TimelineEvent({
  event,
  api,
  approvalDecision,
  approvalsLocked,
}: {
  event: TaskEvent;
  api: PlatformApi;
  approvalDecision?: string | undefined;
  approvalsLocked: boolean;
}) {
  const time = formatTime(event.timestamp);
  switch (event.type) {
    case "PLAN_UPDATED":
      return (
        <TimelineCard icon="grid" tone="violet" title="执行计划" time={time}>
          {event.payload.explanation ? <p>{event.payload.explanation}</p> : null}
          <ol className="plan-list">
            {event.payload.plan.map((item, index) => {
              const step = readPlanStep(item, index);
              return (
                <li className={step.status} key={step.id}>
                  <span>{step.status === "completed" ? "✓" : index + 1}</span>
                  {step.label}
                </li>
              );
            })}
          </ol>
        </TimelineCard>
      );
    case "COMMAND_STARTED":
    case "COMMAND_COMPLETED":
      return (
        <TimelineCard
          icon="terminal"
          tone="blue"
          title={event.type === "COMMAND_STARTED" ? "运行命令" : "命令完成"}
          time={time}
          badge={
            event.type === "COMMAND_COMPLETED"
              ? event.payload.exitCode === 0
                ? "成功"
                : `退出 ${event.payload.exitCode ?? "-"}`
              : undefined
          }
        >
          <pre className="command-block">
            <code>{event.payload.command}</code>
          </pre>
        </TimelineCard>
      );
    case "COMMAND_OUTPUT":
      return (
        <TimelineCard icon="terminal" tone="blue" title="命令输出" time={time}>
          <pre className="command-output">{event.payload.delta}</pre>
        </TimelineCard>
      );
    case "TOOL_STARTED":
    case "TOOL_COMPLETED":
    case "TOOL_FAILED":
      return (
        <TimelineCard
          icon="tool"
          tone={event.type === "TOOL_FAILED" ? "red" : "green"}
          title={
            event.type === "TOOL_STARTED"
              ? "调用企业工具"
              : event.type === "TOOL_FAILED"
                ? "工具调用失败"
                : "工具调用完成"
          }
          time={time}
        >
          <div className="tool-row">
            <span className="tool-name">{event.payload.tool}</span>
            <span>
              {event.type === "TOOL_COMPLETED" && event.payload.durationMs
                ? `${event.payload.durationMs} ms`
                : "按用户身份执行"}
            </span>
          </div>
          {event.type === "TOOL_FAILED" && event.payload.error ? (
            <p className="error-copy">{event.payload.error}</p>
          ) : null}
        </TimelineCard>
      );
    case "DIFF_UPDATED":
      return (
        <TimelineCard icon="code" tone="amber" title="文件变更" time={time}>
          <DiffView diff={event.payload.diff} />
        </TimelineCard>
      );
    case "APPROVAL_REQUESTED":
      return (
        <ApprovalEvent
          event={event}
          api={api}
          existingDecision={approvalDecision}
          locked={approvalsLocked}
        />
      );
    case "APPROVAL_DECIDED":
      return (
        <TimelineCard icon="check" tone="green" title="审批已处理" time={time}>
          <p>决策：{event.payload.decision}</p>
        </TimelineCard>
      );
    case "QUEUED":
      return (
        <QueueBanner
          position={event.payload.position}
          etaMs={event.payload.etaMs}
          estimated={event.payload.etaEstimated}
        />
      );
    case "AGENT_MESSAGE_DELTA":
      return (
        <TimelineCard icon="spark" tone="violet" title="Codex" time={time}>
          <p className="agent-copy">{event.payload.delta}</p>
        </TimelineCard>
      );
    case "REASONING_SUMMARY_DELTA":
      return (
        <TimelineCard icon="activity" tone="neutral" title="执行摘要" time={time}>
          <p>{event.payload.delta}</p>
        </TimelineCard>
      );
    case "TURN_STARTED":
      return (
        <TimelineCard icon="play" tone="violet" title="开始执行" time={time}>
          <p>已获取运行资源，正在处理任务。</p>
        </TimelineCard>
      );
    case "TURN_COMPLETED":
      return (
        <TimelineCard icon="check" tone="green" title="任务完成" time={time}>
          <p>本轮执行已完成。</p>
        </TimelineCard>
      );
    case "TURN_FAILED":
      return (
        <TimelineCard icon="activity" tone="red" title="执行失败" time={time}>
          <p className="error-copy">{event.payload.error}</p>
        </TimelineCard>
      );
    case "TURN_INTERRUPTED":
      return (
        <TimelineCard icon="pause" tone="amber" title="执行已停止" time={time}>
          <p>你可以调整要求后继续。</p>
        </TimelineCard>
      );
    case "LEASE_ACQUIRED":
      return (
        <TimelineCard icon="bot" tone="neutral" title="运行资源已就绪" time={time}>
          <p>已分配 {event.payload.accountAlias}</p>
        </TimelineCard>
      );
    case "RECOVERY_REQUIRED":
      return (
        <TimelineCard icon="activity" tone="red" title="需要恢复" time={time}>
          <p>{event.payload.reason}</p>
        </TimelineCard>
      );
  }
}

function ApprovalEvent({
  event,
  api,
  existingDecision,
  locked,
}: {
  event: Extract<TaskEvent, { type: "APPROVAL_REQUESTED" }>;
  api: PlatformApi;
  existingDecision?: string | undefined;
  locked: boolean;
}) {
  const [decision, setDecision] = useState<"accept" | "decline" | null>(null);
  const mutation = useMutation({
    mutationFn: (next: "accept" | "decline") => api.decideApproval(event.payload.approvalId, next),
    onSuccess: (_result, next) => setDecision(next),
  });
  const effectiveDecision = decision ?? existingDecision;
  return (
    <TimelineCard
      icon="shield"
      tone="amber"
      title="等待审批"
      time={formatTime(event.timestamp)}
      badge={event.payload.approvalType}
    >
      <p>{event.payload.reason ?? "Codex 请求执行受控操作"}</p>
      {event.payload.command ? (
        <pre className="command-block">
          <code>{event.payload.command}</code>
        </pre>
      ) : null}
      {effectiveDecision ? (
        <div className="approval-result">
          <Icon name="check" />已{approvalDecisionLabel(effectiveDecision)}
        </div>
      ) : (
        <div className="approval-actions">
          <button
            className="button button-primary button-small"
            type="button"
            onClick={() => mutation.mutate("accept")}
            disabled={locked || mutation.isPending}
          >
            允许一次
          </button>
          <button
            className="button button-ghost button-small"
            type="button"
            onClick={() => mutation.mutate("decline")}
            disabled={locked || mutation.isPending}
          >
            拒绝
          </button>
        </div>
      )}
    </TimelineCard>
  );
}

function TimelineCard({
  icon,
  tone,
  title,
  time,
  badge,
  children,
}: {
  icon: IconName;
  tone: string;
  title: string;
  time: string;
  badge?: string | undefined;
  children: ReactNode;
}) {
  return (
    <article className={`timeline-item tone-${tone}`}>
      <span className="timeline-node">
        <Icon name={icon} />
      </span>
      <div className="timeline-card">
        <header>
          <div>
            <h3>{title}</h3>
            {badge ? <span className="event-badge">{badge}</span> : null}
          </div>
          <time>{time}</time>
        </header>
        <div className="timeline-content">{children}</div>
      </div>
    </article>
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
      <span className="queue-icon">
        <Icon name="clock" />
      </span>
      <div>
        <strong>队列第 {position} 位</strong>
        <span>
          预计等待 {formatDuration(etaMs)}
          {estimated ? " · 估算" : ""}
        </span>
      </div>
      <span className="queue-pulse">
        <i />
        <i />
        <i />
      </span>
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
      name: "login" | "drain" | "quarantine" | "restore";
    }) => api.accountAction(id, name),
    onSuccess: (result) => {
      if (
        typeof result === "object" &&
        result !== null &&
        "authUrl" in result &&
        typeof result.authUrl === "string"
      ) {
        window.location.assign(result.authUrl);
        return;
      }
      void queryClient.invalidateQueries({ queryKey: ["accounts"] });
    },
  });
  return (
    <div className="page-stack">
      <PageHeading
        eyebrow="RUNTIME GOVERNANCE"
        title="Codex 账号池"
        copy="管理运行账号的容量、额度和健康状态。成员仅看到任务，不会看到账号内部信息。"
        action={
          <button className="button button-primary" type="button" onClick={() => setAdding(true)}>
            <Icon name="plus" />
            添加账号
          </button>
        }
      />
      {adding ? (
        <form
          className="account-add-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (alias.trim()) add.mutate();
          }}
        >
          <span className="account-mark">
            <Icon name="bot" />
          </span>
          <div>
            <label htmlFor="account-alias">账号别名</label>
            <input
              id="account-alias"
              value={alias}
              onChange={(event) => setAlias(event.target.value)}
              placeholder="例如：Codex 02"
            />
            <small>仅显示内部别名；保存后再由管理员完成交互认证。</small>
          </div>
          <button className="button button-ghost" type="button" onClick={() => setAdding(false)}>
            取消
          </button>
          <button
            className="button button-primary"
            type="submit"
            disabled={!alias.trim() || add.isPending}
          >
            保存账号
          </button>
        </form>
      ) : null}
      <section className="admin-summary">
        <div>
          <span className="summary-icon green">
            <Icon name="check" />
          </span>
          <strong>
            {accounts.data?.filter((item) => item.status === "AVAILABLE").length ?? 0}
          </strong>
          <small>可用账号</small>
        </div>
        <div>
          <span className="summary-icon violet">
            <Icon name="user" />
          </span>
          <strong>{accounts.data?.reduce((sum, item) => sum + item.activeUsers, 0) ?? 0}</strong>
          <small>活跃用户</small>
        </div>
        <div>
          <span className="summary-icon blue">
            <Icon name="activity" />
          </span>
          <strong>
            {accounts.data?.length
              ? Math.round(
                  accounts.data.reduce((sum, item) => sum + item.health, 0) / accounts.data.length,
                )
              : 0}
            %
          </strong>
          <small>平均健康度</small>
        </div>
      </section>
      {accounts.isPending ? (
        <CardSkeleton />
      ) : accounts.isError ? (
        <InlineError />
      ) : (
        <div className="accounts-grid">
          {accounts.data.map((account) => (
            <AccountCard
              account={account}
              onAction={(name) => action.mutate({ id: account.id, name })}
              key={account.id}
            />
          ))}
        </div>
      )}
      <div className="governance-note">
        <Icon name="shield" />
        <div>
          <strong>共享账号安全边界</strong>
          <p>
            运行账号只承担模型执行；企业系统访问始终使用发起任务的飞书用户身份，并逐项记录审计。
          </p>
        </div>
      </div>
    </div>
  );
}

function AccountCard({
  account,
  onAction,
}: {
  account: AccountSummary;
  onAction: (action: "login" | "drain" | "quarantine" | "restore") => void;
}) {
  const quota = account.weeklyRemainingPercent;
  return (
    <article className="account-card">
      <header>
        <div className="account-identity">
          <span className="account-mark">
            <Icon name="bot" />
          </span>
          <div>
            <h2>{account.alias}</h2>
            <StatusPill status={account.status} />
          </div>
        </div>
        <button className="icon-button" type="button" aria-label="账号设置">
          <Icon name="settings" />
        </button>
      </header>
      <div className="capacity-block">
        <div>
          <span>活跃用户</span>
          <strong>
            {account.activeUsers} / {account.maxUsers}
          </strong>
        </div>
        <div className="capacity-track">
          <i
            style={{ width: `${Math.min(100, (account.activeUsers / account.maxUsers) * 100)}%` }}
          />
        </div>
      </div>
      <div className="account-metrics">
        <div>
          <span>周额度</span>
          <strong>{quota === null ? "待确认" : `周额度剩余 ${quota}%`}</strong>
        </div>
        <div>
          <span>健康度</span>
          <strong className="healthy">{account.health}%</strong>
        </div>
      </div>
      <div className="quota-track">
        <i style={{ width: `${quota ?? 0}%` }} />
      </div>
      <footer>
        {account.status === "DRAINING" || account.status === "QUARANTINED" ? (
          <button
            className="button button-secondary button-small"
            type="button"
            onClick={() => onAction("restore")}
          >
            恢复
          </button>
        ) : (
          <button
            className="button button-ghost button-small"
            type="button"
            onClick={() => onAction("drain")}
          >
            排空
          </button>
        )}
        <button
          className="button button-ghost button-small"
          type="button"
          onClick={() => onAction("login")}
        >
          重新认证
        </button>
      </footer>
    </article>
  );
}

function AuditPage() {
  const api = useApi();
  const audit = useQuery({ queryKey: ["audit"], queryFn: api.listAudit });
  return (
    <div className="page-stack">
      <PageHeading
        eyebrow="TRACEABILITY"
        title="审计记录"
        copy="从飞书用户追踪到任务、运行账号、工具和结果。"
      />
      <section className="panel audit-panel">
        <div className="audit-toolbar">
          <div className="search-field">
            <Icon name="search" />
            <input aria-label="搜索审计记录" placeholder="搜索用户、动作或资源" />
          </div>
          <button className="button button-secondary" type="button">
            <Icon name="clock" />
            最近 7 天
          </button>
        </div>
        {audit.isPending ? (
          <CardSkeleton />
        ) : audit.isError ? (
          <InlineError />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>用户</th>
                  <th>动作</th>
                  <th>资源</th>
                  <th>运行账号</th>
                  <th>结果</th>
                </tr>
              </thead>
              <tbody>
                {audit.data.map((entry) => (
                  <tr key={entry.id}>
                    <td>{formatDateTime(entry.timestamp)}</td>
                    <td>
                      <span className="table-user">
                        <Avatar name={entry.actorName} />
                        {entry.actorName}
                      </span>
                    </td>
                    <td>
                      <code className="action-code">{entry.action}</code>
                    </td>
                    <td>{entry.resource}</td>
                    <td>{entry.accountAlias ?? "—"}</td>
                    <td>
                      <span className="result-pill">
                        <Icon name="check" />
                        {entry.result}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function AdminGate({ session, children }: { session: Session; children: ReactNode }) {
  return session.user.role === "ADMIN" ? children : <PageError title="无权访问管理功能" />;
}

function TaskList({
  tasks,
}: {
  tasks: Array<{ id: string; title: string; status: TaskStatus; updatedAt: string }>;
}) {
  if (tasks.length === 0)
    return <EmptyState title="还没有任务" copy="创建第一个任务，让 Codex 开始工作。" />;
  return (
    <div className="task-list">
      {tasks.map((task) => (
        <Link className="task-row" to={`/tasks/${task.id}`} key={task.id}>
          <span className={`task-status-icon status-${task.status.toLowerCase()}`}>
            <Icon
              name={
                task.status === "COMPLETED"
                  ? "check"
                  : task.status === "RUNNING"
                    ? "activity"
                    : "clock"
              }
            />
          </span>
          <div className="task-row-main">
            <h3>{task.title}</h3>
            <p>{relativeTime(task.updatedAt)}</p>
          </div>
          <StatusBadge status={task.status} />
          <Icon className="card-arrow" name="chevron" />
        </Link>
      ))}
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
  note,
  tone,
}: {
  icon: IconName;
  label: string;
  value: number;
  note: string;
  tone: string;
}) {
  return (
    <article className="metric-card">
      <span className={`metric-icon ${tone}`}>
        <Icon name={icon} />
      </span>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
        <span>{note}</span>
      </div>
    </article>
  );
}

function PageHeading({
  eyebrow,
  title,
  copy,
  action,
}: {
  eyebrow: string;
  title: string;
  copy: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-heading">
      <div>
        <p className="page-kicker">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{copy}</p>
      </div>
      {action}
    </header>
  );
}

function SectionHeading({
  title,
  copy,
  action,
}: {
  title: string;
  copy: string;
  action?: ReactNode;
}) {
  return (
    <header className="section-heading">
      <div>
        <h2>{title}</h2>
        <p>{copy}</p>
      </div>
      {action}
    </header>
  );
}

function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span className={`status-badge status-${status.toLowerCase()}`}>
      <i />
      {statusLabel(status)}
    </span>
  );
}

function StatusPill({ status }: { status: AccountSummary["status"] }) {
  const labels: Record<AccountSummary["status"], string> = {
    AVAILABLE: "可用",
    FULL: "已满",
    COOLDOWN: "冷却中",
    EXHAUSTED: "额度已用尽",
    REAUTH_REQUIRED: "需要认证",
    DRAINING: "排空中",
    QUARANTINED: "已隔离",
  };
  return (
    <span className={`account-status account-status-${status.toLowerCase()}`}>
      <i />
      {labels[status]}
    </span>
  );
}

function Avatar({ name }: { name: string }) {
  return (
    <span className="avatar" role="img" aria-label={`${name}的头像`}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DiffView({ diff }: { diff: string }) {
  const occurrences = new Map<string, number>();
  const lines = diff.split("\n").map((line) => {
    const occurrence = (occurrences.get(line) ?? 0) + 1;
    occurrences.set(line, occurrence);
    return { line, key: `${line}-${occurrence}` };
  });
  return (
    <pre className="diff-block">
      {lines.map(({ line, key }) => (
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

function FullPageState({ label }: { label: string }) {
  return (
    <main className="full-state">
      <span className="loader-ring" />
      <p>{label}</p>
    </main>
  );
}

function PageLoading() {
  return (
    <div className="page-loading">
      <span className="loader-ring" />
      <p>正在加载任务</p>
    </div>
  );
}
function CardSkeleton() {
  return (
    <div className="card-skeleton">
      <i />
      <i />
      <i />
    </div>
  );
}
function InlineError() {
  return (
    <div className="inline-error">
      <Icon name="activity" />
      <span>数据加载失败，请稍后重试。</span>
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
function EmptyState({ title, copy }: { title: string; copy: string }) {
  return (
    <div className="empty-state">
      <Icon name="spark" />
      <h3>{title}</h3>
      <p>{copy}</p>
    </div>
  );
}
function NotFoundPage() {
  return <PageError title="页面不存在" />;
}

function useApi(): PlatformApi {
  return useContext(ApiContext);
}

function mergeEvents(current: TaskEvent[], incoming: TaskEvent[]): TaskEvent[] {
  const bySequence = new Map(current.map((event) => [event.sequence, event]));
  for (const event of incoming) bySequence.set(event.sequence, event);
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
}

function coalesceTimelineEvents(events: TaskEvent[]): TaskEvent[] {
  const timeline: TaskEvent[] = [];
  for (const event of events) {
    const previous = timeline.at(-1);
    if (
      isTimelineDeltaEvent(event) &&
      isTimelineDeltaEvent(previous) &&
      previous.type === event.type &&
      previous.taskId === event.taskId &&
      previous.threadId === event.threadId &&
      previous.turnId === event.turnId &&
      previous.payload.itemId === event.payload.itemId
    ) {
      timeline[timeline.length - 1] = {
        ...previous,
        payload: {
          ...previous.payload,
          delta: previous.payload.delta + event.payload.delta,
        },
      };
      continue;
    }
    timeline.push(event);
  }
  return timeline;
}

type TimelineDeltaEvent = Extract<
  TaskEvent,
  { type: "AGENT_MESSAGE_DELTA" | "REASONING_SUMMARY_DELTA" | "COMMAND_OUTPUT" }
>;

function isTimelineDeltaEvent(event: TaskEvent | undefined): event is TimelineDeltaEvent {
  return (
    event?.type === "AGENT_MESSAGE_DELTA" ||
    event?.type === "REASONING_SUMMARY_DELTA" ||
    event?.type === "COMMAND_OUTPUT"
  );
}

function projectTaskDetail(
  current: TaskDetail | undefined,
  event: TaskEvent,
  timeline: TaskEvent[],
): TaskDetail | undefined {
  if (!current) return current;
  switch (event.type) {
    case "QUEUED":
      return {
        ...current,
        status: "QUEUED",
        queue: {
          position: event.payload.position,
          etaMs: event.payload.etaMs,
          etaEstimated: event.payload.etaEstimated,
        },
        updatedAt: event.timestamp,
      };
    case "LEASE_ACQUIRED":
      return {
        ...current,
        accountAlias: event.payload.accountAlias,
        queue: null,
        updatedAt: event.timestamp,
      };
    case "TURN_STARTED":
      if (!targetsCurrentAllocatedTurn(event, timeline)) return current;
      return { ...current, status: "RUNNING", queue: null, updatedAt: event.timestamp };
    case "TURN_COMPLETED":
      if (!targetsCurrentAllocatedTurn(event, timeline)) return current;
      return { ...current, status: "COMPLETED", updatedAt: event.timestamp };
    case "TURN_FAILED":
      if (!targetsCurrentAllocatedTurn(event, timeline)) return current;
      return { ...current, status: "FAILED", updatedAt: event.timestamp };
    case "TURN_INTERRUPTED":
      if (!targetsCurrentAllocatedTurn(event, timeline)) return current;
      return { ...current, status: "INTERRUPTED", updatedAt: event.timestamp };
    case "RECOVERY_REQUIRED":
      if (!targetsCurrentAllocatedTurn(event, timeline)) return current;
      return { ...current, status: "NEEDS_RECOVERY", updatedAt: event.timestamp };
    case "APPROVAL_REQUESTED":
      if (!targetsCurrentAllocatedTurn(event, timeline)) return current;
      if (APPROVAL_LOCKED_TASK_STATUSES.has(current.status)) return current;
      return { ...current, status: "WAITING_APPROVAL", updatedAt: event.timestamp };
    case "APPROVAL_DECIDED":
      if (!targetsCurrentAllocatedTurn(event, timeline)) return current;
      if (APPROVAL_LOCKED_TASK_STATUSES.has(current.status)) return current;
      return { ...current, status: "RUNNING", updatedAt: event.timestamp };
    default:
      return current;
  }
}

function targetsCurrentAllocatedTurn(event: TaskEvent, timeline: TaskEvent[]): boolean {
  if (!event.turnId) return false;
  const latestAllocation = timeline.reduce<TaskEvent | null>(
    (latest, candidate) =>
      (candidate.type === "QUEUED" || candidate.type === "LEASE_ACQUIRED") &&
      (!latest || candidate.sequence > latest.sequence)
        ? candidate
        : latest,
    null,
  );
  if (latestAllocation?.type === "QUEUED") return false;
  if (latestAllocation?.type === "LEASE_ACQUIRED") {
    return latestAllocation.turnId === event.turnId;
  }
  const latestStarted = timeline.reduce<TaskEvent | null>(
    (latest, candidate) =>
      candidate.type === "TURN_STARTED" &&
      candidate.turnId &&
      (!latest || candidate.sequence > latest.sequence)
        ? candidate
        : latest,
    null,
  );
  return latestStarted?.turnId === event.turnId;
}

function approvalDecisionLabel(decision: string): string {
  switch (decision.toLowerCase()) {
    case "accept":
    case "accepted":
      return "允许";
    case "decline":
    case "declined":
    case "reject":
    case "rejected":
      return "拒绝";
    default:
      return "处理";
  }
}

function readPlanStep(item: unknown, index: number): { id: string; label: string; status: string } {
  if (typeof item === "object" && item !== null) {
    const record = item as Record<string, unknown>;
    const label = typeof record.step === "string" ? record.step : `步骤 ${index + 1}`;
    const status = typeof record.status === "string" ? record.status : "pending";
    return {
      id: typeof record.id === "string" ? record.id : `${status}-${label}`,
      label,
      status,
    };
  }
  return { id: `pending-${String(item)}`, label: String(item), status: "pending" };
}

function statusLabel(status: TaskStatus): string {
  const labels: Record<TaskStatus, string> = {
    DRAFT: "草稿",
    READY: "待执行",
    QUEUED: "排队中",
    RUNNING: "执行中",
    WAITING_APPROVAL: "等待审批",
    COMPLETED: "已完成",
    FAILED: "失败",
    INTERRUPTED: "已停止",
    NEEDS_RECOVERY: "待恢复",
  };
  return labels[status];
}

function relativeTime(timestamp: string): string {
  const delta = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(delta) || delta < 0) return formatDateTime(timestamp);
  if (delta < 60_000) return "刚刚更新";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return `${Math.floor(delta / 86_400_000)} 天前`;
}

function formatTime(timestamp: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
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

function formatDuration(milliseconds: number): string {
  if (milliseconds < 60_000) return "不到 1 分钟";
  return `约 ${Math.max(1, Math.round(milliseconds / 60_000))} 分钟`;
}
