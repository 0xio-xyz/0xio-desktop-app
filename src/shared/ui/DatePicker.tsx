import * as React from "react";
import { Calendar as CalendarIcon } from "src/shared/ui/icons";
import { cn } from "src/lib/cn";
import { monthDayYear } from "src/lib/dates";
import { Calendar } from "src/shared/ui/Calendar";
import { Popover, PopoverContent, PopoverTrigger } from "src/shared/ui/Popover";

interface DatePickerProps {
  date: Date | undefined;
  onDateChange: (date: Date | undefined) => void;
  showTime?: boolean;
  className?: string;
  placeholder?: string;
}

function DatePicker({
  date,
  onDateChange,
  showTime = false,
  className,
  placeholder = "Pick a date",
}: DatePickerProps) {
  const [hours, setHours] = React.useState(() =>
    date ? String(date.getUTCHours()).padStart(2, "0") : "00",
  );
  const [minutes, setMinutes] = React.useState(() =>
    date ? String(date.getUTCMinutes()).padStart(2, "0") : "00",
  );

  const handleSelect = React.useCallback(
    (selected: Date | undefined) => {
      if (!selected) {
        onDateChange(undefined);
        return;
      }
      // Build UTC date from the local date's year/month/day to avoid timezone shift
      const utc = new Date(
        Date.UTC(
          selected.getFullYear(),
          selected.getMonth(),
          selected.getDate(),
          parseInt(hours) || 0,
          parseInt(minutes) || 0,
          0,
        ),
      );
      onDateChange(utc);
    },
    [onDateChange, hours, minutes],
  );

  const handleTimeChange = React.useCallback(
    (h: string, m: string) => {
      setHours(h);
      setMinutes(m);
      if (date) {
        const utc = new Date(
          Date.UTC(
            date.getUTCFullYear(),
            date.getUTCMonth(),
            date.getUTCDate(),
            parseInt(h) || 0,
            parseInt(m) || 0,
            0,
          ),
        );
        onDateChange(utc);
      }
    },
    [date, onDateChange],
  );

  // The calendar works in local time: show a local Date with the UTC date's fields.
  const calendarDate = React.useMemo(() => {
    if (!date) return undefined;
    return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  }, [date]);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "flex h-8 w-full cursor-pointer items-center justify-start gap-2 rounded-full bg-surface-highlight px-3.5 text-[0.8125rem] text-content transition-colors duration-200 ease-out hover:bg-(--bg-3)",
            "outline-none focus-visible:ring-2 focus-visible:ring-accent",
            !date && "text-content-muted",
            className,
          )}
        >
          <CalendarIcon className="h-3.5 w-3.5 text-content-muted shrink-0" />
          {date && calendarDate ? (
            <span>
              {showTime
                ? `${monthDayYear(calendarDate)} ${hours}:${minutes} UTC`
                : monthDayYear(calendarDate)}
            </span>
          ) : (
            <span>{placeholder}</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar selected={calendarDate} onSelect={handleSelect} initialFocus />
        {showTime && (
          <div className="flex items-center gap-2 px-3 py-2">
            <span className="text-[0.625rem] text-content-muted">UTC</span>
            <input
              type="text"
              inputMode="numeric"
              maxLength={2}
              value={hours}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, "").slice(0, 2);
                if (parseInt(v) <= 23 || v === "") handleTimeChange(v, minutes);
              }}
              className="w-8 rounded-md bg-surface-highlight px-1 py-1 text-center text-xs text-content focus:outline-none"
              placeholder="HH"
            />
            <span className="text-xs text-content-muted">:</span>
            <input
              type="text"
              inputMode="numeric"
              maxLength={2}
              value={minutes}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, "").slice(0, 2);
                if (parseInt(v) <= 59 || v === "") handleTimeChange(hours, v);
              }}
              className="w-8 rounded-md bg-surface-highlight px-1 py-1 text-center text-xs text-content focus:outline-none"
              placeholder="MM"
            />
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
DatePicker.displayName = "DatePicker";

export { DatePicker };
