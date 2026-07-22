/**
 * Central color palette. Every UI module imports the mutable `T`; `applyTheme`
 * mutates it in place so existing imports keep working while the whole tree
 * re-renders (the store bumps ui.themeName, which App subscribes to).
 */
import { RGBA } from "@opentui/core";

/** A color is either a hex/CSS string or an RGBA (used for terminal-default / ANSI-indexed). */
export type Color = string | RGBA;

export interface Theme {
  bg: Color;
  panel: Color;
  border: Color;
  focus: Color;
  text: Color;
  dim: Color;
  key: Color;
  str: Color;
  num: Color;
  fn: Color;
  op: Color;
  red: Color;
  amber: Color;
  selBg: Color;
  accent: Color;
  cyan: Color;
  bool: Color;
}

const mongo: Theme = {
  bg: "#0b1418",
  panel: "#0e191f",
  border: "#24343d",
  focus: "#00ed64",
  text: "#c2d0d8",
  dim: "#5c707b",
  key: "#6cb6ff",
  str: "#9ee8a5",
  num: "#f4bf75",
  fn: "#34bfd8",
  op: "#c792ea",
  red: "#ff6b6b",
  amber: "#f4bf75",
  selBg: "#143028",
  accent: "#00ed64",
  cyan: "#34bfd8",
  bool: "#c792ea",
};

const tokyonight: Theme = {
  bg: "#1a1b26", panel: "#16161e", border: "#292e42", focus: "#7aa2f7", text: "#c0caf5",
  dim: "#565f89", key: "#7aa2f7", str: "#9ece6a", num: "#ff9e64", fn: "#2ac3de", op: "#bb9af7",
  red: "#f7768e", amber: "#e0af68", selBg: "#283457", accent: "#7aa2f7", cyan: "#7dcfff", bool: "#bb9af7",
};

const catppuccin: Theme = {
  bg: "#1e1e2e", panel: "#181825", border: "#313244", focus: "#a6e3a1", text: "#cdd6f4",
  dim: "#6c7086", key: "#89b4fa", str: "#a6e3a1", num: "#fab387", fn: "#94e2d5", op: "#cba6f7",
  red: "#f38ba8", amber: "#f9e2af", selBg: "#313244", accent: "#cba6f7", cyan: "#89dceb", bool: "#cba6f7",
};

const gruvbox: Theme = {
  bg: "#282828", panel: "#1d2021", border: "#3c3836", focus: "#b8bb26", text: "#ebdbb2",
  dim: "#928374", key: "#83a598", str: "#b8bb26", num: "#d3869b", fn: "#8ec07c", op: "#fe8019",
  red: "#fb4934", amber: "#fabd2f", selBg: "#3c3836", accent: "#b8bb26", cyan: "#8ec07c", bool: "#d3869b",
};

const nord: Theme = {
  bg: "#2e3440", panel: "#272c36", border: "#3b4252", focus: "#88c0d0", text: "#d8dee9",
  dim: "#616e88", key: "#81a1c1", str: "#a3be8c", num: "#b48ead", fn: "#88c0d0", op: "#81a1c1",
  red: "#bf616a", amber: "#ebcb8b", selBg: "#434c5e", accent: "#88c0d0", cyan: "#8fbcbb", bool: "#b48ead",
};

const dracula: Theme = {
  bg: "#282a36", panel: "#21222c", border: "#44475a", focus: "#50fa7b", text: "#f8f8f2",
  dim: "#6272a4", key: "#8be9fd", str: "#50fa7b", num: "#ffb86c", fn: "#8be9fd", op: "#ff79c6",
  red: "#ff5555", amber: "#f1fa8c", selBg: "#44475a", accent: "#bd93f9", cyan: "#8be9fd", bool: "#bd93f9",
};

const oneDark: Theme = {
  bg: "#282c34", panel: "#21252b", border: "#3e4451", focus: "#61afef", text: "#abb2bf",
  dim: "#5c6370", key: "#61afef", str: "#98c379", num: "#d19a66", fn: "#56b6c2", op: "#c678dd",
  red: "#e06c75", amber: "#e5c07b", selBg: "#3e4451", accent: "#61afef", cyan: "#56b6c2", bool: "#c678dd",
};

const kanagawa: Theme = {
  bg: "#1f1f28", panel: "#16161d", border: "#2a2a37", focus: "#7e9cd8", text: "#dcd7ba",
  dim: "#727169", key: "#7e9cd8", str: "#98bb6c", num: "#ffa066", fn: "#7fb4ca", op: "#957fb8",
  red: "#e82424", amber: "#e6c384", selBg: "#2d4f67", accent: "#7e9cd8", cyan: "#6a9589", bool: "#957fb8",
};

// ANSI standard palette indices (0-7 normal, 8-15 bright) so colors come from
// the user's own terminal theme. bg/panel/text use terminal defaults directly.
const ANSI = {
  red: 1, green: 2, yellow: 3, blue: 4, magenta: 5, cyan: 6, brightBlack: 8,
} as const;
const terminal: Theme = {
  bg: RGBA.defaultBackground(),
  panel: RGBA.defaultBackground(),
  border: RGBA.fromIndex(ANSI.brightBlack),
  focus: RGBA.fromIndex(ANSI.green),
  text: RGBA.defaultForeground(),
  dim: RGBA.fromIndex(ANSI.brightBlack),
  key: RGBA.fromIndex(ANSI.blue),
  str: RGBA.fromIndex(ANSI.green),
  num: RGBA.fromIndex(ANSI.yellow),
  fn: RGBA.fromIndex(ANSI.cyan),
  op: RGBA.fromIndex(ANSI.magenta),
  red: RGBA.fromIndex(ANSI.red),
  amber: RGBA.fromIndex(ANSI.yellow),
  selBg: RGBA.fromIndex(ANSI.brightBlack),
  accent: RGBA.fromIndex(ANSI.green),
  cyan: RGBA.fromIndex(ANSI.cyan),
  bool: RGBA.fromIndex(ANSI.magenta),
};

export const THEMES: Record<string, Theme> = {
  mongo,
  terminal,
  tokyonight,
  catppuccin,
  gruvbox,
  nord,
  dracula,
  "one-dark": oneDark,
  kanagawa,
};

export const themeNames: string[] = Object.keys(THEMES);

/** Live mutable palette shared by all UI modules. */
export const T: Theme = { ...mongo };

/** Mutate T in place to the named theme. Unknown names are ignored. */
export function applyTheme(name: string | undefined): boolean {
  if (!name) return false;
  const theme = THEMES[name];
  if (!theme) return false;
  Object.assign(T, theme);
  return true;
}
