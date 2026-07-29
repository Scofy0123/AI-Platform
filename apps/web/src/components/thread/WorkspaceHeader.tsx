import type { Ref } from "react";
import { Icon } from "../../icons.js";
import { useDismissiblePopover } from "./useDismissiblePopover.js";

interface WorkspaceHeaderProps {
  title: string;
  pinnedOpen: boolean;
  bottomOpen: boolean;
  bottomAvailable: boolean;
  sideOpen: boolean;
  canArchive: boolean;
  archivePending: boolean;
  pinnedToggleRef?: Ref<HTMLButtonElement>;
  bottomToggleRef?: Ref<HTMLButtonElement>;
  sideToggleRef?: Ref<HTMLButtonElement>;
  onTogglePinned(): void;
  onToggleBottom(): void;
  onToggleSide(): void;
  onArchive(): void;
}

export function WorkspaceHeader({
  title,
  pinnedOpen,
  bottomOpen,
  bottomAvailable,
  sideOpen,
  canArchive,
  archivePending,
  pinnedToggleRef,
  bottomToggleRef,
  sideToggleRef,
  onTogglePinned,
  onToggleBottom,
  onToggleSide,
  onArchive,
}: WorkspaceHeaderProps) {
  const {
    close: closeMenu,
    open: menuOpen,
    rootRef: menuRef,
    toggle: toggleMenu,
    triggerRef: menuTriggerRef,
  } = useDismissiblePopover<HTMLDivElement>();

  return (
    <header className="v11-thread-header">
      <div className="v11-thread-title">
        <span className="v11-thread-project-icon" role="img" aria-label="当前项目">
          <Icon name="project" />
        </span>
        <h1>{title}</h1>
        <div ref={menuRef} className="v11-thread-menu">
          <button
            ref={menuTriggerRef}
            type="button"
            className="v11-thread-menu-trigger"
            aria-label="Thread actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen && canArchive}
            disabled={!canArchive}
            onClick={toggleMenu}
          >
            <span aria-hidden="true">•••</span>
          </button>
          {menuOpen && canArchive ? (
            <div className="v11-thread-menu-popover" role="menu">
              <button
                type="button"
                role="menuitem"
                aria-label="Archive Thread"
                disabled={archivePending}
                onClick={() => {
                  closeMenu({ restoreFocus: true });
                  onArchive();
                }}
              >
                <Icon name="audit" />
                Archive
              </button>
            </div>
          ) : null}
        </div>
      </div>
      <div className="v11-thread-actions">
        <button
          ref={pinnedToggleRef}
          type="button"
          aria-label="Toggle pinned summary"
          aria-expanded={pinnedOpen}
          aria-controls="thread-pinned-summary"
          onClick={onTogglePinned}
        >
          <Icon name="activity" />
        </button>
        <button
          ref={bottomToggleRef}
          type="button"
          aria-label="Toggle bottom panel"
          aria-expanded={bottomOpen}
          aria-controls="thread-bottom-panel"
          disabled={!bottomAvailable}
          onClick={onToggleBottom}
        >
          <Icon name="terminal" />
        </button>
        <button
          ref={sideToggleRef}
          type="button"
          aria-label="Toggle side panel"
          aria-expanded={sideOpen}
          aria-controls="thread-side-panel"
          onClick={onToggleSide}
        >
          <Icon name="project" />
        </button>
      </div>
    </header>
  );
}
