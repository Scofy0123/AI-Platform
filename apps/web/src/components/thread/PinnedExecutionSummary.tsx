import type { ReactNode, RefObject } from "react";

interface PinnedExecutionSummaryProps {
  open: boolean;
  onClose(): void;
  children: ReactNode;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
}

export function PinnedExecutionSummary({
  open,
  onClose,
  children,
  returnFocusRef,
}: PinnedExecutionSummaryProps) {
  if (!open) return null;
  const close = () => {
    onClose();
    queueMicrotask(() => returnFocusRef?.current?.focus());
  };
  return (
    <aside
      id="thread-pinned-summary"
      className="pinned-execution-summary"
      aria-label="Pinned execution summary"
      onKeyDown={(event) => {
        if (event.key === "Escape") close();
      }}
    >
      <header>
        <strong>Execution summary</strong>
        <button type="button" aria-label="Close pinned summary" onClick={close}>
          ×
        </button>
      </header>
      <div>{children}</div>
    </aside>
  );
}
