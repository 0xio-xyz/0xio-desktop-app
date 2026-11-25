import React from "react";

export function Group({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={`look-raise rounded-[18px] bg-surface-card ${className}`}>{children}</div>;
}

/** `flat` drops the card, for a slot that already is one. */
export function NoticeCard({
  title,
  text,
  children,
  className = "",
  flat,
}: {
  title: string;
  text?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  flat?: boolean;
}) {
  if (flat)
    return (
      <div className={className}>
        <h3 className="text-title font-semibold text-content">{title}</h3>
        {text && (
          <p className="mt-1 line-clamp-2 text-[0.8125rem] leading-snug text-content-muted">
            {text}
          </p>
        )}
      </div>
    );
  return (
    <Group className={`px-5 pt-4.5 pb-3 ${className}`}>
      <h3 className="text-[1.0625rem] font-semibold text-content">{title}</h3>
      {text && <p className="mt-1.5 text-body leading-relaxed text-content-secondary">{text}</p>}
      {children && <div className="mt-1.5">{children}</div>}
    </Group>
  );
}
