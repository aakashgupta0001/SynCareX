import { useEffect } from "react";

/**
 * Keyboard handling for the continuity modals.
 *
 * Each of these dialogs renders a full-screen overlay that swallows pointer
 * events, so before this hook a clinician who opened one and pressed Escape
 * was stuck: the sidebar could not be clicked and the only way out was the
 * Cancel button. Escape now closes the dialog, which is what every other
 * dialog on the platform does.
 *
 * While a dialog is open the page behind it is also prevented from
 * scrolling, so the background does not move under the overlay.
 */
export function useDismissableModal(open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);
}
