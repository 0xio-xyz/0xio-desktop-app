import React from "react";
import { useIsFetching, useQueryClient } from "src/lib/query";
import "src/css/look-ext.css";
import TopBar from "src/shared/layout/TopBar";
import { isLive } from "src/hooks/app/useLiveStatus";

export default function LookFrame({
  title,
  right,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  const qc = useQueryClient();
  const refreshing = useIsFetching({ predicate: isLive }) > 0;
  return (
    <div data-look="ext" className="h-full overflow-hidden bg-surface">
      <div className="mx-auto flex h-full max-w-310 flex-col px-7 pb-7 min-[1600px]:px-11">
        <div className="shrink-0 pt-6.5 pb-3">
          <TopBar
            refreshing={refreshing}
            onRefresh={() => void qc.invalidateQueries({ predicate: isLive })}
          />
        </div>
        <div className="mt-1 flex shrink-0 items-center justify-between gap-4">
          <h1 className="truncate text-[1.75rem] leading-tight font-semibold tracking-[-0.02em] text-content">
            {title}
          </h1>
          {right}
        </div>
        {children}
      </div>
    </div>
  );
}
