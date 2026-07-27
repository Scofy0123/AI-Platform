import type { CSSProperties, KeyboardEvent, ReactNode, RefObject } from "react";
import { useRef } from "react";
import type { SidePanelTab } from "../../workspace-layout.js";

interface SidePanelProps {
  open: boolean;
  tab: SidePanelTab;
  width: number;
  onSelect(tab: SidePanelTab): void;
  onClose(): void;
  renderContent(tab: SidePanelTab): ReactNode;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
}

const MAIN_TABS = ["plan", "outputs", "subagents", "sources"] as const;
type MainTabKind = (typeof MAIN_TABS)[number];

const PANEL_ID = "thread-side-tabpanel";

function parentMainTab(tab: SidePanelTab): MainTabKind {
  switch (tab.kind) {
    case "subagent":
      return "subagents";
    // Changes are opened from delivery activity and return to the output surface.
    case "changes":
      return "outputs";
    // Tool calls are evidence/provenance in the current read-oriented product domain.
    case "tool":
      return "sources";
    default:
      return tab.kind;
  }
}

function isDetailTab(
  tab: SidePanelTab,
): tab is Extract<SidePanelTab, { kind: "changes" | "tool" }> {
  return tab.kind === "changes" || tab.kind === "tool";
}

function tabId(kind: MainTabKind) {
  return `thread-side-tab-${kind}`;
}

export function SidePanel({
  open,
  tab,
  width,
  onSelect,
  onClose,
  renderContent,
  returnFocusRef,
}: SidePanelProps) {
  const tabRefs = useRef<Partial<Record<MainTabKind, HTMLButtonElement | null>>>({});
  if (!open) return null;
  const selectedMainTab = parentMainTab(tab);
  const close = () => {
    onClose();
    queueMicrotask(() => returnFocusRef?.current?.focus());
  };
  const selectMainTab = (kind: MainTabKind) => {
    onSelect({ kind });
    tabRefs.current[kind]?.focus();
  };
  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, kind: MainTabKind) => {
    const currentIndex = MAIN_TABS.indexOf(kind);
    let nextIndex: number | null = null;
    switch (event.key) {
      case "ArrowRight":
        nextIndex = (currentIndex + 1) % MAIN_TABS.length;
        break;
      case "ArrowLeft":
        nextIndex = (currentIndex - 1 + MAIN_TABS.length) % MAIN_TABS.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = MAIN_TABS.length - 1;
        break;
    }
    if (nextIndex === null) return;
    const nextKind = MAIN_TABS[nextIndex];
    if (!nextKind) return;
    event.preventDefault();
    selectMainTab(nextKind);
  };
  const style = { "--side-panel-width": `${width}px` } as CSSProperties;
  return (
    <section
      id="thread-side-panel"
      className="thread-side-panel"
      aria-label="Side panel"
      style={style}
      onKeyDown={(event) => {
        if (event.key === "Escape") close();
      }}
    >
      <header>
        <div role="tablist" aria-label="Side panel views">
          {MAIN_TABS.map((kind) => (
            <button
              type="button"
              role="tab"
              id={tabId(kind)}
              aria-controls={PANEL_ID}
              aria-selected={selectedMainTab === kind}
              tabIndex={selectedMainTab === kind ? 0 : -1}
              ref={(element) => {
                tabRefs.current[kind] = element;
              }}
              onClick={() => selectMainTab(kind)}
              onKeyDown={(event) => handleTabKeyDown(event, kind)}
              key={kind}
            >
              {sideTabLabel({ kind })}
            </button>
          ))}
        </div>
        <button type="button" aria-label="Close side panel" onClick={close}>
          ×
        </button>
      </header>
      <div
        id={PANEL_ID}
        className="thread-side-panel-content"
        role="tabpanel"
        aria-labelledby={tabId(selectedMainTab)}
        // Tab panels without an initially focusable child remain reachable per the WAI-ARIA tabs pattern.
        // biome-ignore lint/a11y/noNoninteractiveTabindex: enables keyboard users to focus panel content
        tabIndex={0}
      >
        {isDetailTab(tab) ? (
          <header className="thread-side-panel-detail-header">
            <button
              type="button"
              aria-label={`Back to ${sideTabLabel({ kind: selectedMainTab })}`}
              onClick={() => selectMainTab(selectedMainTab)}
            >
              ← Back
            </button>
            <h2>{sideTabLabel(tab)}</h2>
          </header>
        ) : null}
        {renderContent(tab)}
      </div>
    </section>
  );
}

export function sideTabLabel(tab: SidePanelTab) {
  switch (tab.kind) {
    case "plan":
      return "Plan";
    case "outputs":
      return "Outputs";
    case "subagents":
      return "Subagents";
    case "sources":
      return "Sources";
    case "subagent":
      return "Subagent";
    case "changes":
      return "Changes";
    case "tool":
      return "Tool details";
  }
}
