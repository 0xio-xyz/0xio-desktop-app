import React from "react";
import { Loader } from "src/shared/ui/icons";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
  fullWidth?: boolean;
}

export default React.memo(function Button({
  variant = "primary",
  size = "md",
  loading = false,
  fullWidth = false,
  disabled,
  children,
  className = "",
  ...props
}: ButtonProps) {
  const base =
    "relative inline-flex items-center justify-center gap-1.5 rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer";

  const variants = {
    primary: "font-semibold bg-content text-content-inverse hover:opacity-90",
    secondary: "font-semibold bg-surface-card text-content hover:bg-surface-highlight",
    ghost: "font-medium text-content-secondary hover:text-content hover:bg-surface-card",
    danger: "font-semibold bg-danger text-white hover:brightness-110",
  };

  const sizes = {
    sm: "h-8 px-4 text-meta",
    md: "h-10 px-5 text-body",
    lg: "h-12 px-6 text-body",
  };

  return (
    <button
      className={`${base} ${variants[variant]} ${sizes[size]} ${fullWidth ? "w-full" : ""} ${className}`}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <>
          <span className="invisible flex items-center gap-1.5">{children}</span>
          <span className="absolute inset-0 flex items-center justify-center">
            <Loader size={16} className="animate-spin" />
          </span>
        </>
      ) : (
        children
      )}
    </button>
  );
});
