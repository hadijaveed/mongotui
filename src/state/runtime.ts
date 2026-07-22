import type { CliRenderer } from "@opentui/core";
import type { MongoService } from "../shared/types.ts";

interface Runtime {
  renderer: CliRenderer;
  service: MongoService;
  unmount: () => void;
}

let runtime: Runtime | null = null;

export function attachRuntime(rt: Runtime): void {
  runtime = rt;
}

export function getRenderer(): CliRenderer {
  if (!runtime) throw new Error("runtime not attached");
  return runtime.renderer;
}

/** Swap the active service (used by runtime connection switching). */
export function setRuntimeService(service: MongoService): void {
  if (runtime) runtime.service = service;
}

/** Full teardown + process exit. Safe to call once. */
export function quit(teardownStore: () => void): void {
  teardownStore();
  try {
    runtime?.unmount();
  } catch { /* ignore */ }
  try {
    runtime?.renderer.destroy();
  } catch { /* ignore */ }
  const svc = runtime?.service;
  Promise.resolve(svc?.close())
    .catch(() => undefined)
    .finally(() => process.exit(0));
}
