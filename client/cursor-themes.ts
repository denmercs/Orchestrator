import type { PluginThemeContribution } from "@getpaseo/plugin";

// Palettes approximate Cursor's default "Cursor Dark" and "Cursor Light" editor themes.
export const CURSOR_THEMES: PluginThemeContribution[] = [
  {
    id: "cursor-dark",
    name: "Cursor Dark",
    appearance: "dark",
    colors: {
      background: "#181818",
      foreground: "#E4E4E4",
      raised: "#1F1F1F",
      control: "#2A2A2A",
      border: "#2B2B2B",
      accent: "#A78BFA",
      mutedForeground: "#9A9A9A",
      ring: "#4A4A4A",
    },
  },
  {
    id: "cursor-light",
    name: "Cursor Light",
    appearance: "light",
    colors: {
      background: "#FCFCFC",
      foreground: "#141414",
      raised: "#F3F3F3",
      control: "#E8E8E8",
      border: "#E0E0E0",
      accent: "#7C3AED",
      mutedForeground: "#6B6B6B",
      ring: "#B5B5B5",
    },
  },
];
