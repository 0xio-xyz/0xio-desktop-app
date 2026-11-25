import React, { useRef } from "react";
import { usePrimaryName, useSeen } from "src/hooks/wallet/useOns";

const NAME = "font-sans font-medium whitespace-nowrap text-content-secondary";

export default function NamedAddress({
  address,
  networkId,
  before,
  children,
  className = "",
}: {
  address: string | null | undefined;
  networkId?: string;
  before?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const seen = useSeen(ref);
  const name = usePrimaryName(address, { networkId, enabled: seen });
  return (
    <span ref={ref} className={`inline-flex min-w-0 items-baseline gap-2 ${className}`}>
      {before}
      {name && (
        <span data-testid="primary-name" className={NAME}>
          {name}
        </span>
      )}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}
