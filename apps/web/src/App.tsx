import { useMemo, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Box, CircularProgress, CssBaseline, ThemeProvider } from "@mui/material";
import { buildTheme } from "./theme.ts";
import { useAuth } from "./auth/AuthContext.tsx";
import { AppShell } from "./shell/AppShell.tsx";
import { LoginPage } from "./pages/LoginPage.tsx";
import { AirportsPage } from "./pages/AirportsPage.tsx";
import { AmenitiesPage } from "./pages/AmenitiesPage.tsx";
import { DashboardPage } from "./pages/DashboardPage.tsx";
import { FleetPage } from "./pages/FleetPage.tsx";
import { PhasePlaceholder } from "./pages/PhasePlaceholder.tsx";
import { NAV_ITEMS } from "./shell/navigation.ts";

const THEME_KEY = "airsoko.colourScheme";

function readStoredMode(): "light" | "dark" {
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // Blocked site data: fall through to the OS preference.
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function App() {
  const { status } = useAuth();
  const [mode, setMode] = useState<"light" | "dark">(readStoredMode);
  const theme = useMemo(() => buildTheme(mode), [mode]);

  function toggleMode() {
    setMode((current) => {
      const next = current === "dark" ? "light" : "dark";
      try {
        window.localStorage.setItem(THEME_KEY, next);
      } catch {
        // A remembered preference is a convenience, not a requirement.
      }
      return next;
    });
  }

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      {status === "loading" ? (
        <Box sx={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
          <CircularProgress />
        </Box>
      ) : status === "anonymous" ? (
        <Routes>
          <Route path="*" element={<LoginPage />} />
        </Routes>
      ) : (
        <Routes>
          <Route element={<AppShell mode={mode} onToggleMode={toggleMode} />}>
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/network" element={<AirportsPage />} />
            <Route path="/fleet" element={<FleetPage />} />
            <Route path="/amenities" element={<AmenitiesPage />} />
            {/* Everything still to be built gets an honest placeholder; a section
                with no phase left to arrive in has a route above. */}
            {NAV_ITEMS.filter((item) => item.arrivesInPhase !== null).map((item) => (
              <Route key={item.path} path={item.path} element={<PhasePlaceholder />} />
            ))}
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Route>
        </Routes>
      )}
    </ThemeProvider>
  );
}
