/**
 * Credential storage that keeps passwords OUT of config.json.
 *
 * Saved connection URIs are stored password-stripped (`mongodb://user@host/db`);
 * the password is put in an OS secret store, auto-detected in this order:
 *   1. macOS `security` keychain
 *   2. Linux `secret-tool` (libsecret) — only if the binary is present + working
 *   3. an AES-256-GCM encrypted file `<configdir>/credentials.enc`, keyed by
 *      scrypt(machineId + per-install salt), always written mode 0600.
 *
 * Every function is synchronous (spawnSync — the app already uses it for $EDITOR)
 * and NEVER throws: failures degrade to returning null / a no-op and record a
 * single toast-able error string (see `secretsError`).
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { configDir, loadConfig, saveConfig, type SavedConnection } from "./config.ts";

const SERVICE = "mongotui";

type BackendKind = "keychain" | "libsecret" | "file";

let lastError: string | null = null;

/** The most recent failure string (toast-able), or null. */
export function secretsError(): string | null {
  return lastError;
}

// ---- URI credential split / join -------------------------------------------

// Deliberately NOT `new URL()` — multi-host `host1:27017,host2:27017` URIs are
// not valid WHATWG URLs and would throw.
// `[^@]*` (not `+`) so an explicit empty password `user:@host` is recognized
// and stripped rather than silently persisted as plaintext.
const CRED_RE = /^(mongodb(?:\+srv)?:\/\/)([^:@/]+):([^@]*)@(.+)$/i;
const USER_RE = /^(mongodb(?:\+srv)?:\/\/)([^@/]+)@(.+)$/i;

/** Split `mongodb://user:pass@host/db` into stripped uri + decoded password. */
export function splitCredentials(uri: string): { uri: string; password: string | null } {
  const m = CRED_RE.exec(uri);
  if (!m) return { uri, password: null };
  const [, scheme, user, rawPass, rest] = m;
  let password = rawPass!;
  try {
    password = decodeURIComponent(rawPass!);
  } catch {
    /* malformed percent-encoding — keep the raw form */
  }
  return { uri: `${scheme}${user}@${rest}`, password };
}

/** Re-attach a password to a stripped `mongodb://user@host/db` uri (re-encoding it). */
export function joinCredentials(uri: string, password: string): string {
  const m = USER_RE.exec(uri);
  if (!m) return uri; // no user segment to attach a password to
  const [, scheme, user, rest] = m;
  return `${scheme}${user}:${encodeURIComponent(password)}@${rest}`;
}

// ---- Backend detection ------------------------------------------------------

let cachedPlatform: BackendKind | null = null;

function backendKind(): BackendKind {
  // The env override is honored on EVERY call (not cached) so tests/CI can pin a
  // backend regardless of what an earlier call detected in the same process.
  const override = process.env.MONGOTUI_SECRETS;
  if (override === "keychain" || override === "libsecret" || override === "file") return override;
  if (cachedPlatform) return cachedPlatform;
  cachedPlatform = detectPlatform();
  return cachedPlatform;
}

function detectPlatform(): BackendKind {
  if (process.platform === "darwin") return "keychain";
  if (process.platform === "linux") {
    try {
      // A working `secret-tool` returns exit 1 for "not found"; only ENOENT
      // (binary missing) means we must fall back to the encrypted file.
      const r = spawnSync("secret-tool", ["lookup", "x", "y"]);
      if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") return "file";
      return "libsecret";
    } catch {
      return "file";
    }
  }
  return "file";
}

/** Human-readable name of the active backend, for display. */
export function secretsBackend(): "keychain" | "libsecret" | "encrypted file" {
  const kind = backendKind();
  return kind === "file" ? "encrypted file" : kind;
}

// ---- Public API -------------------------------------------------------------

export function storeSecret(account: string, secret: string): void {
  lastError = null;
  try {
    switch (backendKind()) {
      case "keychain":
        keychainStore(account, secret);
        return;
      case "libsecret":
        libsecretStore(account, secret);
        return;
      default:
        fileStore(account, secret);
    }
  } catch (e) {
    lastError = `could not save password: ${message(e)}`;
  }
}

