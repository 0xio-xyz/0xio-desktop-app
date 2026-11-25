import React from "react";
import type { IconType } from "src/shared/ui/icons";

interface EmptyStateProps {
  icon?: IconType;
  title: string;
  action?: React.ReactNode;
}

export default React.memo(function EmptyState({ icon: Icon, title, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
      {Icon && (
        <div className="w-12 h-12 rounded-full bg-surface-highlight flex items-center justify-center mb-4">
          <Icon size={22} className="text-content-muted" />
        </div>
      )}
      <h4 className="text-sm font-medium text-content">{title}</h4>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
});
