import React, { useEffect } from "react";

interface NftDrawerProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}

export default function NftDrawer({ open, title, onClose, children }: NftDrawerProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      data-look="ext"
      className="fixed inset-0 z-40 flex justify-end bg-(--overlay) animate-in fade-in-0 duration-200 ease-out motion-reduce:animate-none"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="look-raise m-3 flex w-110 flex-col rounded-[22px] bg-surface-card animate-in slide-in-from-right-4 duration-250 ease-out motion-reduce:animate-none"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="shrink-0 px-6 pt-6 pb-3 text-title font-semibold text-content">{title}</h3>
        <div className="flex-1 overflow-y-auto px-6 pb-6 scrollbar-hide">{children}</div>
      </div>
    </div>
  );
}
