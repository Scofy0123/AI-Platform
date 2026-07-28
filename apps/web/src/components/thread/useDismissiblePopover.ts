import { useCallback, useEffect, useRef, useState } from "react";

interface ClosePopoverOptions {
  restoreFocus?: boolean;
}

export function useDismissiblePopover<TRoot extends HTMLElement>() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<TRoot>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(({ restoreFocus = false }: ClosePopoverOptions = {}) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const toggle = useCallback(() => {
    setOpen((current) => !current);
  }, []);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !rootRef.current?.contains(target)) {
        close();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close({ restoreFocus: true });
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [close, open]);

  return { close, open, rootRef, toggle, triggerRef };
}
