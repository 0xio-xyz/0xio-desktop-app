import { useCallback, useEffect, useRef, useState } from "react";

export function useOverflowing<T extends HTMLElement>(): [(el: T | null) => void, boolean] {
  const [overflowing, setOverflowing] = useState(false);
  const observer = useRef<ResizeObserver | null>(null);

  const ref = useCallback((el: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    const measure = () => setOverflowing(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver !== "undefined") {
      observer.current = new ResizeObserver(measure);
      observer.current.observe(el);
    }
  }, []);

  // effect:audited - disconnects the resize observer (browser API) when the element's owner unmounts
  useEffect(() => () => observer.current?.disconnect(), []);

  return [ref, overflowing];
}
