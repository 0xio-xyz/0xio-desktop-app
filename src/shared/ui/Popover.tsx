import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "src/lib/cn";
import {
  firstTabbable,
  useAnchoredPosition,
  useDismiss,
  useLayerId,
  type Align,
  type Side,
} from "src/shared/ui/layer";

interface PopoverState {
  open: boolean;
  setOpen: (open: boolean) => void;
  triggerRef: React.MutableRefObject<HTMLElement | null>;
  contentId: string;
}

const PopoverContext = React.createContext<PopoverState | null>(null);

function usePopover(): PopoverState {
  const ctx = React.useContext(PopoverContext);
  if (!ctx) throw new Error("Popover parts need a <Popover> above them");
  return ctx;
}

function Popover({
  open: given,
  defaultOpen = false,
  onOpenChange,
  children,
}: {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: React.ReactNode;
}) {
  const [inner, setInner] = React.useState(defaultOpen);
  const open = given ?? inner;
  const triggerRef = React.useRef<HTMLElement | null>(null);
  const contentId = useLayerId("popover");
  const setOpen = React.useCallback(
    (next: boolean) => {
      if (given === undefined) setInner(next);
      onOpenChange?.(next);
    },
    [given, onOpenChange],
  );
  const value = React.useMemo(
    () => ({ open, setOpen, triggerRef, contentId }),
    [open, setOpen, contentId],
  );
  return <PopoverContext.Provider value={value}>{children}</PopoverContext.Provider>;
}

type TriggerProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean };

function PopoverTrigger({ asChild, children, onClick, ...props }: TriggerProps) {
  const { open, setOpen, triggerRef, contentId } = usePopover();
  const aria = {
    "aria-haspopup": "dialog" as const,
    "aria-expanded": open,
    "aria-controls": open ? contentId : undefined,
    "data-state": open ? "open" : "closed",
  };
  const toggle = (e: React.MouseEvent<HTMLButtonElement>) => {
    onClick?.(e);
    if (!e.defaultPrevented) setOpen(!open);
  };
  if (asChild && React.isValidElement<TriggerProps & { ref?: React.Ref<HTMLElement> }>(children)) {
    const child = children;
    return React.cloneElement(child, {
      ...props,
      ...aria,
      ref: (node: HTMLElement | null) => {
        triggerRef.current = node;
      },
      onClick: (e: React.MouseEvent<HTMLButtonElement>) => {
        child.props.onClick?.(e);
        toggle(e);
      },
    } as Partial<TriggerProps>);
  }
  return (
    <button
      type="button"
      {...props}
      {...aria}
      ref={(node) => {
        triggerRef.current = node;
      }}
      onClick={toggle}
    >
      {children}
    </button>
  );
}

type ContentProps = React.HTMLAttributes<HTMLDivElement> & {
  align?: Align;
  side?: Side;
  sideOffset?: number;
};

function PopoverContent(props: ContentProps) {
  const { open } = usePopover();
  if (!open) return null;
  return <OpenContent {...props} />;
}

function OpenContent({
  className,
  align = "center",
  side = "bottom",
  sideOffset = 4,
  children,
  ...props
}: ContentProps) {
  const { setOpen, triggerRef, contentId } = usePopover();
  const ref = React.useRef<HTMLDivElement>(null);
  const pos = useAnchoredPosition(true, triggerRef, ref, side, align, sideOffset);
  const closedBy = React.useRef<string | null>(null);

  useDismiss(
    true,
    [ref, triggerRef],
    (reason) => {
      closedBy.current = reason;
      setOpen(false);
    },
    true,
  );

  // effect:audited - focus moves in when the popover opens and back to the trigger when it closes
  React.useEffect(() => {
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) (firstTabbable(el) ?? el).focus();
    const trigger = triggerRef.current;
    return () => {
      if (closedBy.current !== "outside" && closedBy.current !== "focus")
        trigger?.focus({ preventScroll: true });
    };
  }, [triggerRef]);

  return createPortal(
    <div
      data-popper=""
      style={{
        position: "fixed",
        left: 0,
        top: 0,
        minWidth: "max-content",
        zIndex: 50,
        transform: pos ? `translate(${pos.x}px, ${pos.y}px)` : "translate(0, -200%)",
      }}
    >
      <div
        ref={ref}
        id={contentId}
        role="dialog"
        tabIndex={-1}
        data-state="open"
        data-side={pos?.side ?? side}
        data-align={align}
        className={cn(
          "look-raise z-50 w-72 rounded-[14px] bg-surface-card p-4 text-content outline-none",
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

export { Popover, PopoverTrigger, PopoverContent };
