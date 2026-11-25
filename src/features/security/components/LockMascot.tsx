import { useRef } from "react";
import Mascot from "src/shared/ui/Mascot";
import { useMascot } from "src/hooks/ui/useMascot";

export default function LockMascot({ working }: { working: boolean }) {
  const anchor = useRef<HTMLDivElement>(null);
  const { phase, lookDeg, leanX } = useMascot(anchor, working);
  return (
    <div ref={anchor} className="flex justify-center">
      <Mascot id="lock" phase={phase} size={96} lookDeg={lookDeg} leanX={leanX} />
    </div>
  );
}
