import { useRef } from "react";
import { useKeyboard, usePaste, useRenderer } from "@opentui/react";
import type { KeyEvent } from "@opentui/core";
import type { QueryField } from "../shared/types.ts";
import { teardownStore, useStore, type StoreState } from "../state/store.ts";
import { quit } from "../state/runtime.ts";
import { T } from "./theme.ts";
import { applyKey } from "./LineEditor.tsx";
import { Sidebar, sidebarRows } from "./Sidebar.tsx";
import { QueryBar } from "./QueryBar.tsx";
import { ResultsPane } from "./ResultsPane.tsx";
import { TabBar } from "./TabBar.tsx";
import { Modals } from "./modals.tsx";
import { docsBodyLines, flattenDocs } from "./docsModel.ts";
import { cloneSelectedDoc, copySelectedDoc, copyText, deleteSelectedDoc, editSelectedDoc, newDoc } from "./edit.ts";
import {
  connCancelAdd,
  connConnectSelected,
  connDeleteSelected,
  connMove,
  connStartAdd,
  connSubmitAdd,
  connTestSelected,
  keepTheme,
  moveThemeSel,
  openConnections,
  openExplain,
  openThemePicker,
  revertTheme,
} from "./actions.ts";
import { buildCommands, filterCommands, openPalette } from "./commands.ts";

const QUERY_ORDER: QueryField[] = [
  "filter", "project", "sort", "collation", "hint", "skip", "limit", "maxTimeMS",
];

function TopBar(): React.ReactNode {
  const conn = useStore((s) => s.conn);
  const ns = useStore((s) => s.ns);
  const nsText = ns ? `${ns.db}.${ns.coll}` : "—";
  const connLabel = conn.name ?? conn.host;
  return (
    <box style={{ height: 1, flexDirection: "row", paddingX: 1 }}>
      <text>
        <span fg={conn.ok ? T.focus : T.dim}> ◆ </span>
        <span fg={T.text}>mongotui</span>
        <span fg={T.dim}>{` · ${connLabel} · `}</span>
        <span fg={T.text}>{nsText}</span>
      </text>
      <box style={{ flexGrow: 1, flexDirection: "row", justifyContent: "flex-end" }}>
        <box onMouseDown={() => openPalette()}>
          <text><span fg={T.accent}>: commands</span></text>
        </box>
        <text><span fg={T.dim}>  ? help  q quit</span></text>
      </box>
    </box>
  );
}

const PALETTE_HINT = " · : commands";

function hintsFor(s: StoreState): string {
  if (s.ui.focusedPane === "sidebar") return "j/k move · ⏎ open · o new tab · / search · R reload" + PALETTE_HINT;
  if (s.ui.focusedPane === "query") {
    return (s.query.mode === "aggregate"
      ? "⏎ run pipeline · A find mode · esc results · ↑ history"
      : "⏎ run · tab/▾ options · A aggregate · esc results · ↑ history") + PALETTE_HINT;
  }
  // The least-important existing hint is dropped to keep each line to one row.
  const base = "v view · e edit · n new · d delete · y copy · / query";
  if (s.results.view === "detail") return `j/k move · space fold · J/K doc · esc back · e edit · y copy` + PALETTE_HINT;
  return (s.results.view === "docs"
    ? `j/k line · J/K doc · ⏎ detail · space fold · ${base}`
    : `j/k move · ⏎ detail · ‹ › cols · ${base}`) + PALETTE_HINT;
}

function StatusBar(): React.ReactNode {
  const s = useStore();
  const latency = s.conn.latencyMs;
  const dot = latency === null ? T.dim : latency < 50 ? T.focus : latency < 200 ? T.amber : T.red;
  const right = s.ns ? `${s.ns.db}.${s.ns.coll}` : s.conn.host;
  const pane = s.ui.focusedPane;
  return (
    <box style={{ height: 1, flexDirection: "row", paddingX: 1 }}>
      <text>
        <span fg={T.accent}>{`⟨${pane}⟩ `}</span>
        {s.ui.toast
          ? <span fg={s.ui.toast.color}>{s.ui.toast.text}</span>
          : <span fg={T.dim}>{hintsFor(s)}</span>}
      </text>
      <box style={{ flexGrow: 1, alignItems: "flex-end", flexDirection: "row", justifyContent: "flex-end" }}>
        <text>
          <span fg={T.dim}>{`${right} · `}</span>
          <span fg={dot}>●</span>
          <span fg={T.dim}>{latency === null ? " —ms" : ` ${Math.round(latency)}ms`}</span>
        </text>
      </box>
    </box>
  );
}

