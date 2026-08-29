import { useState, type FormEvent } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Divider,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { ROLE_LABELS, type Role } from "@airsoko/contracts";
import { useAuth } from "../auth/AuthContext.tsx";
import { ApiRequestError } from "../api/client.ts";

/**
 * Demonstration accounts, listed on the sign-in screen.
 *
 * Not a security lapse -- a deliberate affordance. The permission model is one
 * of the things this product is meant to show, and nobody can see a boundary
 * they cannot cross. The seed refuses to run outside development for exactly
 * this reason.
 */
const DEMO_ACCOUNTS: readonly { email: string; role: Role }[] = [
  { email: "admin@airsoko.example", role: "super_admin" },
  { email: "ops@airsoko.example", role: "ops_controller" },
  { email: "fleet@airsoko.example", role: "fleet_manager" },
  { email: "crew@airsoko.example", role: "crew_scheduler" },
  { email: "bookings@airsoko.example", role: "booking_admin" },
  { email: "commercial@airsoko.example", role: "commercial_manager" },
];

const DEMO_PASSWORD = "airsoko-demo";

export function LoginPage() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState("ops@airsoko.example");
  const [password, setPassword] = useState(DEMO_PASSWORD);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signIn(email, password);
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError
          ? caught.message
          : "Could not reach the operations API. Is it running?",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box
      sx={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        bgcolor: "background.default",
        p: 3,
      }}
    >
      <Card sx={{ width: "100%", maxWidth: 780, border: 1, borderColor: "divider" }}>
        <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" } }}>
          <CardContent sx={{ p: 4 }}>
            <Typography variant="overline" color="primary">
              Operations Console
            </Typography>
            <Typography variant="h1" sx={{ mt: 1, mb: 0.5 }}>
              Air Soko
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              Sign in to the operations administration platform.
            </Typography>

            <form onSubmit={handleSubmit} noValidate>
              <Stack spacing={2}>
                <TextField
                  label="Email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="username"
                  required
                  fullWidth
                  autoFocus
                />
                <TextField
                  label="Password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  required
                  fullWidth
                />
                {error ? <Alert severity="error">{error}</Alert> : null}
                <Button
                  type="submit"
                  variant="contained"
                  size="large"
                  disabled={busy}
                  fullWidth
                >
                  {busy ? "Signing in…" : "Sign in"}
                </Button>
              </Stack>
            </form>
          </CardContent>

          <Box
            sx={{
              p: 4,
              bgcolor: "action.hover",
              borderLeft: { md: 1 },
              borderColor: "divider",
            }}
          >
            <Typography variant="subtitle2" gutterBottom>
              Demonstration accounts
            </Typography>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: "block", mb: 2 }}
            >
              All use the password <code>{DEMO_PASSWORD}</code>. Each role sees a different
              navigation set and is refused different actions — at the API, not just in the
              interface.
            </Typography>
            <Divider sx={{ mb: 1.5 }} />
            <Stack spacing={0.75}>
              {DEMO_ACCOUNTS.map((account) => (
                <Box
                  key={account.email}
                  component="button"
                  type="button"
                  onClick={() => {
                    setEmail(account.email);
                    setPassword(DEMO_PASSWORD);
                  }}
                  sx={{
                    textAlign: "left",
                    border: 0,
                    background: "none",
                    cursor: "pointer",
                    p: 0.5,
                    borderRadius: 1,
                    font: "inherit",
                    color: "inherit",
                    "&:hover": { bgcolor: "action.selected" },
                    "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main" },
                  }}
                >
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {ROLE_LABELS[account.role]}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {account.email}
                  </Typography>
                </Box>
              ))}
            </Stack>
          </Box>
        </Box>
      </Card>
    </Box>
  );
}
