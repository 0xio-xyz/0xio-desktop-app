import * as React from "react";
import { cn } from "src/lib/cn";

type SwitchProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "value" | "onChange"> & {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
};

const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  (
    { className, checked, defaultChecked = false, onCheckedChange, onClick, disabled, ...props },
    ref,
  ) => {
    const [inner, setInner] = React.useState(defaultChecked);
    const on = checked ?? inner;
    const state = on ? "checked" : "unchecked";
    return (
      <button
        type="button"
        role="switch"
        aria-checked={on}
        data-state={state}
        data-disabled={disabled ? "" : undefined}
        disabled={disabled}
        value="on"
        {...props}
        ref={ref}
        onClick={(e) => {
          onClick?.(e);
          if (e.defaultPrevented) return;
          if (checked === undefined) setInner(!on);
          onCheckedChange?.(!on);
        }}
        className={cn(
          "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "data-[state=unchecked]:bg-surface-highlight",
          "data-[state=checked]:bg-positive",
          className,
        )}
      >
        <span
          data-state={state}
          className={cn(
            "pointer-events-none block h-4 w-4 rounded-full bg-white shadow-lg ring-0 transition-transform",
            "data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0",
          )}
        />
      </button>
    );
  },
);
Switch.displayName = "Switch";

export { Switch };
