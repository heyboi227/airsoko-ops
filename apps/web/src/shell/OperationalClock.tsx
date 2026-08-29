import { useEffect, useState } from "react";
import { Stack, Tooltip, Typography } from "@mui/material";
import { formatLocalTime, formatOffset, offsetMinutesInZone } from "@airsoko/domain";

/**
 * UTC beside base-local time.
 *
 * Operations run on UTC and people live in local time, so an ops console shows
 * both or it invites the exact mistake this codebase is careful about
 * elsewhere. UTC is given primacy because that is what a schedule means.
 */

const BASE_ZONES: Readonly<Record<string, string>> = {
  BEG: "Europe/Belgrade",
  TIV: "Europe/Podgorica",
};

export function OperationalClock({ homeBase }: { homeBase: string }) {
  const [now, setNow] = useState(() => new Date().toISOString());

  useEffect(() => {
    // Aligned to the next whole second so the display does not visibly stutter.
    const timer = window.setInterval(() => setNow(new Date().toISOString()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const zone = BASE_ZONES[homeBase] ?? "Europe/Belgrade";
  const utc = `${now.slice(11, 16)}Z`;
  const local = formatLocalTime(now, zone);
  const offset = formatOffset(offsetMinutesInZone(now, zone));

  return (
    <Tooltip
      title={`${zone} is UTC${offset}. Schedules are stored as instants and shown in station local time.`}
    >
      <Stack
        direction="row"
        spacing={1.5}
        sx={{ alignItems: "baseline", fontVariantNumeric: "tabular-nums" }}
      >
        <Typography variant="body2" sx={{ fontWeight: 700 }}>
          {utc}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {homeBase} {local}
        </Typography>
      </Stack>
    </Tooltip>
  );
}
