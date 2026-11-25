import { useState } from "react";
import SetupPrivateDrawer from "src/features/privacy/components/SetupPrivateDrawer";
import { usePrivateSetupTag } from "src/hooks/privacy/usePrivateSetupTag";
import HomeTag from "src/shared/ui/HomeTag";

interface SetupPrivateTagProps {
  publicBalance: number;
  balanceReady: boolean;
  pvacReady: boolean;
}

export default function SetupPrivateTag({
  publicBalance,
  balanceReady,
  pvacReady,
}: SetupPrivateTagProps) {
  const { visible, feeRaw, refresh } = usePrivateSetupTag(publicBalance, balanceReady, pvacReady);
  const [open, setOpen] = useState(false);

  return (
    <>
      {visible && feeRaw && (
        <HomeTag tone="blue" dot onClick={() => setOpen(true)}>
          Set up private
        </HomeTag>
      )}
      {open && (
        <SetupPrivateDrawer
          publicBalance={balanceReady ? publicBalance : null}
          onClose={() => setOpen(false)}
          onDone={() => {
            setOpen(false);
            refresh();
          }}
        />
      )}
    </>
  );
}
