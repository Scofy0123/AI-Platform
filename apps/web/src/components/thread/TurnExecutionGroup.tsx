import { type ReactNode, useEffect, useRef, useState } from "react";
import type { TranscriptGroup } from "../../thread-presentation.js";

export function TurnExecutionGroup({
  group,
  children,
}: {
  group: TranscriptGroup;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(group.defaultExpanded);
  const [now, setNow] = useState(() => Date.now());
  const userToggled = useRef(false);
  const terminal = isTerminalStatus(group.status);

  useEffect(() => {
    if (!userToggled.current) setExpanded(group.defaultExpanded);
  }, [group.defaultExpanded]);

  useEffect(() => {
    if (terminal) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [terminal]);

  const elapsedMs = terminal
    ? (group.durationMs ?? elapsedBetween(group.startedAt, group.completedAt))
    : elapsedSince(group.startedAt, now);
  const label = terminal
    ? `Worked for ${formatElapsed(elapsedMs)}`
    : `Working for ${formatElapsed(elapsedMs)} · ${group.currentAction}`;
  const contentId = `turn-execution-${safeDomId(group.id)}`;

  return (
    <section className={`codex-turn-execution codex-turn-execution--${statusClass(group.status)}`}>
      <button
        type="button"
        className="codex-turn-execution__toggle"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => {
          userToggled.current = true;
          setExpanded((value) => !value);
        }}
      >
        <span>{label}</span>
        <span aria-hidden="true">{expanded ? "⌄" : "›"}</span>
      </button>
      {expanded ? (
        <div className="codex-turn-execution__rows" id={contentId}>
          {children}
        </div>
      ) : null}
    </section>
  );
}

export function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function elapsedSince(startedAt: string | null, now: number): number {
  if (!startedAt) return 0;
  const started = Date.parse(startedAt);
  return Number.isFinite(started) ? Math.max(0, now - started) : 0;
}

function elapsedBetween(startedAt: string | null, completedAt: string | null): number {
  if (!startedAt || !completedAt) return 0;
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  return Number.isFinite(started) && Number.isFinite(completed)
    ? Math.max(0, completed - started)
    : 0;
}

function isTerminalStatus(status: TranscriptGroup["status"]): boolean {
  return ["COMPLETED", "FAILED", "INTERRUPTED", "NEEDS_RECOVERY", "ABANDONED_FOR_RESUME"].includes(
    status,
  );
}

function statusClass(status: TranscriptGroup["status"]): string {
  return status.toLowerCase().replaceAll("_", "-");
}

function safeDomId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "-");
}
