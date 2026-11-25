import React from "react";
import { Loader } from "src/shared/ui/icons";

interface LoadingSpinnerProps {
  fullScreen?: boolean;
  text?: string;
  size?: number;
}

export default React.memo(function LoadingSpinner({
  fullScreen,
  text,
  size = 24,
}: LoadingSpinnerProps) {
  const content = (
    <div className="flex flex-col items-center gap-3">
      <Loader size={size} className="animate-spin text-accent" />
      {text && <p className="text-sm text-content-secondary">{text}</p>}
    </div>
  );

  if (fullScreen) {
    return (
      <div className="h-screen w-full flex items-center justify-center bg-surface">{content}</div>
    );
  }

  return content;
});
