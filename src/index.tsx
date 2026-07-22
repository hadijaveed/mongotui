import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { createMongoService } from "./data/service.ts";
import { initStore, useStore } from "./state/store.ts";
import { attachRuntime } from "./state/runtime.ts";
import { App } from "./ui/App.tsx";
import { loadConfig, normalizeUri } from "./config.ts";
import { applyTheme } from "./ui/theme.ts";
import type { ConnectionInfo } from "./shared/types.ts";

function hostFromUri(uri: string): string {
  const withoutScheme = uri.replace(/^mongodb(?:\+srv)?:\/\//i, "");
  const authority = withoutScheme.split(/[/?]/, 1)[0] ?? withoutScheme;
  return authority.slice(authority.lastIndexOf("@") + 1);
}

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
  uri = explicit;
} else if (lastConn) {
  uri = lastConn.uri;
  connName = lastConn.name;
} else {
  uri = "mongodb://localhost:27017";
}

const service = createMongoService(uri);

let info: ConnectionInfo;
try {
  info = await service.connect();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (explicit) {
    // An explicitly requested URI that fails is a hard error, as before.
    process.stderr.write(`mongotui: cannot connect to ${uri}\n${message}\n`);
    process.exit(1);
  }
  // No explicit URI: enter the UI disconnected so the user can add one via C.
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
if (!info.ok) {
  useStore.getState().toast("not connected — press C to add a connection", "#f4bf75");
}

const root = createRoot(renderer);
attachRuntime({ renderer, service, unmount: () => root.unmount() });

if (info.ok) void useStore.getState().loadDatabases();
root.render(<App />);
