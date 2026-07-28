import { useCallback, useEffect, useRef, useState } from "react";

interface ClosePopoverOptions {
  restoreFocus?: boolean;
}

const POPOVER_OPEN_EVENT = "codexplatform:popover-open";

export function useDismissiblePopover<TRoot extends HTMLElement>() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<TRoot>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverIdRef = useRef(Symbol("composer-popover"));

  const close = useCallback(({ restoreFocus = false }: ClosePopoverOptions = {}) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const toggle = useCallback(() => {
    if (open) {
      setOpen(false);
      return;
    }
    document.dispatchEvent(new CustomEvent(POPOVER_OPEN_EVENT, { detail: popoverIdRef.current }));
    setOpen(true);
  }, [open]);

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
    const handleAnotherPopover = (event: Event) => {
      if (event instanceof CustomEvent && event.detail !== popoverIdRef.current) {
        close();
      }
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener(POPOVER_OPEN_EVENT, handleAnotherPopover);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener(POPOVER_OPEN_EVENT, handleAnotherPopover);
    };
  }, [close, open]);

  return { close, open, rootRef, toggle, triggerRef };
}
