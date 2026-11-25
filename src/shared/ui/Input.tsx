import React from "react";

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  rightElement?: React.ReactNode;
}

export default React.memo(function Input({
  label,
  error,
  rightElement,
  className = "",
  ...props
}: InputProps) {
  return (
    <div className="space-y-1.5">
      {label && <label className="block text-sm font-medium text-content-secondary">{label}</label>}
      <div className="relative">
        <input
          className={`w-full px-4 py-3 rounded-xl bg-surface-input border border-edge text-sm text-content placeholder:text-content-muted
            focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30
            transition-colors ${error ? "border-danger" : ""} ${rightElement ? "pr-12" : ""} ${className}`}
          {...props}
        />
        {rightElement && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2">{rightElement}</div>
        )}
        {error && (
          <div className="absolute left-0 -bottom-1 translate-y-full z-10 animate-in fade-in slide-in-from-top-1 duration-200">
            <p className="text-xs text-danger bg-danger/10 border border-danger/20 rounded-lg px-2.5 py-1 shadow-sm backdrop-blur-sm">
              {error}
            </p>
          </div>
        )}
      </div>
    </div>
  );
});
