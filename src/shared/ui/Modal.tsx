import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "src/shared/ui/icons";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  hideClose?: boolean;
  look?: "ext";
}

export default React.memo(function Modal({
  isOpen,
  onClose,
  title,
  children,
  size = "md",
  hideClose = false,
  look,
}: ModalProps) {
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const widths = { sm: "max-w-sm", md: "max-w-md", lg: "max-w-lg", xl: "max-w-2xl" };

  // area (excluding the sidebar), not the whole window. Falls back to body.
  const target = typeof document !== "undefined" ? document.getElementById("content-area") : null;
  const positioning = target ? "absolute" : "fixed";

  const overlay = (
    <div
      data-look={look}
      className={`${positioning} inset-0 z-50 flex items-center justify-center`}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        className={`relative w-full ${widths[size]} mx-4 bg-surface-card rounded-[22px] shadow-2xl shadow-black/40 animate-in fade-in zoom-in-95 duration-200`}
      >
        <div className="flex items-center justify-between gap-4 px-6 pt-5 pb-3">
          <h3 className="text-lead font-semibold text-content">{title}</h3>
          {!hideClose && (
            <button
              onClick={onClose}
              className="w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-content-secondary hover:text-content hover:bg-surface-highlight transition-colors cursor-pointer"
            >
              <X size={18} />
            </button>
          )}
        </div>
        <div className="px-6 pb-6">{children}</div>
      </div>
    </div>
  );

  return target ? createPortal(overlay, target) : overlay;
});
