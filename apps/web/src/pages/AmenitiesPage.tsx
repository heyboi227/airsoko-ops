import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Box,
  Chip,
  MenuItem,
  Paper,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import CheckIcon from "@mui/icons-material/Check";
import BlockIcon from "@mui/icons-material/Block";
import RemoveIcon from "@mui/icons-material/Remove";
import { CABIN_CLASSES, type AmenityScope, type CabinClass } from "@airsoko/contracts";
import { SCOPE_EXPLANATIONS } from "@airsoko/domain";
import { ApiRequestError, apiRequest } from "../api/client.ts";

/**
 * Amenities, and the question that actually matters about them: when four
 * levels disagree, which one wins?
 *
 * The catalogue at the top is reference data. The matrix below it is the real
 * subject: one airframe, its cabins across the columns, and for each amenity
 * the level that settled it. An operator who wonders why a cabin shows no Wi-Fi
 * can read the answer off the cell rather than reason about precedence.
 */

interface AmenityRow {
  id: string;
  code: string;
  name: string;
  category: string;
  description: string | null;
  active: boolean;
  assignments: {
    aircraft: number;
    cabin: number;
    fare: number;
    flight: number;
    exclusions: number;
  };
}

interface ResolvedRow {
  amenityCode: string;
  name: string;
  category: string | null;
  included: boolean;
  decidedBy: AmenityScope;
  note: string | null;
  overridden: { scope: AmenityScope; included: boolean; note: string | null }[];
}

interface MatrixResponse {
  aircraft: { id: string; registration: string };
  cabins: { cabinClass: CabinClass; seatCount: number; amenities: ResolvedRow[] }[];
}

interface FleetOption {
  id: string;
  registration: string;
  type: { icaoTypeCode: string };
}

const SCOPE_COLOUR: Readonly<
  Record<AmenityScope, "default" | "info" | "secondary" | "warning">
> = {
  aircraft: "default",
  cabin: "info",
  fare_product: "secondary",
  flight: "warning",
};

const CABIN_LABELS: Readonly<Record<CabinClass, string>> = {
  business: "Business",
  premium_economy: "Premium Economy",
  economy: "Economy",
};

function MatrixCell({ entry }: { entry: ResolvedRow | undefined }) {
  if (!entry) {
    return (
      <Tooltip title="Nothing at any level says anything about this amenity here. Silence is not an exclusion.">
        <RemoveIcon fontSize="small" sx={{ color: "text.disabled" }} />
      </Tooltip>
    );
  }

  const overrides = entry.overridden
    .map((item) => `${SCOPE_EXPLANATIONS[item.scope]} said ${item.included ? "yes" : "no"}`)
    .join("; ");

  return (
    <Tooltip
      title={
        <>
          {entry.included ? "Included" : "Withheld"} because it is{" "}
          {SCOPE_EXPLANATIONS[entry.decidedBy]}.{entry.note ? ` ${entry.note}` : ""}
          {overrides ? ` Overrode: ${overrides}.` : ""}
        </>
      }
    >
      <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
        {entry.included ? (
          <CheckIcon fontSize="small" color="success" />
        ) : (
          <BlockIcon fontSize="small" color="error" />
        )}
        <Chip
          size="small"
          variant="outlined"
          color={SCOPE_COLOUR[entry.decidedBy]}
          label={entry.decidedBy === "fare_product" ? "fare" : entry.decidedBy}
          sx={{ height: 18, fontSize: 11 }}
        />
        {entry.overridden.length > 0 ? (
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            +{entry.overridden.length}
          </Typography>
        ) : null}
      </Stack>
    </Tooltip>
  );
}

