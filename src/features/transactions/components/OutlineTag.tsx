export default function OutlineTag({ label }: { label: string }) {
  return (
    <span
      className="inline-flex items-center shrink-0 h-4.5 px-1.75 rounded-[9px] text-[10px] leading-none font-semibold text-content-secondary shadow-[inset_0_0_0_1px_var(--color-edge-strong)]"
      data-tag="outline"
    >
      {label}
    </span>
  );
}
