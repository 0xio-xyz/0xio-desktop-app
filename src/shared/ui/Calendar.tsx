import * as React from "react";
import { ChevronLeft, ChevronRight } from "src/shared/ui/icons";
import { cn } from "src/lib/cn";
import { MONTHS } from "src/lib/dates";
import useMountEffect from "src/hooks/ui/useMountEffect";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SELECTED_BLUE = "#0000ff";

const sameDay = (a: Date | undefined, b: Date | undefined) =>
  !!a &&
  !!b &&
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

function addMonths(d: Date, n: number): Date {
  const first = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return new Date(first.getFullYear(), first.getMonth(), Math.min(d.getDate(), last));
}

const monthOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);

function ordinal(n: number): string {
  const rest = n % 100;
  if (rest >= 11 && rest <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

const pad = (n: number) => String(n).padStart(2, "0");
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const caption = (d: Date) => `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;

export function monthWeeks(month: Date): Date[][] {
  const first = monthOf(month);
  let day = addDays(first, -first.getDay());
  const weeks: Date[][] = [];
  do {
    const week: Date[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(day);
      day = addDays(day, 1);
    }
    weeks.push(week);
  } while (day.getMonth() === first.getMonth());
  return weeks;
}

interface CalendarProps {
  selected?: Date;
  onSelect?: (date: Date | undefined) => void;
  initialFocus?: boolean;
  showOutsideDays?: boolean;
  className?: string;
  today?: Date;
}

function Calendar({
  selected,
  onSelect,
  initialFocus,
  showOutsideDays = true,
  className,
  today: givenToday,
}: CalendarProps) {
  const [today] = React.useState(() => givenToday ?? new Date());
  const [month, setMonth] = React.useState(() => monthOf(selected ?? today));
  const [focused, setFocused] = React.useState<Date | null>(null);
  const grid = React.useRef<HTMLTableElement>(null);
  const moved = React.useRef(false);

  const weeks = monthWeeks(month);
  const inMonth = (d: Date) => d.getMonth() === month.getMonth();
  const target =
    focused && inMonth(focused)
      ? focused
      : selected && inMonth(selected)
        ? selected
        : inMonth(today)
          ? today
          : month;

  const focusDay = (d: Date) => {
    moved.current = true;
    setFocused(d);
    if (!inMonth(d)) setMonth(monthOf(d));
  };

  // effect:audited - roving focus follows the day the keyboard moved to, after the grid renders it
  React.useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    grid.current?.querySelector<HTMLElement>(`[data-day="${isoDay(target)}"] button`)?.focus();
  });

  useMountEffect(() => {
    if (initialFocus) grid.current?.querySelector<HTMLElement>('button[tabindex="0"]')?.focus();
  });

  const onKeyDown = (e: React.KeyboardEvent, day: Date) => {
    const moves: Record<string, () => Date> = {
      ArrowLeft: () => addDays(day, -1),
      ArrowRight: () => addDays(day, 1),
      ArrowUp: () => addDays(day, -7),
      ArrowDown: () => addDays(day, 7),
      PageUp: () => addMonths(day, e.shiftKey ? -12 : -1),
      PageDown: () => addMonths(day, e.shiftKey ? 12 : 1),
      Home: () => addDays(day, -day.getDay()),
      End: () => addDays(day, 6 - day.getDay()),
    };
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    e.stopPropagation();
    focusDay(move());
  };

  const pick = (day: Date) => {
    setFocused(day);
    if (!inMonth(day)) setMonth(monthOf(day));
    onSelect?.(sameDay(day, selected) ? undefined : day);
  };

  const navButton =
    "relative inline-flex size-9 cursor-pointer appearance-none items-center justify-center border-none bg-none p-0 text-inherit";

  return (
    <div className={className}>
      <div className="relative rounded-xl bg-surface-card p-3 text-content">
        <div className="relative flex max-w-fit flex-wrap gap-8">
          <nav
            aria-label="Navigation bar"
            className="absolute top-0 right-0 flex h-11 items-center"
          >
            <button
              type="button"
              className={navButton}
              aria-label="Go to the Previous Month"
              onClick={() => setMonth(addMonths(month, -1))}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              className={navButton}
              aria-label="Go to the Next Month"
              onClick={() => setMonth(addMonths(month, 1))}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </nav>
          <div>
            <div className="flex h-11 text-title font-bold">
              <span
                role="status"
                aria-live="polite"
                className="relative z-1 inline-flex items-center whitespace-nowrap"
              >
                {caption(month)}
              </span>
            </div>
            <table
              ref={grid}
              role="grid"
              aria-multiselectable="false"
              aria-label={caption(month)}
              className="border-collapse"
            >
              <thead aria-hidden="true">
                <tr>
                  {DAYS.map((d) => (
                    <th
                      key={d}
                      scope="col"
                      aria-label={d}
                      className="px-0 py-2 text-center text-[smaller] font-medium text-content-muted opacity-75"
                    >
                      {d.slice(0, 2)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {weeks.map((week) => (
                  <tr key={isoDay(week[0])}>
                    {week.map((day) => {
                      const outside = !inMonth(day);
                      const isSelected = sameDay(day, selected);
                      const isToday = sameDay(day, today);
                      if (outside && !showOutsideDays)
                        return <td key={isoDay(day)} className="size-11" />;
                      const label = [
                        isToday ? "Today" : "",
                        `${DAYS[day.getDay()]}, ${MONTHS[day.getMonth()]} ${ordinal(day.getDate())}, ${day.getFullYear()}`,
                        isSelected ? "selected" : "",
                      ]
                        .filter(Boolean)
                        .join(", ");
                      return (
                        <td
                          key={isoDay(day)}
                          role="gridcell"
                          data-day={isoDay(day)}
                          aria-selected={isSelected || undefined}
                          className={cn(
                            "size-11 p-0 text-center",
                            outside && "opacity-75",
                            isSelected && "text-title font-bold",
                          )}
                          style={isToday && !outside ? { color: SELECTED_BLUE } : undefined}
                        >
                          <button
                            type="button"
                            tabIndex={sameDay(day, target) ? 0 : -1}
                            aria-label={label}
                            onClick={() => pick(day)}
                            onKeyDown={(e) => onKeyDown(e, day)}
                            className="m-0 flex size-10.5 cursor-pointer items-center justify-center rounded-full border-2 border-transparent bg-none p-0 text-inherit [font:inherit]"
                            style={isSelected ? { borderColor: SELECTED_BLUE } : undefined}
                          >
                            {day.getDate()}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
Calendar.displayName = "Calendar";

export { Calendar };