export function AmenitiesPage() {
  const [aircraftId, setAircraftId] = useState("");

  const catalogue = useQuery({
    queryKey: ["amenities"],
    queryFn: () => apiRequest<{ items: AmenityRow[] }>("/api/amenities"),
  });

  const fleet = useQuery({
    queryKey: ["fleet", "options"],
    queryFn: () => apiRequest<{ items: FleetOption[] }>("/api/aircraft"),
  });

  const matrix = useQuery({
    queryKey: ["amenities", "matrix", aircraftId],
    queryFn: () => apiRequest<MatrixResponse>(`/api/amenities/matrix/${aircraftId}`),
    enabled: aircraftId !== "",
  });

  const cabins = matrix.data?.cabins ?? [];
  // Every amenity mentioned by any cabin, so a row exists even where only one
  // cabin has an answer -- that asymmetry is exactly what is worth seeing.
  const matrixCodes = [
    ...new Map(
      cabins.flatMap((cabin) => cabin.amenities).map((entry) => [entry.amenityCode, entry]),
    ).values(),
  ].sort((a, b) => (a.name < b.name ? -1 : 1));

  const categories = [...new Set((catalogue.data?.items ?? []).map((item) => item.category))];

  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h1">Amenities</Typography>
      <Typography variant="body2" sx={{ color: "text.secondary", mb: 2 }}>
        Amenities attach at four levels. When more than one applies, the narrowest wins —
        flight, then fare product, then cabin, then airframe — and at the same level a
        withdrawal beats a grant, because promising something absent is the worse mistake.
      </Typography>

      {catalogue.isError ? (
        <Alert severity="error" sx={{ mb: 2 }}>
          {catalogue.error instanceof ApiRequestError
            ? catalogue.error.message
            : "Could not load the amenity catalogue."}
        </Alert>
      ) : null}

      {/* --- Resolution matrix --- */}
      <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={2}
          sx={{ alignItems: { sm: "center" }, mb: 2 }}
        >
          <Box sx={{ flexGrow: 1 }}>
            <Typography variant="subtitle2">What a cabin actually offers</Typography>
            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              Resolved by the same function the booking flow will use, so the two cannot
              disagree.
            </Typography>
          </Box>
          <TextField
            select
            size="small"
            label="Aircraft"
            value={aircraftId}
            onChange={(event) => setAircraftId(event.target.value)}
            sx={{ minWidth: 240 }}
          >
            <MenuItem value="">Choose an airframe…</MenuItem>
            {(fleet.data?.items ?? []).map((item) => (
              <MenuItem key={item.id} value={item.id}>
                {item.registration} · {item.type.icaoTypeCode}
              </MenuItem>
            ))}
          </TextField>
        </Stack>

        {aircraftId === "" ? (
          <Alert severity="info" variant="outlined">
            Choose an airframe to see how its cabins resolve.
          </Alert>
        ) : matrix.isLoading ? (
          <Skeleton variant="rounded" height={220} />
        ) : (
          <TableContainer sx={{ overflowX: "auto" }}>
            <Table size="small" aria-label="Cabin amenity resolution">
              <TableHead>
                <TableRow>
                  <TableCell>Amenity</TableCell>
                  {cabins.map((cabin) => (
                    <TableCell key={cabin.cabinClass}>
                      {CABIN_LABELS[cabin.cabinClass]}
                      <Typography
                        variant="caption"
                        sx={{ color: "text.secondary", display: "block" }}
                      >
                        {cabin.seatCount} seats
                      </Typography>
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {matrixCodes.map((row) => (
                  <TableRow key={row.amenityCode} hover>
                    <TableCell>
                      <Typography variant="body2">{row.name}</Typography>
                      <Typography variant="caption" sx={{ color: "text.secondary" }}>
                        {row.category}
                      </Typography>
                    </TableCell>
                    {cabins.map((cabin) => (
                      <TableCell key={cabin.cabinClass}>
                        <MatrixCell
                          entry={cabin.amenities.find(
                            (entry) => entry.amenityCode === row.amenityCode,
                          )}
                        />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
                {matrixCodes.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={cabins.length + 1}>
                      <Typography variant="body2" sx={{ color: "text.secondary", py: 3 }}>
                        Nothing is assigned to this airframe or its cabins yet.
                      </Typography>
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Paper>

      {/* --- Catalogue --- */}
      <Typography variant="subtitle2" gutterBottom>
        Catalogue
      </Typography>
      <Paper variant="outlined">
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Amenity</TableCell>
                <TableCell>Category</TableCell>
                <TableCell align="right">Airframes</TableCell>
                <TableCell align="right">Cabins</TableCell>
                <TableCell align="right">Fares</TableCell>
                <TableCell align="right">Flights</TableCell>
                <TableCell align="right">Withdrawals</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {catalogue.isLoading
                ? Array.from({ length: 6 }, (_, index) => (
                    <TableRow key={index}>
                      {Array.from({ length: 7 }, (__, cell) => (
                        <TableCell key={cell}>
                          <Skeleton variant="text" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                : null}
              {(catalogue.data?.items ?? []).map((item) => (
                <TableRow key={item.id} hover>
                  <TableCell>
                    <Typography variant="body2">{item.name}</Typography>
                    <Typography variant="caption" sx={{ color: "text.secondary" }}>
                      {item.description ?? item.code}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Chip size="small" variant="outlined" label={item.category} />
                  </TableCell>
                  <TableCell align="right">{item.assignments.aircraft || "—"}</TableCell>
                  <TableCell align="right">{item.assignments.cabin || "—"}</TableCell>
                  <TableCell align="right">{item.assignments.fare || "—"}</TableCell>
                  <TableCell align="right">{item.assignments.flight || "—"}</TableCell>
                  <TableCell align="right">
                    {item.assignments.exclusions > 0 ? (
                      <Tooltip title="An assignment that withholds this amenity, overriding a broader level that grants it.">
                        <Chip
                          size="small"
                          color="error"
                          variant="outlined"
                          label={item.assignments.exclusions}
                        />
                      </Tooltip>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      <Typography variant="caption" sx={{ color: "text.secondary", display: "block", mt: 1.5 }}>
        {categories.length} categories across {CABIN_CLASSES.length} cabin classes. Editing
        assignments arrives with fare products in Phase 6; what is shown here is resolved live.
      </Typography>
    </Box>
  );
}