export function getSecret(account: string): string | null {
  lastError = null;
  try {
    switch (backendKind()) {
      case "keychain":
        return keychainGet(account);
      case "libsecret":
        return libsecretGet(account);
      default:
        return fileGet(account);
    }
  } catch (e) {
    lastError = `could not read password: ${message(e)}`;
    return null;
  }
}

export function deleteSecret(account: string): void {
  lastError = null;
  try {
    switch (backendKind()) {
      case "keychain":
        keychainDelete(account);
        return;
      case "libsecret":
        libsecretDelete(account);
        return;
      default:
        fileDelete(account);
    }
  } catch (e) {
    lastError = `could not delete password: ${message(e)}`;
  }
}

/** Throw when a spawnSync result signals failure (missing binary, signal, nonzero exit). */
function checkSpawn(what: string, r: ReturnType<typeof spawnSync>): void {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  if (r.signal) throw new Error(`${what}: killed by ${r.signal}`);
  if (r.status !== 0) {
    const err = (r.stderr ?? "").toString().split("\n", 1)[0]?.trim();
    throw new Error(`${what}: exit ${r.status}${err ? ` (${err})` : ""}`);
  }
}

/**
 * Store then read back: the ONLY trustworthy success signal. Backends can
 * "succeed" while doing nothing (libsecret without a D-Bus session, locked
 * keychains) — callers that are about to strip a password from config.json
 * must use this, never bare storeSecret.
 */
export function storeSecretVerified(account: string, secret: string): boolean {
  storeSecret(account, secret);
  if (lastError) return false;
  if (getSecret(account) !== secret) {
    lastError = `secret store (${secretsBackend()}) did not persist the password`;
    return false;
  }
  return true;
}

// ---- keychain (macOS) -------------------------------------------------------

function keychainStore(account: string, secret: string): void {
  // `security -i` reads commands from stdin, keeping the secret out of argv
  // (visible to every user via `ps`). Quotes/backslashes are escaped for the
  // security command parser.
  const esc = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const r = spawnSync("security", ["-i"], {
    input: `add-generic-password -U -s ${esc(SERVICE)} -a ${esc(account)} -w ${esc(secret)}\n`,
    encoding: "utf8",
  });
  checkSpawn("security add-generic-password", r);
}

