import type { CSSProperties, ReactNode, RefObject } from "react";
import type { BottomPanelTab } from "../../workspace-layout.js";

interface BottomPanelProps {
  open: boolean;
  tab: BottomPanelTab;
  height: number;
  availableTabs: BottomPanelTab[];
  onSelect(tab: BottomPanelTab): void;
  onClose(): void;
  renderContent(tab: BottomPanelTab): ReactNode;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
}

export function BottomPanel({
  open,
  tab,
  height,
  availableTabs,
  onSelect,
  onClose,
  renderContent,
  returnFocusRef,
}: BottomPanelProps) {
  if (!open) return null;
  const close = () => {
    onClose();
    queueMicrotask(() => returnFocusRef?.current?.focus());
  };
  const style = { "--bottom-panel-height": `${height}px` } as CSSProperties;
  return (
    <section
      id="thread-bottom-panel"
      className="thread-bottom-panel"
      aria-label="Bottom panel"
      style={style}
      onKeyDown={(event) => {
        if (event.key === "Escape") close();
      }}
    >
      <header>
        <div role="tablist" aria-label="Bottom panel views">
          {availableTabs.map((candidate) => (
            <button
              id={`bottom-panel-tab-${candidate}`}
              type="button"
              role="tab"
              aria-selected={tab === candidate}
              aria-controls={`bottom-panel-view-${candidate}`}
              onClick={() => onSelect(candidate)}
              key={candidate}
            >
              {bottomTabLabel(candidate)}
            </button>
          ))}
        </div>
        <button type="button" aria-label="Close bottom panel" onClick={close}>
          ×
        </button>
      </header>
      <div
        id={`bottom-panel-view-${tab}`}
        className="thread-bottom-panel-content"
        role="tabpanel"
        aria-labelledby={`bottom-panel-tab-${tab}`}
      >
        {renderContent(tab)}
      </div>
    </section>
  );
}

export function bottomTabLabel(tab: BottomPanelTab) {
  switch (tab) {
    case "terminal":
      return "Terminal";
  }
}
