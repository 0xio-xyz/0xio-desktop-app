import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "src/lib/cn";
import { useAnchoredPosition, useDismiss, useLayerId, type Align } from "src/shared/ui/layer";

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  options: SelectOption[];
  onValueChange: (value: string) => void;
  disabled?: boolean;
  label?: string;
  triggerClassName?: string;
  onTriggerClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  contentClassName?: string;
  itemClassName?: string;
  align?: Align;
  sideOffset?: number;
  contentProps?: React.HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string>;
  children?: React.ReactNode;
}

const TYPEAHEAD_MS = 1000;

export function typeaheadMatch(
  options: SelectOption[],
  search: string,
  from: number,
): number | undefined {
  const repeated = search.length > 1 && [...search].every((c) => c === search[0]);
  const text = (repeated ? search[0] : search).toLowerCase();
  const step = repeated || search.length === 1 ? 1 : 0;
  const n = options.length;
  for (let k = 0; k < n; k++) {
    const i = ((((from < 0 ? -1 : from) + step + k) % n) + n) % n;
    if (options[i].label.toLowerCase().startsWith(text)) return i;
  }
  return undefined;
}

function useTypeahead() {
  const text = React.useRef("");
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  return (key: string) => {
    text.current += key;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => (text.current = ""), TYPEAHEAD_MS);
    return text.current;
  };
}

export function Select({
  value,
  options,
  onValueChange,
  disabled,
  label,
  triggerClassName,
  onTriggerClick,
  contentClassName,
  itemClassName,
  align = "end",
  sideOffset = 6,
  contentProps,
  children,
}: SelectProps) {
  const [open, setOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const contentId = useLayerId("select");
  const typed = useTypeahead();
  const current = options.findIndex((o) => o.value === value);

  const close = React.useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  }, []);

  const choose = (next: string) => {
    if (next !== value) onValueChange(next);
    close();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-controls={open ? contentId : undefined}
        aria-expanded={open}
        aria-autocomplete="none"
        aria-label={label}
        data-state={open ? "open" : "closed"}
        disabled={disabled}
        className={triggerClassName}
        onPointerDown={(e) => {
          if (e.pointerType !== "mouse" || e.button !== 0 || e.ctrlKey) return;
          e.preventDefault();
          setOpen(true);
        }}
        onClick={(e) => {
          onTriggerClick?.(e);
          if (!open) setOpen(true);
        }}
        onKeyDown={(e) => {
          if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(e.key)) {
            e.preventDefault();
            setOpen(true);
            return;
          }
          if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            const hit = typeaheadMatch(options, typed(e.key), current);
            if (hit !== undefined) onValueChange(options[hit].value);
          }
        }}
      >
        {children}
      </button>
      {open && (
        <SelectContent
          id={contentId}
          triggerRef={triggerRef}
          options={options}
          current={current}
          onChoose={choose}
          onDismiss={close}
          className={contentClassName}
          itemClassName={itemClassName}
          align={align}
          sideOffset={sideOffset}
          contentProps={contentProps}
        />
      )}
    </>
  );
}

function SelectContent({
  id,
  triggerRef,
  options,
  current,
  onChoose,
  onDismiss,
  className,
  itemClassName,
  align,
  sideOffset,
  contentProps,
}: {
  id: string;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  options: SelectOption[];
  current: number;
  onChoose: (value: string) => void;
  onDismiss: () => void;
  className?: string;
  itemClassName?: string;
  align: Align;
  sideOffset: number;
  contentProps?: SelectProps["contentProps"];
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const items = React.useRef<(HTMLDivElement | null)[]>([]);
  const [highlighted, setHighlighted] = React.useState<number | null>(null);
  const [minWidth] = React.useState(() => triggerRef.current?.getBoundingClientRect().width ?? 0);
  const pos = useAnchoredPosition(true, triggerRef, ref, "bottom", align, sideOffset);
  const typed = useTypeahead();
  const pointer = React.useRef("mouse");

  useDismiss(true, [ref], onDismiss);

  // effect:audited - the page behind cannot be pressed or scrolled while the list is open
  React.useEffect(() => {
    const body = document.body;
    const before = body.style.pointerEvents;
    body.style.pointerEvents = "none";
    items.current[Math.max(current, 0)]?.focus({ preventScroll: true });
    return () => {
      body.style.pointerEvents = before;
    };
  }, [current]);

  const focusAt = (i: number) => {
    const n = Math.min(Math.max(i, 0), options.length - 1);
    items.current[n]?.focus({ preventScroll: true });
    items.current[n]?.scrollIntoView({ block: "nearest" });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const at = highlighted ?? current;
    if (e.key === "Tab") e.preventDefault();
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      focusAt(at + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusAt(at - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusAt(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusAt(options.length - 1);
    } else if ((e.key === "Enter" || e.key === " ") && highlighted !== null) {
      e.preventDefault();
      onChoose(options[highlighted].value);
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const hit = typeaheadMatch(options, typed(e.key), at);
      if (hit !== undefined) focusAt(hit);
    }
  };

  return createPortal(
    <div
      data-popper=""
      style={{
        position: "fixed",
        left: 0,
        top: 0,
        minWidth: "max-content",
        zIndex: 50,
        pointerEvents: "auto",
        transform: pos ? `translate(${pos.x}px, ${pos.y}px)` : "translate(0, -200%)",
      }}
    >
      <div
        ref={ref}
        id={id}
        role="listbox"
        tabIndex={-1}
        data-state="open"
        data-side={pos?.side ?? "bottom"}
        data-align={align}
        {...contentProps}
        className={cn("flex flex-col outline-none", className)}
        style={{ minWidth }}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div
          role="presentation"
          className="scrollbar-hide relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
        >
          {options.map((o, i) => (
            <div
              key={o.value}
              ref={(el) => {
                items.current[i] = el;
              }}
              role="option"
              aria-selected={i === current}
              tabIndex={-1}
              data-state={i === current ? "checked" : "unchecked"}
              data-highlighted={highlighted === i ? "" : undefined}
              className={itemClassName}
              onFocus={() => setHighlighted(i)}
              onBlur={() => setHighlighted((h) => (h === i ? null : h))}
              onPointerMove={() => {
                if (document.activeElement !== items.current[i])
                  items.current[i]?.focus({ preventScroll: true });
              }}
              onPointerLeave={() => {
                if (document.activeElement === items.current[i])
                  ref.current?.focus({ preventScroll: true });
              }}
              onPointerDown={(e) => {
                pointer.current = e.pointerType;
              }}
              onPointerUp={(e) => {
                if (e.pointerType === "mouse") onChoose(o.value);
              }}
              onClick={() => {
                if (pointer.current !== "mouse") onChoose(o.value);
              }}
            >
              <span>{o.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
