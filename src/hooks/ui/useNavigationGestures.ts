import { useEffect } from "react";
import { useNavigate } from "src/lib/router";

// No trackpad swipe on purpose: a stray swipe could navigate past the lock screen.
export function useNavigationGestures() {
  const navigate = useNavigate();

  useEffect(() => {
    const handleMouseUp = (e: MouseEvent) => {
      if (e.button === 3) {
        e.preventDefault();
        navigate(-1);
      }
      if (e.button === 4) {
        e.preventDefault();
        navigate(1);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().includes("MAC");
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement).isContentEditable)
        return;

      if (isMac) {
        if (e.metaKey && e.key === "[") {
          e.preventDefault();
          navigate(-1);
        }
        if (e.metaKey && e.key === "]") {
          e.preventDefault();
          navigate(1);
        }
      } else {
        if (e.altKey && e.key === "ArrowLeft") {
          e.preventDefault();
          navigate(-1);
        }
        if (e.altKey && e.key === "ArrowRight") {
          e.preventDefault();
          navigate(1);
        }
      }
    };

    window.addEventListener("mouseup", handleMouseUp);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [navigate]);
}
