import type { ComposerCapability } from "@codexplatform/contracts";
import { useRef, useState } from "react";
import { Icon } from "../../icons.js";
import { useDismissiblePopover } from "./useDismissiblePopover.js";

interface ComposerAddMenuProps {
  capabilities: readonly ComposerCapability[];
  onChooseFiles(files: readonly File[]): void;
  onOpenGoal(): void;
  onTogglePlanMode(): void;
  planMode: boolean;
  planLockedReason?: "ACTIVE_TURN" | "QUEUED" | "POLICY" | null;
  disabled?: boolean;
}

const LOCK_COPY = {
  ACTIVE_TURN: "当前 Turn 执行中，Plan mode 已锁定",
  QUEUED: "当前 Turn 正在排队，Plan mode 已锁定",
  POLICY: "组织策略已锁定 Plan mode",
} as const;

const CORE_KINDS = new Set<ComposerCapability["kind"]>(["FILE_PICKER", "GOAL", "PLAN_MODE"]);

export function ComposerAddMenu({
  capabilities,
  onChooseFiles,
  onOpenGoal,
  onTogglePlanMode,
  planMode,
  planLockedReason = null,
  disabled = false,
}: ComposerAddMenuProps) {
  const { close, open, rootRef, toggle, triggerRef } = useDismissiblePopover<HTMLDivElement>();
  const [view, setView] = useState<"ROOT" | "FILES">("ROOT");
  const filesInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const coreCapabilities = capabilities.filter(
    (capability) => capability.section === "ADD" && CORE_KINDS.has(capability.kind),
  );

  const dismiss = () => {
    setView("ROOT");
    close({ restoreFocus: true });
  };
  const acceptFiles = (files: FileList | null) => {
    const selected = Array.from(files ?? []);
    if (selected.length === 0) return;
    onChooseFiles(selected);
    dismiss();
  };

  return (
    <div ref={rootRef} className="composer-add-menu">
      <button
        ref={triggerRef}
        type="button"
        className="composer-add-trigger"
        aria-label="Add files and more"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          setView("ROOT");
          toggle();
        }}
      >
        <Icon name="plus" />
      </button>
      {open ? (
        <div className="composer-add-popover" role="menu">
          <section aria-label="Add">
            <h3>{view === "ROOT" ? "Add" : "Files and folders"}</h3>
            {view === "FILES" ? (
              <>
                <button
                  type="button"
                  role="menuitem"
                  aria-label="Choose files"
                  onClick={() => filesInputRef.current?.click()}
                >
                  <Icon name="file" />
                  <span>
                    <strong>Choose files</strong>
                    <small>Select one or more files</small>
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  aria-label="Choose folder"
                  onClick={() => folderInputRef.current?.click()}
                >
                  <Icon name="project" />
                  <span>
                    <strong>Choose folder</strong>
                    <small>Keep the folder structure</small>
                  </span>
                </button>
                <input
                  ref={filesInputRef}
                  hidden
                  multiple
                  type="file"
                  aria-label="Choose files input"
                  onChange={(event) => acceptFiles(event.currentTarget.files)}
                />
                <input
                  ref={folderInputRef}
                  hidden
                  multiple
                  type="file"
                  aria-label="Choose folder input"
                  // React does not type the Chromium directory picker attribute.
                  {...({ webkitdirectory: "" } as Record<string, string>)}
                  onChange={(event) => acceptFiles(event.currentTarget.files)}
                />
              </>
            ) : (
              coreCapabilities.map((capability) => {
                const unavailable = capability.availability !== "AVAILABLE";
                const planLocked = capability.kind === "PLAN_MODE" && Boolean(planLockedReason);
                const menuRoleProps =
                  capability.kind === "PLAN_MODE"
                    ? ({ role: "menuitemcheckbox", "aria-checked": planMode } as const)
                    : ({ role: "menuitem" } as const);
                return (
                  <button
                    type="button"
                    {...menuRoleProps}
                    aria-label={`${capability.label} — ${capability.description}`}
                    disabled={unavailable || planLocked}
                    key={capability.id}
                    onClick={() => {
                      if (unavailable || planLocked) return;
                      if (capability.kind === "FILE_PICKER") {
                        setView("FILES");
                        return;
                      }
                      dismiss();
                      if (capability.kind === "GOAL") onOpenGoal();
                      if (capability.kind === "PLAN_MODE") onTogglePlanMode();
                    }}
                  >
                    <Icon name={capabilityIcon(capability.kind)} />
                    <span>
                      <strong>
                        {capability.label}
                        {capability.kind === "PLAN_MODE" && planMode ? " · On" : ""}
                      </strong>
                      <small>{capability.description}</small>
                      {planLockedReason && capability.kind === "PLAN_MODE" ? (
                        <em>{LOCK_COPY[planLockedReason]}</em>
                      ) : capability.unavailableReason ? (
                        <em>{capability.unavailableReason}</em>
                      ) : null}
                    </span>
                    {capability.kind === "PLAN_MODE" && planMode ? <Icon name="check" /> : null}
                  </button>
                );
              })
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}

function capabilityIcon(kind: ComposerCapability["kind"]) {
  if (kind === "FILE_PICKER") return "file" as const;
  if (kind === "GOAL") return "activity" as const;
  return "spark" as const;
}
