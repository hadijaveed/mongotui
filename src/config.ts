/**
 * Persistent config at ~/.config/mongotui/config.json (or $XDG_CONFIG_HOME).
 * Best-effort: reads never throw, writes are read-merge-write with pretty JSON.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
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
  /** Remembered results view: "docs" (default) or "table". */
  defaultView?: "docs" | "table";
}

export function configDir(): string {
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

/**
 * Returns true only when the write actually landed. Write is atomic (0600 temp
 * file in the same dir + rename) so a crash can't truncate the config and a
 * symlinked config.json is replaced rather than followed.
 */
export function saveConfig(patch: Partial<Config>): boolean {
  try {
    const current = loadConfig();
    const next: Config = { ...current, ...patch };
    // Saved connection URIs can embed credentials — keep the dir and file
    // owner-only (and repair perms on files created by older versions).
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    chmodSync(configDir(), 0o700);
    const tmp = configPath() + `.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, configPath());
    chmodSync(configPath(), 0o600);
    return true;
  } catch {
    /* config persistence is best-effort; never crash the app */
    return false;
  }
}
