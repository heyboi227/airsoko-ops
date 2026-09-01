import { Stack, ToggleButton, ToggleButtonGroup, Typography } from "@mui/material";
import { formatOperatingDays } from "@airsoko/contracts";

/**
 * The days a service operates.
 *
 * Monday first, because that is how a timetable reads, while the array stays
 * Sunday-first to match `Date.prototype.getUTCDay` -- the index a schedule is
 * expanded against. Getting those two the wrong way round shifts every
 * generated flight by a day, so the mapping lives in one place.
 */

const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0] as const;
const LABELS: Readonly<Record<number, string>> = {
  0: "Sun",
  1: "Mon",
  2: "Tue",
  3: "Wed",
  4: "Thu",
  5: "Fri",
  6: "Sat",
};

export function WeekdayPicker({
  value,
  onChange,
  label = "Operating days",
}: {
  value: boolean[];
  onChange: (next: boolean[]) => void;
  label?: string;
}) {
  const selected = MONDAY_FIRST.filter((index) => value[index]).map(String);

  return (
    <Stack spacing={0.5}>
      <Typography variant="caption" sx={{ color: "text.secondary" }}>
        {label}
      </Typography>
      <ToggleButtonGroup
        value={selected}
        onChange={(_event, next: string[]) => {
          const chosen = new Set(next.map(Number));
          onChange(Array.from({ length: 7 }, (_, index) => chosen.has(index)));
        }}
        size="small"
        aria-label={label}
      >
        {MONDAY_FIRST.map((index) => (
          <ToggleButton key={index} value={String(index)} sx={{ px: 1.25 }}>
            {LABELS[index]}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      <Typography variant="caption" sx={{ color: "text.secondary" }}>
        {formatOperatingDays(value)}
      </Typography>
    </Stack>
  );
}
