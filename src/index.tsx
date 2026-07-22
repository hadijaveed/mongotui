import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { createMongoService } from "./data/service.ts";
import { initStore, useStore } from "./state/store.ts";
import { attachRuntime } from "./state/runtime.ts";
import { App } from "./ui/App.tsx";
import { loadConfig, normalizeUri } from "./config.ts";
import { getSecret, joinCredentials, migrateSecrets } from "./secrets.ts";
import { applyTheme } from "./ui/theme.ts";
import type { ConnectionInfo } from "./shared/types.ts";

function hostFromUri(uri: string): string {
  const withoutScheme = uri.replace(/^mongodb(?:\+srv)?:\/\//i, "");
  const authority = withoutScheme.split(/[/?]/, 1)[0] ?? withoutScheme;
  return authority.slice(authority.lastIndexOf("@") + 1);
}

// One-time: migrate any password still embedded in config.json into the secret
// store (silent on success; toast-able error surfaced after the store is ready).
const migration = migrateSecrets();

const config = loadConfig();
const appliedTheme = applyTheme(config.theme) ? config.theme! : "mongo";

// Boot order: explicit argv URI > MONGOTUI_URI > config.lastConnection > default.
// Bare `host` / `host:port` args are normalized to a full mongodb:// URI.
const explicitRaw = process.argv[2] ?? process.env.MONGOTUI_URI;
const explicit = explicitRaw ? normalizeUri(explicitRaw) : undefined;
const lastConn = config.connections?.find((c) => c.name === config.lastConnection);

let uri: string;
let connName: string | undefined;
if (explicit) {
  // An explicit URI is used as-is for this session only (it may carry a
  // password); it is never persisted, so nothing is stored for it either.
  uri = explicit;
} else if (lastConn) {
  // Saved connection URIs are stored password-stripped; re-attach the secret.
  const secret = getSecret(lastConn.name);
  uri = secret ? joinCredentials(lastConn.uri, secret) : lastConn.uri;
  connName = lastConn.name;
} else if (config.lastConnection && /^mongodb(\+srv)?:\/\//i.test(config.lastConnection)) {
  // Legacy: lastConnection stored as a raw URI (migration strips its password
  // into the "__last" secret) — resolve it the same way.
  const secret = getSecret("__last");
  uri = secret ? joinCredentials(config.lastConnection, secret) : config.lastConnection;
} else {
  uri = "mongodb://localhost:27017";
}

let service: ReturnType<typeof createMongoService>;
let info: ConnectionInfo;
try {
  // Inside the try: a malformed URI makes the MongoClient constructor throw
  // synchronously, and that must hit the same redacted error path.
  service = createMongoService(uri);
  info = await service.connect();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  // Redact `user:pass@` anywhere in a string (driver errors can embed the URI).
  const redact = (s: string): string => s.replace(/(mongodb(?:\+srv)?:\/\/[^:@/\s]+):[^@\s]+@/gi, "$1:•••@");
  if (explicit) {
    // An explicitly requested URI that fails is a hard error, as before —
    // reported password-stripped so credentials never land in logs/scrollback.
    process.stderr.write(`mongotui: cannot connect to ${redact(uri)}\n${redact(message)}\n`);
    process.exit(1);
  }
  // No explicit URI: enter the UI disconnected so the user can add one via C.
  service ??= createMongoService("mongodb://localhost:27017");
  info = { uri, host: hostFromUri(uri), latencyMs: null, ok: false };
}

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  enableMouseMovement: true,
  targetFps: 30,
});

// Ensure the process actually terminates on an OS signal (opentui otherwise
// keeps the event loop alive), so `timeout` can reap it.
for (const sig of ["SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    try {
      renderer.destroy();
    } catch { /* ignore */ }
    process.exit(0);
  });
}

initStore(service, info, connName);
useStore.setState((s) => ({ ui: { ...s.ui, themeName: appliedTheme } }));
if (migration.error) {
  useStore.getState().toast(`credential migration failed: ${migration.error}`, "#ff6b6b");
} else if (!info.ok) {
  useStore.getState().toast("not connected — press C to add a connection", "#f4bf75");
}

const root = createRoot(renderer);
attachRuntime({ renderer, service, unmount: () => root.unmount() });

if (info.ok) void useStore.getState().loadDatabases();
root.render(<App />);
