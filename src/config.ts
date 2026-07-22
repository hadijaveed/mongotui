/**
 * Persistent config at ~/.config/mongotui/config.json (or $XDG_CONFIG_HOME).
 * Best-effort: reads never throw, writes are read-merge-write with pretty JSON.
 */
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface SavedConnection {
  name: string;
  uri: string;
}

export interface Config {
  theme?: string;
  connections?: SavedConnection[];
  lastConnection?: string;
}

function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "mongotui");
}

function configPath(): string {
  return join(configDir(), "config.json");
}

export function loadConfig(): Config {
  try {
    const raw = readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Config;
    return {};
  } catch {
    return {};
  }
}

/**
 * Accept bare `host`, `host:port`, or `user:pass@host:port/db` and prepend the
 * default `mongodb://` scheme. An explicit `mongodb://` or `mongodb+srv://` the
 * user typed is preserved verbatim. The full normalized URI is what we persist.
 */
export function normalizeUri(raw: string): string {
  const s = raw.trim();
  if (!s) return s;
  if (/^mongodb(\+srv)?:\/\//i.test(s)) return s;
  return `mongodb://${s}`;
}

export function saveConfig(patch: Partial<Config>): void {
  try {
    const current = loadConfig();
    const next: Config = { ...current, ...patch };
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify(next, null, 2) + "\n", "utf8");
  } catch {
    /* config persistence is best-effort; never crash the app */
  }
}
