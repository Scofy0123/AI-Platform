import type { ReactNode } from "react";
import type {
  TranscriptApprovalRow,
  TranscriptGroup,
  TranscriptRow,
} from "../../thread-presentation.js";
import type { BottomPanelTab, SidePanelTab } from "../../workspace-layout.js";
import { SafeMarkdown } from "./SafeMarkdown.js";
import { TurnExecutionGroup } from "./TurnExecutionGroup.js";

interface TranscriptProps {
  groups: TranscriptGroup[];
  busy?: boolean;
  onOpenBottom(tab: BottomPanelTab, itemId: string): void;
  onOpenSide(tab: SidePanelTab): void;
  onOpenSubagent?(threadId: string): void;
  renderApproval(row: TranscriptApprovalRow): ReactNode;
}

export function Transcript({
  groups,
  busy,
  onOpenBottom,
  onOpenSide,
  onOpenSubagent,
  renderApproval,
}: TranscriptProps) {
  if (groups.every((group) => group.rows.length === 0)) {
    return (
      <div className="v11-waiting" role="log" aria-live="polite" aria-busy={busy}>
        <span className="loader-ring" />
        <p>Waiting for Codex…</p>
      </div>
    );
  }
  return (
    <div className="codex-transcript" role="log" aria-live="polite" aria-busy={busy}>
      {groups.map((group) => (
        <section className="codex-transcript-turn" key={group.id}>
          {group.prompt ? (
            <TranscriptRowView
              row={group.prompt}
              onOpenBottom={onOpenBottom}
              onOpenSide={onOpenSide}
              {...(onOpenSubagent ? { onOpenSubagent } : {})}
              renderApproval={renderApproval}
            />
          ) : null}
          {group.status === "UNKNOWN" && group.prompt === null && group.finalAnswer === null ? (
            group.executionRows.map((row) => (
              <TranscriptRowView
                row={row}
                onOpenBottom={onOpenBottom}
                onOpenSide={onOpenSide}
                {...(onOpenSubagent ? { onOpenSubagent } : {})}
                renderApproval={renderApproval}
                key={row.id}
              />
            ))
          ) : (
            <TurnExecutionGroup group={group}>
              {group.executionRows.map((row) => (
                <TranscriptRowView
                  row={row}
                  onOpenBottom={onOpenBottom}
                  onOpenSide={onOpenSide}
                  {...(onOpenSubagent ? { onOpenSubagent } : {})}
                  renderApproval={renderApproval}
                  key={row.id}
                />
              ))}
            </TurnExecutionGroup>
          )}
          {group.finalAnswer ? (
            <div className="codex-turn-final-answer">
              <TranscriptRowView
                row={group.finalAnswer}
                onOpenBottom={onOpenBottom}
                onOpenSide={onOpenSide}
                {...(onOpenSubagent ? { onOpenSubagent } : {})}
                renderApproval={renderApproval}
              />
            </div>
          ) : null}
        </section>
      ))}
    </div>
  );
}

function TranscriptRowView({
  row,
  onOpenBottom,
  onOpenSide,
  onOpenSubagent,
  renderApproval,
}: {
  row: TranscriptRow;
  onOpenBottom(tab: BottomPanelTab, itemId: string): void;
  onOpenSide(tab: SidePanelTab): void;
  onOpenSubagent?(threadId: string): void;
  renderApproval(row: TranscriptApprovalRow): ReactNode;
}) {
  switch (row.kind) {
    case "user":
      {
        const steer = !row.itemId.startsWith("user:");
        return (
          <article
            className={`v11-user-message${steer ? " v11-steer-message" : ""}`}
            data-message-side="right"
            data-message-kind={steer ? "steer" : "prompt"}
          >
            {steer ? <div className="v11-message-label">Steer</div> : null}
            <SafeMarkdown content={row.text} />
          </article>
        );
      }
    case "assistant":
      return (
        <article className="codex-transcript-assistant">
          <SafeMarkdown content={row.text} />
        </article>
      );
    case "reasoning-summary":
      return (
        <details className="codex-reasoning-summary" open>
          <summary>执行思路</summary>
          <SafeMarkdown content={row.text} />
        </details>
      );
    case "plan":
      return (
        <article className="codex-plan-update">
          <strong>已更新计划</strong>
          {row.explanation ? <span>{row.explanation}</span> : null}
        </article>
      );
    case "command":
      return (
        <ActivityButton
          actionLabel="查看命令"
          label={`${commandStatusLabel(row.status)} ${row.command ?? "命令"}`}
          detail={durationLabel(row.durationMs)}
          onClick={() => onOpenBottom("terminal", row.id)}
        />
      );
    case "tool":
      return (
        <ActivityButton
          actionLabel="查看工具"
          label={`${toolStatusLabel(row.status)} ${row.tool}`}
          detail={durationLabel(row.durationMs)}
          onClick={() => onOpenSide({ kind: "tool", detailId: row.id })}
        />
      );
    case "diff":
      return (
        <ActivityButton
          actionLabel="查看文件变更"
          label={row.text}
          onClick={() => onOpenSide({ kind: "changes", detailId: row.id })}
        />
      );
    case "subagent":
      return onOpenSubagent ? (
        <ActivityButton
          actionLabel="查看子 Agent"
          label={row.name ? `${row.name} · ${subagentStatusLabel(row.status)}` : row.text}
          detail={row.resultSummary}
          onClick={() => onOpenSubagent(row.agentThreadId)}
        />
      ) : (
        <ActivityLine
          label={row.name ? `${row.name} · ${subagentStatusLabel(row.status)}` : row.text}
          detail={row.resultSummary}
        />
      );
    case "approval":
      return renderApproval(row);
    case "status":
      return (
        <div className={`codex-status-line ${row.status}`} role="status">
          <span aria-hidden="true" />
          {statusLabel(row.status, row.text)}
        </div>
      );
  }
}

function ActivityLine({ label, detail }: { label: string; detail?: string | null }) {
  return (
    <div className="codex-activity-row codex-activity-row-readonly">
      <span aria-hidden="true">⌁</span>
      <strong>{label}</strong>
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}

function ActivityButton({
  actionLabel,
  label,
  detail,
  onClick,
}: {
  actionLabel: string;
  label: string;
  detail?: string | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="codex-activity-row"
      aria-label={[actionLabel, label, detail].filter(Boolean).join(" ")}
      onClick={onClick}
    >
      <span aria-hidden="true">⌁</span>
      <strong>{label}</strong>
      {detail ? <small>{detail}</small> : null}
    </button>
  );
}

function durationLabel(durationMs: number | null) {
  if (durationMs === null) return null;
  if (durationMs < 1_000) return `${durationMs} ms`;
  return `${(durationMs / 1_000).toFixed(1)} s`;
}

function commandStatusLabel(status: "running" | "completed" | "failed") {
  if (status === "running") return "正在运行";
  if (status === "failed") return "命令失败";
  return "已运行";
}

function toolStatusLabel(status: "running" | "completed" | "failed") {
  if (status === "running") return "正在调用";
  if (status === "failed") return "调用失败";
  return "已调用";
}

function subagentStatusLabel(status: string) {
  return status === "ACTIVE" ? "Working" : status === "DONE" ? "Done" : status;
}

function statusLabel(status: string, fallback: string) {
  switch (status) {
    case "running":
      return "Codex 正在工作";
    case "completed":
      return "本轮已完成";
    case "failed":
      return fallback;
    case "interrupted":
      return "执行已停止";
    case "queued":
      return fallback;
    case "allocated":
      return "运行资源已就绪";
    case "recovery-required":
      return fallback;
    default:
      return fallback;
  }
}
