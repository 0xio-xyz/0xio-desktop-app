import React from "react";

const FADE = { maskImage: "linear-gradient(to bottom, black calc(100% - 40px), transparent)" };

export default function TabLayout({
  children,
  panel,
}: {
  children: React.ReactNode;
  panel: React.ReactNode;
}) {
  return (
    <div className="mt-7.5 grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,0.6fr)] gap-7">
      <div
        role="tabpanel"
        className="-mx-6 min-h-0 overflow-y-auto scrollbar-hide px-6"
        style={FADE}
      >
        <div className="flex flex-col gap-6.5 pb-10">{children}</div>
      </div>
      <aside className="-mx-6 min-h-0 overflow-y-auto scrollbar-hide px-6 pt-6.75" style={FADE}>
        <div className="pb-10">{panel}</div>
      </aside>
    </div>
  );
}
