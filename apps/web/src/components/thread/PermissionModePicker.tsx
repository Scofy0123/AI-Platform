import type { ExecutionPermissionSelection } from "@codexplatform/contracts";
import { Icon } from "../../icons.js";
import { useDismissiblePopover } from "./useDismissiblePopover.js";

export interface ExecutionPermissionOption {
  mode: ExecutionPermissionSelection["mode"];
  profileId?: string | null;
  label: string;
  description: string;
  available: boolean;
  unavailableReason: string | null;
}

interface PermissionModePickerProps {
  value: ExecutionPermissionSelection;
  options: readonly ExecutionPermissionOption[];
  onChange(value: ExecutionPermissionSelection): void;
  disabled?: boolean;
}

export function PermissionModePicker({
  value,
  options,
  onChange,
  disabled = false,
}: PermissionModePickerProps) {
  const { close, open, rootRef, toggle, triggerRef } = useDismissiblePopover<HTMLDivElement>();
  const selected = options.find(
    (option) =>
      option.mode === value.mode &&
      (option.mode !== "CUSTOM" || option.profileId === value.profileId),
  );

  return (
    <div ref={rootRef} className="composer-permission-picker">
      <button
        ref={triggerRef}
        type="button"
        className={`composer-permission-trigger permission-${value.mode.toLowerCase()}`}
        data-permission-icon={permissionIcon(value.mode)}
        aria-label="Execution permissions"
        aria-haspopup="menu"
        aria-expanded={open}
        title={selected?.label ?? "Execution permissions"}
        disabled={disabled}
        onClick={toggle}
      >
        <Icon name={permissionIcon(value.mode)} />
        <span className="sr-only">{selected?.label}</span>
      </button>
      {open ? (
        <div className="composer-permission-popover" role="menu">
          <header>
            <span>How should Codex actions be approved?</span>
            <a
              href="https://learn.chatgpt.com/docs/permission-modes"
              target="_blank"
              rel="noreferrer"
              aria-label="Learn more about Codex permission modes"
            >
              Learn more
            </a>
          </header>
          {options.map((option) => {
            const checked =
              option.mode === value.mode &&
              (option.mode !== "CUSTOM" || option.profileId === value.profileId);
            return (
              <button
                type="button"
                role="menuitem"
                data-permission-icon={permissionIcon(option.mode)}
                aria-current={checked ? "true" : undefined}
                aria-label={`${option.label} — ${option.description}`}
                disabled={!option.available}
                key={`${option.mode}:${option.profileId ?? ""}`}
                onClick={() => {
                  if (!option.available) return;
                  close({ restoreFocus: true });
                  onChange(
                    option.mode === "CUSTOM"
                      ? { mode: "CUSTOM", profileId: option.profileId ?? "" }
                      : { mode: option.mode, profileId: null },
                  );
                }}
              >
                <Icon name={permissionIcon(option.mode)} />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                  {!option.available && option.unavailableReason ? (
                    <em>{option.unavailableReason}</em>
                  ) : null}
                </span>
                {checked ? <Icon name="check" className="permission-check" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function permissionIcon(mode: ExecutionPermissionSelection["mode"]) {
  if (mode === "ASK_FOR_APPROVAL") return "hand" as const;
  if (mode === "APPROVE_FOR_ME") return "approval-terminal" as const;
  if (mode === "CUSTOM") return "settings" as const;
  return "shield-alert" as const;
}
