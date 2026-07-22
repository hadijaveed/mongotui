/**
 * Shared theme-picker and connections-manager control logic, invoked from both
 * keyboard handlers (App) and mouse clicks (modals).
 */
import { useStore } from "../state/store.ts";
import { createMongoService } from "../data/service.ts";
import { loadConfig, normalizeUri, saveConfig, type SavedConnection } from "../config.ts";
import { deleteSecret, getSecret, joinCredentials, secretsError, splitCredentials, storeSecretVerified } from "../secrets.ts";
import { applyTheme, T, themeNames } from "./theme.ts";

/** Resolve a saved (password-stripped) connection URI to a live URI with its secret re-attached. */
function resolveUri(name: string, storedUri: string): string {
  const secret = getSecret(name);
  return secret ? joinCredentials(storedUri, secret) : storedUri;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function savedConnections(): SavedConnection[] {
  return loadConfig().connections ?? [];
}

export function maskUri(uri: string): string {
  return uri.replace(/(\/\/[^:/@]+:)[^@]*@/, "$1•••@");
}

/** UI display form: mask credentials AND strip the mongodb:// scheme. */
export function displayUri(uri: string): string {
  return maskUri(uri).replace(/^mongodb(\+srv)?:\/\//i, "");
}

/** Explain the current find query and show the plan summary in a modal. */
export async function openExplain(): Promise<void> {
  const summary = await useStore.getState().explain();
  if (!summary) return;
  useStore.getState().setModal({
    kind: "confirm",
    title: `explain · ${summary.plan}`,
    lines: [
      `docsExamined  ${summary.docsExamined ?? "—"}`,
      `keysExamined  ${summary.keysExamined ?? "—"}`,
      `nReturned     ${summary.nReturned ?? "—"}`,
      `executionMs   ${summary.executionMs ?? "—"}`,
    ],
    onYes: () => useStore.getState().setModal(null),
  });
}

// ---- Theme picker ----------------------------------------------------------

export function openThemePicker(): void {
  const s = useStore.getState();
  const current = s.ui.themeName;
  const sel = Math.max(0, themeNames.indexOf(current));
  s.setThemeModal({ sel, previous: current });
}

export function previewThemeAt(sel: number): void {
  const s = useStore.getState();
  const m = s.ui.themeModal;
  if (!m) return;
  const name = themeNames[((sel % themeNames.length) + themeNames.length) % themeNames.length]!;
  applyTheme(name);
  s.setThemeModal({ ...m, sel: themeNames.indexOf(name) });
  s.setThemeName(name);
}

export function moveThemeSel(dir: 1 | -1): void {
  const m = useStore.getState().ui.themeModal;
  if (!m) return;
  previewThemeAt(m.sel + dir);
}

export function keepTheme(): void {
  const s = useStore.getState();
  const m = s.ui.themeModal;
  if (!m) return;
  const name = themeNames[m.sel]!;
  applyTheme(name);
  s.setThemeName(name);
  saveConfig({ theme: name });
  s.setThemeModal(null);
  s.toast(`theme: ${name}`, T.accent);
}

export function revertTheme(): void {
  const s = useStore.getState();
  const m = s.ui.themeModal;
  if (!m) return;
  applyTheme(m.previous);
  s.setThemeName(m.previous);
  s.setThemeModal(null);
}

// ---- Connections manager ---------------------------------------------------

export function openConnections(): void {
  const s = useStore.getState();
  const conns = savedConnections();
  const idx = conns.findIndex((c) => c.name === s.conn.name);
  s.setConnModal({
    sel: idx < 0 ? 0 : idx,
    adding: false,
    formField: "name",
    formName: "",
    formUri: "",
    formCursor: 0,
    error: null,
  });
}

export function connMove(dir: 1 | -1): void {
  const s = useStore.getState();
  const m = s.ui.connModal;
  if (!m || m.adding) return;
  const list = savedConnections();
  if (list.length === 0) return;
  const sel = (m.sel + dir + list.length) % list.length;
  s.setConnModal({ ...m, sel });
}

export function connSelect(sel: number): void {
  const s = useStore.getState();
  const m = s.ui.connModal;
  if (!m || m.adding) return;
  s.setConnModal({ ...m, sel });
}

export function connStartAdd(): void {
  const s = useStore.getState();
  const m = s.ui.connModal;
  if (!m) return;
  s.setConnModal({ ...m, adding: true, formField: "name", formName: "", formUri: "", formCursor: 0, error: null });
}

export function connCancelAdd(): void {
  const s = useStore.getState();
  const m = s.ui.connModal;
  if (!m) return;
  s.setConnModal({ ...m, adding: false, error: null });
}

/** Ping the highlighted saved connection to check reachability, without switching to it. */
export async function connTestSelected(): Promise<void> {
  const s = useStore.getState();
  const m = s.ui.connModal;
  if (!m || m.adding) return;
  const c = savedConnections()[m.sel];
  if (!c) return;
  s.toast(`testing ${c.name}…`, T.dim);
  let probe: ReturnType<typeof createMongoService> | null = null;
  try {
    probe = createMongoService(resolveUri(c.name, c.uri));
    const info = await probe.connect();
    s.toast(`✓ ${c.name} reachable · ${Math.round(info.latencyMs ?? 0)}ms`, T.accent);
  } catch (e) {
    s.toast(`✗ ${c.name}: ${msg(e)}`, T.red);
  } finally {
    try { await probe?.close(); } catch { /* ignore */ }
  }
}

export async function connConnectSelected(): Promise<void> {
  const s = useStore.getState();
  const m = s.ui.connModal;
  if (!m || m.adding) return;
  const list = savedConnections();
  const c = list[m.sel];
  if (!c) return;
  s.setConnModal(null);
  await s.switchConnection(c.name, resolveUri(c.name, c.uri));
}

export function connDeleteSelected(): void {
  const s = useStore.getState();
  const m = s.ui.connModal;
  if (!m || m.adding) return;
  const list = savedConnections();
  const c = list[m.sel];
  if (!c) return;
  const rest = list.filter((_, i) => i !== m.sel);
  saveConfig({ connections: rest });
  deleteSecret(c.name);
  s.setConnModal({ ...m, sel: Math.max(0, Math.min(m.sel, rest.length - 1)) });
  s.toast(`deleted ${c.name}`, T.dim);
}

export async function connSubmitAdd(): Promise<void> {
  const s = useStore.getState();
  const m = s.ui.connModal;
  if (!m || !m.adding) return;
  const name = m.formName.trim();
  const uri = normalizeUri(m.formUri.trim());
  if (!name || !uri) {
    s.setConnModal({ ...m, error: "name and uri are required" });
    return;
  }
  let probe: ReturnType<typeof createMongoService> | null = null;
  try {
    probe = createMongoService(uri); // constructor throws on malformed URIs
    await probe.connect();
  } catch (e) {
    try { await probe?.close(); } catch { /* ignore */ }
    s.setConnModal({ ...m, error: msg(e) });
    return;
  }
  try { await probe.close(); } catch { /* ignore */ }
  // Persist the URI password-stripped; the password goes to the secret store
  // under the (unique) connection name. The live session still uses the full URI.
  const { uri: strippedUri, password } = splitCredentials(uri);
  if (password !== null) {
    // Store-then-read verification: a backend that silently drops the secret
    // must not lead to a saved-but-unusable (or plaintext) connection. On
    // failure, nothing is persisted — the live session still connects.
    if (!storeSecretVerified(name, password)) {
      s.setConnModal(null);
      s.toast(`${secretsError() ?? "secret store not working"} — connection NOT saved (this session still connects)`, T.red);
      await s.switchConnection(name, uri);
      return;
    }
  } else {
    deleteSecret(name); // clear any stale secret from a prior password
  }
  const list = savedConnections().filter((c) => c.name !== name);
  list.push({ name, uri: strippedUri });
  saveConfig({ connections: list, lastConnection: name });
  s.setConnModal(null);
  await s.switchConnection(name, uri);
}
