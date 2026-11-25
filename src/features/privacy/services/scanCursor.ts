const STORAGE_KEY = "0xio_stealth_scan_cursor";
const MARGIN_EPOCHS = 10;
const FULL_SCAN_EVERY_MS = 24 * 60 * 60_000;

type Cursor = { epoch: number; fullAt: number };
type CursorMap = Record<string, Cursor>;

const whole = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function load(): CursorMap {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return parsed && typeof parsed === "object" ? (parsed as CursorMap) : {};
  } catch {
    return {};
  }
}

function save(map: CursorMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    return;
  }
}

/**
 * The epoch a scan starts from. 0 (everything) with no cursor, an unreadable chain head, a cursor
 * ahead of the head (the chain was reset) or a full scan older than a day.
 */
export function scanStart(scope: string, head: number | null, now: number): number {
  const cursor = load()[scope];
  if (!cursor || !whole(cursor.epoch) || !whole(cursor.fullAt) || head === null) return 0;
  if (cursor.epoch > head || now - cursor.fullAt >= FULL_SCAN_EVERY_MS || now < cursor.fullAt)
    return 0;
  return cursor.epoch;
}

/**
 * Called only after a complete scan with every output checked. The next scan starts at the oldest
 * transfer still waiting, so its claimed state and claim secret are read again, else just behind
 * the head this scan started at.
 */
export function scanDone(
  scope: string,
  scan: { from: number; head: number | null; waitingEpochs: (number | undefined)[]; now: number },
): void {
  const map = load();
  if (scan.head === null) {
    delete map[scope];
    return save(map);
  }
  const oldest = scan.waitingEpochs.map((e) => (whole(e) ? e : 0));
  const epoch = Math.max(0, Math.min(scan.head - MARGIN_EPOCHS, ...oldest));
  const fullAt = scan.from === 0 ? scan.now : (map[scope]?.fullAt ?? 0);
  map[scope] = { epoch, fullAt };
  save(map);
}
