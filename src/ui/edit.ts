import { spawnSync } from "child_process";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Buffer } from "buffer";
import type { ObjectId } from "bson";
import { BSON, bsonTypeName, cellText, docToEditable, parseEditedDoc, toShellString } from "../data/format.ts";
import { computeDiff, describeDiff } from "../data/diff.ts";
import { getService, useStore } from "../state/store.ts";
import { getRenderer } from "../state/runtime.ts";
import { T } from "./theme.ts";

let tmpCounter = 0;

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function shortId(id: unknown): string {
  if (bsonTypeName(id) === "objectId") {
    const hex = (id as ObjectId).toHexString();
    return `${hex.slice(0, 6)}…${hex.slice(-6)}`;
  }
  return cellText(id, 24);
}

function capLines(lines: string[], cap: number): string[] {
  if (lines.length <= cap) return lines;
  return [...lines.slice(0, cap), `…and ${lines.length - cap} more`];
}

/** Suspend the TUI, open $EDITOR on a temp file, resume, return edited text. */
function runEditor(initialText: string): { text: string; changed: boolean } {
  // The temp file holds real (possibly production) document data: it lives in a
  // private mkdtemp dir (0700), is created 0600 + O_EXCL, and the whole dir is
  // removed afterwards — never a predictable world-readable /tmp path.
  const dir = mkdtempSync(join(tmpdir(), "mongotui-edit-"));
  const file = join(dir, `doc-${tmpCounter++}.mongodb.js`);
  try {
    writeFileSync(file, initialText, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const renderer = getRenderer();
    renderer.suspend();
    try {
      spawnSync(process.env.EDITOR ?? process.env.VISUAL ?? "vi", [file], { stdio: "inherit" });
    } finally {
      renderer.resume();
    }
    const text = readFileSync(file, "utf8");
    return { text, changed: text !== initialText };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function selectedDoc(): Record<string, unknown> | null {
  const s = useStore.getState();
  return s.results.docs[s.results.selRow] ?? null;
}

function hasUsableId(doc: Record<string, unknown>): boolean {
  return Object.hasOwn(doc, "_id") && doc._id !== undefined && doc._id !== null;
}

export function editSelectedDoc(): void {
  const doc = selectedDoc();
  const store = useStore.getState();
  if (!doc) {
    store.toast("no document selected", T.dim);
    return;
  }
  if (!hasUsableId(doc)) {
    store.toast("no _id in this result (projected out?) — re-run without { _id: 0 } to edit", T.red);
    return;
  }
  beginEdit(doc, docToEditable(doc));
}

function beginEdit(original: Record<string, unknown>, initialText: string): void {
  const store = useStore.getState();
  const ns = store.ns;
  if (!ns) return;
  const { text, changed } = runEditor(initialText);
  if (!changed) {
    store.toast("no changes", T.dim);
    return;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = parseEditedDoc(text);
  } catch (e) {
    store.setModal({
      kind: "error",
      title: "could not parse document",
      lines: [message(e)],
      retry: () => beginEdit(original, text),
    });
    return;
  }
  const diff = computeDiff(original, parsed);
  if (Object.keys(diff.set).length === 0 && diff.unset.length === 0) {
    store.toast("no changes", T.dim);
    return;
  }
  store.setModal({
    kind: "confirm",
    title: `update ${shortId(original._id)}?`,
    lines: capLines(describeDiff(diff), 12),
    onYes: async () => {
      useStore.getState().setModal(null);
      try {
        await getService().updateDocument(ns, original._id, diff);
        await useStore.getState().refresh();
        useStore.getState().toast("updated", T.accent);
      } catch (e) {
        useStore.getState().toast(message(e), T.red);
      }
    },
  });
}

function beginInsert(initialText: string): void {
  const store = useStore.getState();
  const ns = store.ns;
  if (!ns) return;
  const { text } = runEditor(initialText);
  let parsed: Record<string, unknown>;
  try {
    parsed = parseEditedDoc(text);
  } catch (e) {
    store.setModal({
      kind: "error",
      title: "could not parse document",
      lines: [message(e)],
      retry: () => beginInsert(text),
    });
    return;
  }
  const preview = capLines(
    Object.entries(parsed).map(([k, v]) => `set  ${k} = ${toShellString(v, 0).replace(/\s+/g, " ")}`),
    12,
  );
  store.setModal({
    kind: "confirm",
    title: "insert document?",
    lines: preview,
    onYes: async () => {
      useStore.getState().setModal(null);
      try {
        await getService().insertDocument(ns, parsed);
        await useStore.getState().refresh();
        useStore.getState().toast("inserted", T.accent);
      } catch (e) {
        useStore.getState().toast(message(e), T.red);
      }
    },
  });
}

export function cloneSelectedDoc(): void {
  const doc = selectedDoc();
  const store = useStore.getState();
  if (!doc) {
    store.toast("no document selected", T.dim);
    return;
  }
  const { _id, ...rest } = doc;
  void _id;
  beginInsert(docToEditable(rest));
}

export function newDoc(): void {
  const store = useStore.getState();
  if (!store.ns) {
    store.toast("open a collection first", T.dim);
    return;
  }
  const skeleton: Record<string, unknown> = {};
  const fields = (store.results.schema?.fields ?? [])
    .filter((f) => !f.path.includes(".") && f.path !== "_id")
    .slice(0, 3);
  for (const f of fields) skeleton[f.path] = null;
  beginInsert(docToEditable(skeleton));
}

export function deleteSelectedDoc(): void {
  const doc = selectedDoc();
  const store = useStore.getState();
  const ns = store.ns;
  if (!doc || !ns) {
    store.toast("no document selected", T.dim);
    return;
  }
  if (!hasUsableId(doc)) {
    store.toast("no _id in this result (projected out?) — re-run without { _id: 0 } to delete", T.red);
    return;
  }
  store.setModal({
    kind: "confirm",
    title: `delete ${shortId(doc._id)}? (y/n)`,
    lines: [],
    onYes: async () => {
      useStore.getState().setModal(null);
      try {
        await getService().deleteDocument(ns, doc._id);
        await useStore.getState().refresh();
        useStore.getState().toast("deleted", T.accent);
      } catch (e) {
        useStore.getState().toast(message(e), T.red);
      }
    },
  });
}

/** Copy arbitrary text to the system clipboard via OSC 52 (works over SSH). */
export function copyText(text: string, label: string): void {
  const store = useStore.getState();
  try {
    const b64 = Buffer.from(text).toString("base64");
    process.stdout.write(`\x1b]52;c;${b64}\x07`);
    store.toast(label, T.accent);
  } catch (e) {
    store.toast(message(e), T.red);
  }
}

export function copySelectedDoc(): void {
  const doc = selectedDoc();
  if (!doc) {
    useStore.getState().toast("no document selected", T.dim);
    return;
  }
  copyText(BSON.EJSON.stringify(doc, undefined, 2, { relaxed: true }), "copied document");
}
