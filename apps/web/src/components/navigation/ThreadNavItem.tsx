import { NavLink } from "react-router-dom";
import type { TaskStatus } from "../../types.js";

const ACTIVE_THREAD_STATUSES = new Set<TaskStatus>(["QUEUED", "RUNNING", "WAITING_APPROVAL"]);

export function isActiveThreadStatus(status: TaskStatus) {
  return ACTIVE_THREAD_STATUSES.has(status);
}

export function ThreadNavItem({
  id,
  title,
  status,
}: {
  id: string;
  title: string;
  status: TaskStatus;
}) {
  const active = isActiveThreadStatus(status);
  return (
    <NavLink className="v11-thread-nav-item" to={`/threads/${id}`}>
      <span className="v11-thread-nav-title">{title}</span>
      {active ? (
        <span className="v11-thread-running-ring" role="status" aria-label="任务正在运行" />
      ) : null}
    </NavLink>
  );
}
