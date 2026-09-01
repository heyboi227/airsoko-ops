import { Box, Chip, Paper, Stack, Typography } from "@mui/material";
import { useLocation } from "react-router-dom";
import { NAV_ITEMS } from "../shell/navigation.ts";

/**
 * What an unbuilt section shows.
 *
 * The brief rules out "fake controls that do nothing", which makes a
 * convincing-looking mock worse than nothing here. This says what the section
 * will contain and which phase builds it -- readable, honest, and impossible
 * to mistake for finished work.
 */
export function PhasePlaceholder() {
  const location = useLocation();
  const item = NAV_ITEMS.find((entry) => location.pathname.startsWith(entry.path));

  if (!item) {
    return (
      <Box sx={{ p: 4 }}>
        <Typography variant="h2">Not found</Typography>
        <Typography color="text.secondary">No section matches this address.</Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 4, maxWidth: 720 }}>
      <Stack direction="row" spacing={1.5} sx={{ alignItems: "center", mb: 1.5 }}>
        <Typography variant="h1">{item.label}</Typography>
        <Chip
          label={`Phase ${item.arrivesInPhase}`}
          size="small"
          color="primary"
          variant="outlined"
        />
      </Stack>

      <Paper variant="outlined" sx={{ p: 3 }}>
        <Typography variant="subtitle2" gutterBottom>
          Not built yet
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {item.summary}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Built so far: the schema and the mutation pipeline, role-based access, Airports &amp;
          Routes, the Fleet and its amenities, and the Flight Schedule. Everything above arrives
          in the phase named beside it, and this page exists so that a gap reads as a gap rather
          than as a screen that does not work.
        </Typography>
      </Paper>
    </Box>
  );
}
