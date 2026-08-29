import { createTheme, type Theme } from "@mui/material/styles";

/**
 * Operations software, not a consumer product.
 *
 * The visual brief is "professional aviation operations software with a more
 * modern and approachable interface", and the practical consequence is
 * density: a controller scanning forty flights needs rows they can read at a
 * glance, not generous card padding. So the type scale is tight, tables are
 * compact by default, and colour is reserved for meaning.
 *
 * Status colour is separate from the brand accent on purpose. Air Soko's
 * identity blue never signals anything operational -- if something is blue it
 * is chrome, if it is amber or red it needs attention.
 */

const brand = {
  ink: "#0f1a24",
  slate: "#5a6b7a",
  accent: "#0f5f8f",
  accentBright: "#3d9ad1",
} as const;

const operational = {
  normal: "#1a7a55",
  caution: "#b5620d",
  critical: "#b3261e",
  info: "#2b6cb0",
} as const;

export function buildTheme(mode: "light" | "dark"): Theme {
  const dark = mode === "dark";

  return createTheme({
    cssVariables: true,
    palette: {
      mode,
      primary: { main: dark ? brand.accentBright : brand.accent },
      success: { main: operational.normal },
      warning: { main: operational.caution },
      error: { main: operational.critical },
      info: { main: operational.info },
      background: {
        default: dark ? "#0c1319" : "#f4f6f8",
        paper: dark ? "#141d25" : "#ffffff",
      },
      text: {
        primary: dark ? "#e4eaef" : brand.ink,
        secondary: dark ? "#8fa0ae" : brand.slate,
      },
      divider: dark ? "#233039" : "#dde3e8",
    },
    shape: { borderRadius: 6 },
    typography: {
      fontFamily: '"Inter var", "Segoe UI", system-ui, -apple-system, sans-serif',
      fontSize: 14,
      h1: { fontSize: "1.75rem", fontWeight: 650, letterSpacing: "-0.02em" },
      h2: { fontSize: "1.35rem", fontWeight: 650, letterSpacing: "-0.015em" },
      h3: { fontSize: "1.1rem", fontWeight: 600, letterSpacing: "-0.01em" },
      subtitle2: { fontWeight: 600 },
      // Codes, registrations and times line up in columns, so they get a
      // monospaced face with tabular figures wherever they appear.
      overline: {
        fontFamily: '"JetBrains Mono", "Cascadia Mono", ui-monospace, monospace',
        fontSize: "0.7rem",
        letterSpacing: "0.08em",
        fontWeight: 500,
      },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: { fontVariantNumeric: "tabular-nums" },
        },
      },
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: { root: { textTransform: "none", fontWeight: 600 } },
      },
      MuiTextField: { defaultProps: { size: "small" } },
      MuiSelect: { defaultProps: { size: "small" } },
      MuiChip: {
        styleOverrides: {
          root: { fontWeight: 600, fontSize: "0.72rem", letterSpacing: "0.02em" },
        },
      },
      MuiTooltip: { defaultProps: { arrow: true } },
      MuiPaper: {
        defaultProps: { elevation: 0 },
        styleOverrides: { root: { backgroundImage: "none" } },
      },
    },
  });
}
