/**
 * Command palette registry + fuzzy matcher. `buildCommands` snapshots the store
 * to decide which commands are currently applicable; each command's `run` reads
 * fresh state from the store when invoked, so a stale snapshot never acts.
 */
import { teardownStore, useStore, type StoreState } from "../state/store.ts";
import { quit } from "../state/runtime.ts";
import {
  cloneSelectedDoc,
  copySelectedDoc,
  deleteSelectedDoc,
  editSelectedDoc,
  newDoc,
} from "./edit.ts";
import { openConnections, openExplain, openThemePicker } from "./actions.ts";
import { sanitizeLabel } from "../data/format.ts";

export interface Command {
  id: string;
  name: string;
  description: string;
  hint?: string;
  run: () => void | Promise<void>;
}

/** Open the command palette (used by keyboard shortcut and the TopBar button). */
export function openPalette(): void {
  const s = useStore.getState();
  s.setPaletteModal({ query: "", cursor: 0, sel: 0 });
  void s.loadAllCollections(); // so collection-jump entries cover every database
}

/** Build the applicable command list for the current store snapshot. */
export function buildCommands(store: StoreState): Command[] {
  const s = () => useStore.getState();
  const hasNs = store.ns !== null;
  const hasDocs = store.results.docs.length > 0;
  const writable = hasNs && !store.results.aggregate;
  const cmds: Command[] = [];
  const add = (c: Command | null): void => { if (c) cmds.push(c); };

  add({ id: "tab.new", name: "new tab", description: "duplicate the current collection into a new tab", hint: "T", run: () => void s().duplicateTab() });
  if (store.tabs.length > 1) {
    add({ id: "tab.close", name: "close tab", description: "close the active tab", hint: "X", run: () => s().closeTab() });
    add({ id: "tab.next", name: "next tab", description: "switch to the next tab", hint: "]", run: () => s().nextTab(1) });
    add({ id: "tab.prev", name: "previous tab", description: "switch to the previous tab", hint: "[", run: () => s().nextTab(-1) });
  }

  if (hasNs) {
    add({ id: "view.table", name: "table view", description: "show results as a table", hint: "v", run: () => s().setView("table") });
    add({ id: "view.docs", name: "documents view", description: "show results as folded documents", hint: "v", run: () => s().setView("docs") });
    if (hasDocs) add({ id: "view.detail", name: "detail view", description: "open the selected document", hint: "⏎", run: () => s().openDetail() });
    add({ id: "query.aggregate", name: store.query.mode === "aggregate" ? "switch to find mode" : "switch to aggregate mode", description: "toggle between find queries and aggregation pipelines", hint: "A", run: () => s().toggleMode() });
    add({ id: "query.run", name: "run query", description: "execute the current find / pipeline", hint: "⏎", run: () => void (s().query.mode === "aggregate" ? s().runAggregate() : s().runQuery()) });
    if (store.query.mode === "find") {
      add({ id: "query.options", name: store.query.expanded ? "hide query options" : "show query options", description: "project / sort / collation / hint / skip / limit / maxTimeMS", hint: "tab", run: () => { s().setFocus("query"); s().setExpanded(!s().query.expanded); } });
    }
  }
  add({ id: "focus.query", name: "focus query", description: "jump to the query editor", hint: "/", run: () => { s().setFocus("query"); s().setActiveField("filter"); } });

  if (writable) {
    if (hasDocs) add({ id: "doc.edit", name: "edit document", description: "edit the selected document in $EDITOR", hint: "e", run: () => editSelectedDoc() });
    add({ id: "doc.new", name: "new document", description: "insert a new document", hint: "n", run: () => newDoc() });
    if (hasDocs) add({ id: "doc.clone", name: "clone document", description: "duplicate the selected document", hint: "c", run: () => cloneSelectedDoc() });
    if (hasDocs) add({ id: "doc.delete", name: "delete document", description: "delete the selected document", hint: "d", run: () => deleteSelectedDoc() });
  }
  if (hasNs && hasDocs) add({ id: "doc.copy", name: "copy document", description: "copy the selected document as EJSON", hint: "y", run: () => copySelectedDoc() });

  if (hasNs && store.query.mode === "find") {
    add({ id: "query.explain", name: "explain query", description: "show the query execution plan", hint: "E", run: () => void openExplain() });
  }
  add({ id: "reload", name: "reload", description: "reload the tree and current page", hint: "R", run: () => { void s().reloadTree(); void s().refresh(); } });

  add({ id: "themes", name: "themes…", description: "open the theme picker", hint: ",", run: () => openThemePicker() });
  add({ id: "connections", name: "connections…", description: "open the connections manager", hint: "C", run: () => openConnections() });
  add({ id: "help", name: "help", description: "show the keyboard help overlay", hint: "?", run: () => s().setModal({ kind: "help" }) });

  add({ id: "focus.sidebar", name: "focus sidebar", description: "focus the databases sidebar", hint: "1", run: () => s().setFocus("sidebar") });
  add({ id: "focus.results", name: "focus results", description: "focus the results pane", hint: "3", run: () => s().setFocus("results") });

  add({ id: "quit", name: "quit", description: "exit mongotui", hint: "q", run: () => quit(teardownStore) });

  // Dynamic collection jumps: current db's collections first.
  const currentDb = store.ns?.db;
  const dbs = Object.keys(store.tree.collectionsByDb).sort((a, b) =>
    a === currentDb ? -1 : b === currentDb ? 1 : a.localeCompare(b),
  );
  for (const db of dbs) {
    const seen = new Set<string>();
    for (const coll of store.tree.collectionsByDb[db] ?? []) {
      // Skip nameless (invalid — can't open) and duplicate entries, and sanitize
      // the DISPLAY name so control chars in a real collection name can't blank
      // the row or spuriously fuzzy-match. `run` still opens the real name.
      const real = coll.name;
      if (!real || !real.trim() || seen.has(real)) continue;
      seen.add(real);
      const label = sanitizeLabel(real);
      if (!label) continue; // name was entirely control chars
      const ns = { db, coll: real };
      add({ id: `jump.${db}.${real}`, name: `${sanitizeLabel(db)}.${label}`, description: "open collection", run: () => void s().openCollection(ns) });
    }
  }

  return cmds;
}

/**
 * Subsequence fuzzy score: prefix (3) beats substring (2) beats subsequence (1);
 * no match → null. Case-insensitive.
 */
export function fuzzyScore(text: string, query: string): number | null {
  if (!query) return 0;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  const idx = t.indexOf(q);
  if (idx === 0) return 3;
  if (idx > 0) return 2;
  let i = 0;
  for (const ch of t) {
    if (ch === q[i]) i++;
    if (i === q.length) return 1;
  }
  return null;
}

/**
 * Filter + rank commands by the query. Name matches outrank description-only
 * matches; ties keep registry order (Array.sort is stable). Empty query → all.
 */
export function filterCommands(cmds: Command[], query: string): Command[] {
  const q = query.trim();
  if (!q) return cmds;
  const scored: { cmd: Command; score: number }[] = [];
  for (const cmd of cmds) {
    const nameScore = fuzzyScore(cmd.name, q);
    if (nameScore !== null) {
      scored.push({ cmd, score: nameScore + 10 });
      continue;
    }
    const descScore = fuzzyScore(cmd.description, q);
    if (descScore !== null) scored.push({ cmd, score: descScore });
  }
  return scored.sort((a, b) => b.score - a.score).map((x) => x.cmd);
}
