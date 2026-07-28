import type { ComposerCapability } from "@codexplatform/contracts";
import { Icon, type IconName } from "../../icons.js";
import { useDismissiblePopover } from "./useDismissiblePopover.js";

interface ComposerAddMenuProps {
  capabilities: readonly ComposerCapability[];
  onSelect(capability: ComposerCapability): void;
  disabled?: boolean;
}

const SECTION_LABELS = {
  ADD: "Add",
  PLUGINS: "Plugins",
  APPS: "Apps",
  FILES_AND_CHATS: "Files and chats",
} as const;

export function ComposerAddMenu({
  capabilities,
  onSelect,
  disabled = false,
}: ComposerAddMenuProps) {
  const { close, open, rootRef, toggle, triggerRef } = useDismissiblePopover<HTMLDivElement>();

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
        onClick={toggle}
      >
        <Icon name="plus" />
      </button>
      {open ? (
        <div className="composer-add-popover" role="menu">
          {(Object.keys(SECTION_LABELS) as Array<keyof typeof SECTION_LABELS>).map((section) => {
            const items = capabilities.filter((capability) => capability.section === section);
            if (items.length === 0) return null;
            return (
              <section key={section} aria-label={SECTION_LABELS[section]}>
                <h3>{SECTION_LABELS[section]}</h3>
                {items.map((capability) => (
                  <button
                    type="button"
                    role="menuitem"
                    aria-label={`${capability.label} — ${capability.description}`}
                    disabled={capability.availability !== "AVAILABLE"}
                    key={capability.id}
                    onClick={() => {
                      if (capability.availability !== "AVAILABLE") return;
                      close({ restoreFocus: true });
                      onSelect(capability);
                    }}
                  >
                    <Icon name={capabilityIcon(capability.kind)} />
                    <span>
                      <strong>{capability.label}</strong>
                      <small>{capability.description}</small>
                      {capability.unavailableReason ? (
                        <em>{capability.unavailableReason}</em>
                      ) : null}
                    </span>
                  </button>
                ))}
              </section>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function capabilityIcon(kind: ComposerCapability["kind"]): IconName {
  if (kind === "FILE_PICKER" || kind === "ENTERPRISE_RESOURCE") return "file";
  if (kind === "GOAL") return "activity";
  if (kind === "PLAN_MODE") return "spark";
  if (kind === "SKILL_RECORDER" || kind === "SKILL") return "tool";
  if (kind === "APP") return "grid";
  return "project";
}