function keychainGet(account: string): string | null {
  const r = spawnSync("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"], {
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  const out = (r.stdout ?? "").replace(/\n$/, "");
  return out.length ? out : null;
}

function keychainDelete(account: string): void {
  // exit 44 = item not found — deleting a non-existent secret is fine.
  const r = spawnSync("security", ["delete-generic-password", "-s", SERVICE, "-a", account]);
  if (r.error) throw new Error(`security delete: ${r.error.message}`);
}

// ---- libsecret (Linux) ------------------------------------------------------

function libsecretStore(account: string, secret: string): void {
  const r = spawnSync(
    "secret-tool",
    ["store", "--label", `mongotui ${account}`, "service", SERVICE, "account", account],
    { input: secret, encoding: "utf8" },
  );
  // A present-but-broken secret-tool (no D-Bus session on a headless box) exits
  // nonzero here — that MUST surface as failure, not silent credential loss.
  checkSpawn("secret-tool store", r);
}

function libsecretGet(account: string): string | null {
  const r = spawnSync("secret-tool", ["lookup", "service", SERVICE, "account", account], {
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  const out = (r.stdout ?? "").replace(/\n$/, "");
  return out.length ? out : null;
}

function libsecretDelete(account: string): void {
  spawnSync("secret-tool", ["clear", "service", SERVICE, "account", account]);
}

// ---- encrypted file ---------------------------------------------------------

interface Entry {
  iv: string;
  tag: string;
  data: string;
}
interface Vault {
  v: 1;
  salt: string;
  entries: Record<string, Entry>;
}

function vaultPath(): string {
  return join(configDir(), "credentials.enc");
}

function readVault(): Vault | null {
  try {
    const raw = readFileSync(vaultPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.v === 1 && typeof parsed.salt === "string" && parsed.entries) {
      return parsed as Vault;
    }
  } catch {
    /* missing or corrupt — treated as no vault */
  }
  return null;
}

function writeVault(vault: Vault): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  chmodSync(configDir(), 0o700);
  // Atomic (0600 temp + rename): a crash can't truncate the vault, and a
  // symlinked credentials.enc is replaced rather than followed.
  const tmp = vaultPath() + `.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(vault), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, vaultPath());
  chmodSync(vaultPath(), 0o600);
}

function keyFor(salt: string): Buffer {
  return scryptSync(machineId(), Buffer.from(salt, "hex"), 32);
}

function fileStore(account: string, secret: string): void {
  const vault: Vault = readVault() ?? { v: 1, salt: randomBytes(16).toString("hex"), entries: {} };
  const key = keyFor(vault.salt);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  vault.entries[account] = { iv: iv.toString("hex"), tag: tag.toString("hex"), data: data.toString("hex") };
  writeVault(vault);
}

function fileGet(account: string): string | null {
  const vault = readVault();
  const entry = vault?.entries[account];
  if (!vault || !entry) return null;
  try {
    const key = keyFor(vault.salt);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(entry.iv, "hex"));
    decipher.setAuthTag(Buffer.from(entry.tag, "hex"));
    const out = Buffer.concat([decipher.update(Buffer.from(entry.data, "hex")), decipher.final()]);
    return out.toString("utf8");
  } catch {
    // Wrong machine / tampered salt / corrupt entry → auth failure. Return null,
    // never garbage.
    return null;
  }
}

function fileDelete(account: string): void {
  const vault = readVault();
  if (!vault || !vault.entries[account]) return;
  delete vault.entries[account];
  writeVault(vault);
}

/** Stable per-machine identifier used as the scrypt password. Never throws. */
function machineId(): string {
  for (const p of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const v = readFileSync(p, "utf8").trim();
      if (v) return v;
    } catch {
      /* try the next source */
    }
  }
  if (process.platform === "darwin") {
    try {
      const r = spawnSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8" });
      const m = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(r.stdout ?? "");
      if (m) return m[1]!;
    } catch {
      /* fall through */
    }
  }
  return `${hostname()}:${process.getuid?.() ?? 0}`;
}

// ---- one-time config migration ---------------------------------------------

/**
 * Move any password still embedded in a saved connection (or a lastConnection
 * stored as a raw URI) into the secret store, and rewrite config.json stripped.
 * Silent + idempotent on success; returns an error string on failure (config
 * left untouched). Safe to call every boot before the first connect.
 */
export function migrateSecrets(): { migrated: boolean; error?: string } {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    return { migrated: false, error: message(e) };
  }

  const connections = config.connections ?? [];
  let changed = false;
  const nextConnections: SavedConnection[] = [];

  try {
    for (const c of connections) {
      const { uri, password } = splitCredentials(c.uri);
      if (password !== null) {
        // Verified store-then-read: a backend that silently drops the secret
        // (libsecret without D-Bus, locked keychain) must NOT strip the config.
        if (!storeSecretVerified(c.name, password)) {
          return { migrated: false, error: secretsError() ?? "secret store not working" };
        }
        nextConnections.push({ ...c, uri });
        changed = true;
      } else {
        nextConnections.push(c);
      }
    }

    // Defensive: some builds may have stashed a raw URI (with password) in
    // lastConnection rather than a saved-connection name.
    let nextLast = config.lastConnection;
    if (typeof nextLast === "string" && CRED_RE.test(nextLast)) {
      const { uri, password } = splitCredentials(nextLast);
      if (password !== null) {
        if (!storeSecretVerified("__last", password)) {
          return { migrated: false, error: secretsError() ?? "secret store not working" };
        }
        nextLast = uri;
        changed = true;
      }
    }

    if (!changed) return { migrated: false };
    if (!saveConfig({ connections: nextConnections, lastConnection: nextLast })) {
      return { migrated: false, error: "could not rewrite config.json — passwords left in place" };
    }
    // Trust nothing: re-read the file and confirm no connection still embeds a password.
    const after = loadConfig();
    const leftover = (after.connections ?? []).some((c) => splitCredentials(c.uri).password !== null)
      || (typeof after.lastConnection === "string" && CRED_RE.test(after.lastConnection));
    if (leftover) return { migrated: false, error: "config rewrite did not stick — passwords left in place" };
    return { migrated: true };
  } catch (e) {
    return { migrated: false, error: message(e) };
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