function stripPaste(bytes: Uint8Array): string {
  const raw = new TextDecoder().decode(bytes);
  return raw.replace(/[\r\n]+/g, " ").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

export function App(): React.ReactNode {
  const focusedPane = useStore((s) => s.ui.focusedPane);
  // Subscribing to themeName re-renders the whole (unmemoized) tree so every
  // T.* read refreshes when applyTheme mutates the palette in place.
  const themeName = useStore((s) => s.ui.themeName);
  void themeName;
  const ctrlC = useRef(0);
  const renderer = useRenderer();
  const lastCopy = useRef("");

  // Auto-copy mouse-highlighted text (terminal-native selection → clipboard),
  // then clear the renderer selection so no stale highlight cells persist after
  // mouse-up (e.g. the yellow block left behind by a micro-drag over a tab).
  const copySelection = (): void => {
    const sel = renderer.getSelection();
    const text = sel?.getSelectedText() ?? "";
    if (text.trim() && text !== lastCopy.current) {
      lastCopy.current = text;
      copyText(text, "selection copied");
    }
    renderer.clearSelection();
  };

  usePaste((event) => {
    const text = stripPaste(event.bytes);
    if (!text) return;
    handlePaste(useStore.getState(), text);
  });

  useKeyboard((key) => {
    if (key.eventType === "release") return;
    const store = useStore.getState();

    if (key.ctrl && key.name === "c") {
      const now = Date.now();
      if (now - ctrlC.current < 2000) return quit(teardownStore);
      ctrlC.current = now;
      store.toast("press ctrl+c again to quit", T.dim);
      return;
    }

    // Palette outranks everything except an in-flight quit: an already-open
    // palette handles its own keys; ctrl+k / ctrl+p opens it from any non-modal
    // context (even while the query editor is focused).
    if (store.ui.paletteModal) return handlePalette(store, key);
    if (key.ctrl && (key.name === "k" || key.name === "p")) {
      if (!store.ui.modal && !store.ui.themeModal && !store.ui.connModal) {
        openPalette();
        return;
      }
    }

    if (store.ui.themeModal) return handleThemeModal(store, key);
    if (store.ui.connModal) return handleConnModal(store, key);
    if (store.ui.modal) return handleModal(store, key);
    if (store.ui.focusedPane === "query") return handleQuery(store, key);
    if (store.tree.sidebarFilterMode) return handleSidebarFilter(store, key);
    if (handleGlobal(store, key)) return;
    if (store.ui.focusedPane === "sidebar") handleSidebar(store, key);
    else handleResults(store, key);
  });

  return (
    <box
      style={{ flexDirection: "column", width: "100%", height: "100%", backgroundColor: T.bg }}
      onMouseUp={copySelection}
      onMouseDragEnd={copySelection}
    >
      <TopBar />
      <TabBar />
      <box style={{ flexGrow: 1, flexDirection: "row" }}>
        <Sidebar focused={focusedPane === "sidebar"} />
        <box style={{ flexGrow: 1, flexDirection: "column" }}>
          <QueryBar focused={focusedPane === "query"} />
          <ResultsPane focused={focusedPane === "results"} />
        </box>
      </box>
      <StatusBar />
      <Modals />
    </box>
  );
}

function handlePaste(store: StoreState, text: string): void {
  // 0. command palette filter
  const pm = store.ui.paletteModal;
  if (pm) {
    const at = Math.min(pm.cursor, pm.query.length);
    const value = pm.query.slice(0, at) + text + pm.query.slice(at);
    store.setPaletteModal({ query: value, cursor: at + text.length, sel: 0 });
    return;
  }
  // 1. connection add-form
  const cm = store.ui.connModal;
  if (cm?.adding) {
    const field = cm.formField;
    const cur = field === "name" ? cm.formName : cm.formUri;
    const at = Math.min(cm.formCursor, cur.length);
    const value = cur.slice(0, at) + text + cur.slice(at);
    store.setConnModal({ ...cm, [field === "name" ? "formName" : "formUri"]: value, formCursor: at + text.length });
    return;
  }
  if (store.ui.modal || store.ui.themeModal || store.ui.connModal) return;
  // 2. query field
  if (store.ui.focusedPane === "query") {
    if (store.query.mode === "aggregate") {
      const cur = store.query.pipeline;
      const at = Math.min(store.query.pipelineCursor, cur.length);
      store.setPipeline(cur.slice(0, at) + text + cur.slice(at), at + text.length);
    } else {
      const f = store.query.activeField;
      const cur = store.query.input[f];
      const at = Math.min(store.query.cursor, cur.length);
      store.setQueryField(f, cur.slice(0, at) + text + cur.slice(at), at + text.length);
    }
    return;
  }
  // 3. sidebar filter
  if (store.tree.sidebarFilterMode) {
    const cur = store.tree.sidebarFilter;
    const at = Math.min(store.tree.sidebarFilterCursor, cur.length);
    store.setSidebarFilter(cur.slice(0, at) + text + cur.slice(at), at + text.length);
  }
}

function handleThemeModal(store: StoreState, key: KeyEvent): void {
  if (key.name === "escape") return revertTheme();
  if (key.name === "return" || key.name === "enter") return keepTheme();
  if (key.name === "down" || key.sequence === "j") return moveThemeSel(1);
  if (key.name === "up" || key.sequence === "k") return moveThemeSel(-1);
}

function handleConnModal(store: StoreState, key: KeyEvent): void {
  const m = store.ui.connModal!;
  if (m.adding) {
    if (key.name === "escape") return connCancelAdd();
    if (key.name === "return" || key.name === "enter") return void connSubmitAdd();
    if (key.name === "tab") {
      const next = m.formField === "name" ? "uri" : "name";
      const val = next === "name" ? m.formName : m.formUri;
      store.setConnModal({ ...m, formField: next, formCursor: val.length });
      return;
    }
    const field = m.formField;
    const cur = field === "name" ? m.formName : m.formUri;
    const result = applyKey({ value: cur, cursor: m.formCursor }, key);
    store.setConnModal({ ...m, [field === "name" ? "formName" : "formUri"]: result.value, formCursor: result.cursor });
    return;
  }
  if (key.name === "escape") return store.setConnModal(null);
  if (key.name === "down" || key.sequence === "j") return connMove(1);
  if (key.name === "up" || key.sequence === "k") return connMove(-1);
  if (key.name === "return" || key.name === "enter") return void connConnectSelected();
  if (key.sequence === "a") return connStartAdd();
  if (key.sequence === "t") return void connTestSelected();
  if (key.sequence === "D") return connDeleteSelected();
}

function handleModal(store: StoreState, key: KeyEvent): void {
  const modal = store.ui.modal!;
  if (modal.kind === "help") {
    if (key.name === "escape" || key.sequence === "q" || key.sequence === "?") store.setModal(null);
    return;
  }
  if (modal.kind === "confirm") {
    if (key.name === "return" || key.name === "enter" || key.sequence === "y") modal.onYes?.();
    else if (key.name === "escape" || key.sequence === "n") store.setModal(null);
    return;
  }
  // error
  if (key.sequence === "e" && modal.retry) {
    store.setModal(null);
    modal.retry();
  } else if (key.name === "escape") {
    store.setModal(null);
  }
}

function handleGlobal(store: StoreState, key: KeyEvent): boolean {
  // Tab cycles pane focus (sidebar → query → results), Shift+Tab reverses. Always
  // does something so it never feels dead. (Switch between open tabs with `[` / `]`.)
  if (key.name === "tab") {
    store.cyclePane(key.shift ? -1 : 1);
    return true;
  }
  if (key.sequence === "?") {
    store.setModal({ kind: "help" });
    return true;
  }
  // `:` is a tmux-proof command-palette trigger (ctrl+k / ctrl+p are often
  // swallowed by tmux / the shell); it's free outside the text editors.
  if (key.sequence === ":") {
    openPalette();
    return true;
  }
  // `o` opens the sidebar's selected collection in a NEW tab — from any pane, so
  // it works from the results view too (not just when the sidebar is focused).
  if (key.sequence === "o") {
    const rows = sidebarRows(store.tree);
    const row = rows[Math.min(store.tree.sidebarSel, Math.max(0, rows.length - 1))];
    if (row && row.type === "coll") void store.openInNewTab({ db: row.db, coll: row.coll! });
    else store.newEmptyTab();
    return true;
  }
  if (key.sequence === ",") {
    openThemePicker();
    return true;
  }
  if (key.sequence === "C") {
    openConnections();
    return true;
  }
  if (key.sequence === "/") {
    if (store.ui.focusedPane === "sidebar") store.setSidebarFilterMode(true);
    else {
      store.setFocus("query");
      store.setActiveField("filter");
    }
    return true;
  }
  if (key.sequence === "q") {
    quit(teardownStore);
    return true;
  }
  if (key.name === "1" || key.sequence === "1") return store.setFocus("sidebar"), true;
  if (key.name === "2" || key.sequence === "2") return store.setFocus("query"), true;
  if (key.name === "3" || key.sequence === "3") return store.setFocus("results"), true;
  // tabs
  if (key.sequence === "T") return void store.duplicateTab(), true;
  if (key.sequence === "X") return store.closeTab(), true;
  if (key.sequence === "[") return store.nextTab(-1), true;
  if (key.sequence === "]") return store.nextTab(1), true;
  // aggregate mode toggle
  if (key.sequence === "A") return store.toggleMode(), true;
  if (key.sequence === "R") {
    void store.reloadTree();
    void store.refresh();
    return true;
  }
  if (key.sequence === "E") {
    void openExplain();
    return true;
  }
  return false;
}

function handlePalette(store: StoreState, key: KeyEvent): void {
  const p = store.ui.paletteModal!;
  if (key.name === "escape") return store.setPaletteModal(null);
  const results = filterCommands(buildCommands(store), p.query);
  if (key.name === "return" || key.name === "enter") {
    const cmd = results[Math.min(p.sel, Math.max(0, results.length - 1))];
    store.setPaletteModal(null);
    if (cmd) void cmd.run();
    return;
  }
  if (key.name === "down") {
    store.setPaletteModal({ ...p, sel: Math.min(Math.max(0, results.length - 1), p.sel + 1) });
    return;
  }
  if (key.name === "up") {
    store.setPaletteModal({ ...p, sel: Math.max(0, p.sel - 1) });
    return;
  }
  // Everything else edits the filter text (plain j/k type; only arrows navigate).
  const next = applyKey({ value: p.query, cursor: p.cursor }, key);
  store.setPaletteModal({ query: next.value, cursor: next.cursor, sel: 0 });
}

function handleQuery(store: StoreState, key: KeyEvent): void {
  if (store.query.mode === "aggregate") return handlePipeline(store, key);
  if (key.name === "tab") {
    if (!store.query.expanded) {
      store.setExpanded(true);
      store.setActiveField("project");
    } else {
      cycleField(store, key.shift ? -1 : 1);
    }
    return;
  }
  if (key.name === "escape") {
    // First esc out of an option field returns to the filter row (staying in the
    // query pane) so you're never trapped cycling; esc on filter exits to results.
    if (store.query.expanded && store.query.activeField !== "filter") {
      store.setActiveField("filter");
      return;
    }
    const opts = QUERY_ORDER.slice(1);
    if (opts.every((f) => !store.query.input[f].trim())) store.setExpanded(false);
    store.setActiveField("filter");
    store.setFocus("results");
    return;
  }
  if (key.name === "return" || key.name === "enter") {
    void store.runQuery();
    return;
  }
  if (!store.query.expanded && store.query.activeField === "filter") {
    if (key.name === "up") return store.recallHistory(1);
    if (key.name === "down") return store.recallHistory(-1);
  }
  const field = store.query.activeField;
  const next = applyKey({ value: store.query.input[field], cursor: store.query.cursor }, key, { autoPairs: true });
  store.setQueryField(field, next.value, next.cursor);
}

function handlePipeline(store: StoreState, key: KeyEvent): void {
  if (key.name === "escape") {
    store.setFocus("results");
    return;
  }
  if (key.name === "return" || key.name === "enter") {
    void store.runAggregate();
    return;
  }
  if (key.name === "tab") return; // aggregate mode has no extra fields
  if (key.name === "up") return store.recallPipelineHistory(1);
  if (key.name === "down") return store.recallPipelineHistory(-1);
  const next = applyKey({ value: store.query.pipeline, cursor: store.query.pipelineCursor }, key, { autoPairs: true });
  store.setPipeline(next.value, next.cursor);
}

function cycleField(store: StoreState, dir: 1 | -1): void {
  const idx = QUERY_ORDER.indexOf(store.query.activeField);
  const next = QUERY_ORDER[(idx + dir + QUERY_ORDER.length) % QUERY_ORDER.length]!;
  store.setActiveField(next);
}

function handleSidebarFilter(store: StoreState, key: KeyEvent): void {
  if (key.name === "escape") return store.setSidebarFilterMode(false);
  if (key.name === "tab") {
    // Tab must never feel dead: commit the filter and move to the next pane.
    store.setSidebarFilterMode(false, true);
    store.cyclePane(key.shift ? -1 : 1);
    return;
  }
  const rows = sidebarRows(store.tree);
  // Arrows navigate the matches while you keep typing; Enter drops into the
  // (still-filtered) list to pick one — Enter there opens it, esc clears.
  if (key.name === "down") return store.sidebarTo(Math.min(rows.length - 1, store.tree.sidebarSel + 1));
  if (key.name === "up") return store.sidebarTo(Math.max(0, store.tree.sidebarSel - 1));
  if (key.name === "return" || key.name === "enter") {
    const sel = Math.min(store.tree.sidebarSel, Math.max(0, rows.length - 1));
    const idx = rows[sel]?.type === "coll" ? sel : rows.findIndex((r) => r.type === "coll");
    store.setSidebarFilterMode(false, true);
    store.setFocus("sidebar");
    if (idx >= 0) store.sidebarTo(idx);
    return;
  }
  const next = applyKey(
    { value: store.tree.sidebarFilter, cursor: store.tree.sidebarFilterCursor },
    key,
  );
  store.setSidebarFilter(next.value, next.cursor);
}

function handleSidebar(store: StoreState, key: KeyEvent): void {
  const rows = sidebarRows(store.tree);
  const sel = Math.min(store.tree.sidebarSel, Math.max(0, rows.length - 1));
  const row = rows[sel];
  const seq = key.sequence;

  // Esc clears an applied search filter (the list goes back to the full tree).
  if (key.name === "escape" && store.tree.sidebarFilter.trim()) {
    return store.setSidebarFilterMode(false);
  }

  if (key.name === "down" || seq === "j") return store.sidebarTo(sel + 1);
  if (key.name === "up" || seq === "k") return store.sidebarTo(sel - 1);
  if (seq === "g") return store.sidebarTo(0);
  if (seq === "G") return store.sidebarTo(rows.length - 1);
  if (key.name === "return" || key.name === "enter" || seq === "l") {
    if (!row) return;
    if (row.type === "db") void store.toggleDb(row.db);
    else void store.openCollection({ db: row.db, coll: row.coll! });
    return;
  }
  if (key.name === "left" || seq === "h") {
    if (!row) return;
    if (row.type === "db" && store.tree.expandedDbs.has(row.db)) void store.toggleDb(row.db);
    else if (row.type === "coll") {
      void store.toggleDb(row.db);
      const dbRow = rows.findIndex((r) => r.type === "db" && r.db === row.db);
      if (dbRow >= 0) store.sidebarTo(dbRow);
    }
  }
}

function handleResults(store: StoreState, key: KeyEvent): void {
  const seq = key.sequence;
  const view = store.results.view;
  const agg = store.results.aggregate;

  // editing + shared
  if (seq === "e" || seq === "c" || seq === "n" || seq === "d") {
    if (agg) {
      store.toast("aggregate results are read-only", T.dim);
      return;
    }
    if (seq === "e") return editSelectedDoc();
    if (seq === "c") return cloneSelectedDoc();
    if (seq === "n") return newDoc();
    if (seq === "d") return deleteSelectedDoc();
  }
  if (seq === "y") return copySelectedDoc();
  if (seq === "v") return store.setView(view === "table" ? "docs" : "table");
  if (key.name === "escape") {
    if (view === "detail") return store.setView("table");
    store.setFocus("sidebar");
    return;
  }

  // Horizontal column paging in the table: `>`/`<` (and `L`/`H`) reveal columns
  // that don't fit; distinct from `h`/`l` which page rows.
  if (view === "table" && (seq === ">" || seq === "L")) return store.scrollCols(1);
  if (view === "table" && (seq === "<" || seq === "H")) return store.scrollCols(-1);

  if (key.name === "left" || seq === "h" || key.name === "right" || seq === "l") {
    if (agg) {
      store.toast("aggregate is a single page — use $skip/$limit stages", T.dim);
      return;
    }
    const delta = key.name === "left" || seq === "h" ? -store.results.pageSize : store.results.pageSize;
    return void store.setPage(store.results.offset + delta);
  }

  if (view === "detail") return handleDetailNav(store, key);
  if (view === "docs") return handleDocsNav(store, key);
  handleTableNav(store, key);
}

function handleDetailNav(store: StoreState, key: KeyEvent): void {
  const seq = key.sequence;
  const doc = store.results.docs[store.results.selRow];
  if (!doc) return;
  const lines = flattenDocs([doc], store.results.detailFolds).filter((l) => l.kind !== "header");
  const cur = Math.min(store.results.detailLine, Math.max(0, lines.length - 1));

  if (key.name === "down" || seq === "j") return store.setDetailLine(Math.min(lines.length - 1, cur + 1));
  if (key.name === "up" || seq === "k") return store.setDetailLine(Math.max(0, cur - 1));
  if (seq === "g") return store.setDetailLine(0);
  if (seq === "G") return store.setDetailLine(lines.length - 1);
  if (seq === "J") return store.detailMoveDoc(1);
  if (seq === "K") return store.detailMoveDoc(-1);
  if (key.name === "space" || key.name === "return" || key.name === "enter") {
    const line = lines[cur];
    if (line?.foldKey) store.toggleDetailFold(line.foldKey);
  }
}

function handleTableNav(store: StoreState, key: KeyEvent): void {
  const seq = key.sequence;
  const last = store.results.docs.length - 1;
  if (key.name === "down" || seq === "j") return store.setSelRow(store.results.selRow + 1);
  if (key.name === "up" || seq === "k") return store.setSelRow(store.results.selRow - 1);
  if (seq === "g") return store.setSelRow(0);
  if (seq === "G") return store.setSelRow(last);
  if (key.name === "return" || key.name === "enter") store.openDetail();
}

function handleDocsNav(store: StoreState, key: KeyEvent): void {
  const seq = key.sequence;
  const lines = docsBodyLines(store.results.docs, store.results.foldedPaths);
  if (lines.length === 0) return;
  const cur = Math.min(store.results.docsLine, Math.max(0, lines.length - 1));
  const setLine = (i: number): void => {
    const clamped = Math.max(0, Math.min(lines.length - 1, i));
    store.setDocsLine(clamped);
    const line = lines[clamped];
    if (line) store.setSelRow(line.docIdx);
  };

  if (key.name === "down" || seq === "j") return setLine(cur + 1);
  if (key.name === "up" || seq === "k") return setLine(cur - 1);
  if (seq === "g") return setLine(0);
  if (seq === "G") return setLine(lines.length - 1);
  if (seq === "J") {
    const curDoc = lines[cur]!.docIdx;
    const idx = lines.findIndex((l, i) => i > cur && l.docIdx > curDoc);
    if (idx >= 0) setLine(idx);
    return;
  }
  if (seq === "K") {
    const curDoc = lines[cur]!.docIdx;
    const idx = lines.findIndex((l) => l.docIdx === curDoc - 1);
    if (idx >= 0) setLine(idx);
    return;
  }
  if (key.name === "space" || key.name === "return" || key.name === "enter") {
    const line = lines[cur];
    if (line?.foldKey) store.toggleFold(line.foldKey);
  }
}
