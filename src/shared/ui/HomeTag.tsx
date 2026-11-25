import type React from "react";

const TONE = {
  neutral: "bg-caution/15 text-caution hover:bg-caution/25",
  blue: "bg-info/15 text-info hover:bg-info/25",
} as const;

export default function HomeTag({
  tone,
  dot = false,
  title,
  onClick,
  children,
}: {
  tone: keyof typeof TONE;
  dot?: boolean;
  title?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`look-tag inline-flex items-center gap-1.5 h-6.5 px-3 rounded-full text-[0.75rem] font-semibold whitespace-nowrap transition-colors cursor-pointer ${TONE[tone]}`}
    >
      {dot && <span className="w-1.5 h-1.5 rounded-full bg-current" aria-hidden="true" />}
      {children}
    </button>
  );
}
