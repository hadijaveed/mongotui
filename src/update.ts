import { basename, dirname, join } from "node:path";
import { chmodSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { CURRENT_VERSION, REPO } from "./version.ts";

// ── pure helpers (unit-tested) ──────────────────────────────────────────────

// GitHub redirects /releases/latest → /releases/tag/vX.Y.Z. Reading the tag off
// the redirect avoids the GitHub API (and its 60/hr unauthenticated rate limit).
export function parseTagFromLocation(location: string): string | null {
  const m = location.match(/\/releases\/tag\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]!) : null;
}

// Release assets are named mongotui-<os>-<arch> (see .github/workflows/release.yml).
export function assetBaseName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : null;
  const cpu = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : null;
  if (!os) throw new Error(`unsupported OS '${platform}' (prebuilt binaries target Linux and macOS)`);
  if (!cpu) throw new Error(`unsupported CPU '${arch}' (expected x64 or arm64)`);
  return `mongotui-${os}-${cpu}`;
}

// Compare vX.Y.Z strings. Returns <0 if a<b, 0 if equal, >0 if a>b. A prerelease
// (has a `-suffix`) sorts below the same core version's release.
export function compareVersions(a: string, b: string): number {
  const core = (v: string) =>
    v.replace(/^v/, "").split("-")[0]!.split(".").map((n) => parseInt(n, 10) || 0);
  const pa = core(a);
  const pb = core(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  const preA = a.includes("-");
  const preB = b.includes("-");
  if (preA && !preB) return -1;
  if (!preA && preB) return 1;
  return 0;
}

// A checksum file holds `<sha256>  <filename>` lines (two spaces, or `*name`
// for binary mode). Pull the digest for one asset.
export function parseSha256(contents: string, filename: string): string | null {
  for (const line of contents.split("\n")) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (m && m[2] === filename) return m[1]!.toLowerCase();
  }
  return null;
}

// ── runtime ─────────────────────────────────────────────────────────────────

const C = { dim: "\x1b[2m", cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", reset: "\x1b[0m" };
const info = (msg: string) => process.stdout.write(`${C.cyan}==>${C.reset} ${msg}\n`);
const note = (msg: string) => process.stdout.write(`${C.yellow}note:${C.reset} ${msg}\n`);

// True when running under `bun run` / `node` rather than as a compiled binary —
// self-replacement only makes sense for an installed standalone executable.
function isInterpreted(): boolean {
  const exe = basename(process.execPath).toLowerCase();
  return exe === "bun" || exe === "bun.exe" || exe === "node" || exe === "node.exe";
}

async function resolveLatestTag(): Promise<string> {
  const url = `https://github.com/${REPO}/releases/latest`;
  const res = await fetch(url, { redirect: "manual" });
  const location = res.headers.get("location");
  if (!location) {
    throw new Error(`could not resolve the latest release of ${REPO} (no redirect from ${url})`);
  }
  const tag = parseTagFromLocation(location);
  if (!tag) {
    throw new Error(`no published release found for ${REPO} yet (redirected to ${location})`);
  }
  return tag;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download failed (HTTP ${res.status}) — ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download failed (HTTP ${res.status}) — ${url}`);
  return res.text();
}

/**
 * `mongotui update` — check the latest GitHub release and, when newer, download
 * the matching prebuilt binary, verify its published SHA-256, and atomically
 * swap it in over the running executable.
 *
 * @returns process exit code (0 = up to date or updated, 1 = failed/blocked).
 */
export async function runUpdate(opts: { checkOnly?: boolean } = {}): Promise<number> {
  info(`current version: ${C.dim}v${CURRENT_VERSION}${C.reset}`);

  let latest: string;
  try {
    latest = await resolveLatestTag();
  } catch (err) {
    process.stderr.write(`${C.red}error:${C.reset} ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const cmp = compareVersions(CURRENT_VERSION, latest);
  if (cmp >= 0) {
    info(`${C.green}already up to date${C.reset} (latest is ${latest})`);
    return 0;
  }

  info(`new version available: ${C.green}${latest}${C.reset}`);
  if (opts.checkOnly) {
    info(`run ${C.cyan}mongotui update${C.reset} to install it`);
    return 0;
  }

  if (isInterpreted()) {
    note("running from source (bun/node), not an installed binary — nothing to replace.");
    process.stdout.write(
      `install the latest with:\n  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | sh\n`,
    );
    return 1;
  }

  // Resolve symlinks so we replace the real file, not the link that points to it.
  let target: string;
  try {
    target = realpathSync(process.execPath);
  } catch {
    target = process.execPath;
  }
  const dir = dirname(target);

  let base: string;
  try {
    base = assetBaseName();
  } catch (err) {
    process.stderr.write(`${C.red}error:${C.reset} ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const asset = `${base}.gz`; // .gz is universal; Bun.gunzipSync needs no external tool
  const assetUrl = `https://github.com/${REPO}/releases/download/${latest}/${asset}`;
  const sumsUrl = `https://github.com/${REPO}/releases/download/${latest}/${base}.sha256`;

  let gz: Uint8Array;
  let sums: string;
  try {
    info(`downloading ${asset} (${latest})`);
    [gz, sums] = await Promise.all([fetchBytes(assetUrl), fetchText(sumsUrl)]);
  } catch (err) {
    process.stderr.write(`${C.red}error:${C.reset} ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  // Verify the compressed payload against the published checksum before touching it.
  const expected = parseSha256(sums, asset);
  if (!expected) {
    process.stderr.write(`${C.red}error:${C.reset} no checksum entry for ${asset} in ${base}.sha256\n`);
    return 1;
  }
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(gz);
  const actual = hasher.digest("hex");
  if (actual !== expected) {
    process.stderr.write(
      `${C.red}error:${C.reset} checksum mismatch for ${asset}\n  expected: ${expected}\n  actual:   ${actual}\n` +
        `(the download may be corrupted or tampered with — not installing)\n`,
    );
    return 1;
  }
  info("checksum verified");

  let binary: Uint8Array;
  try {
    binary = Bun.gunzipSync(Uint8Array.from(gz));
  } catch (err) {
    process.stderr.write(`${C.red}error:${C.reset} decompress failed — ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  // Write beside the target, then rename over it: on Unix a running executable
  // can be replaced this way, and rename within a dir is atomic.
  const tmp = join(dir, `.mongotui-update-${process.pid}`);
  try {
    writeFileSync(tmp, binary, { mode: 0o755 });
    chmodSync(tmp, 0o755);
    renameSync(tmp, target);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
      process.stderr.write(
        `${C.red}error:${C.reset} no permission to replace ${target}\n` +
          `try one of:\n` +
          `  sudo mongotui update\n` +
          `  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | MONGOTUI_BIN_DIR="$HOME/.local/bin" sh\n`,
      );
    } else {
      process.stderr.write(`${C.red}error:${C.reset} could not install update — ${err instanceof Error ? err.message : String(err)}\n`);
    }
    return 1;
  }

  info(`${C.green}updated${C.reset} v${CURRENT_VERSION} ${C.dim}→${C.reset} ${latest}`);
  info(`installed to ${target}`);
  return 0;
}
