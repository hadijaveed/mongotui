import { create } from "zustand";
import type {
  CollectionInfo,
  ConnectionInfo,
  DatabaseInfo,
  ExplainSummary,
  FieldValidation,
  MongoService,
  Namespace,
  QueryField,
  QueryInput,
  QueryValidation,
  SchemaSummary,
} from "../shared/types.ts";
import { DEFAULT_QUERY_INPUT } from "../shared/types.ts";
import { computeDefaultFolds, detailDefaultFolds } from "../ui/docsModel.ts";
import { T, type Color } from "../ui/theme.ts";
import { createMongoService } from "../data/service.ts";
import { parsePipeline, validatePipelineText } from "../data/aggregate.ts";
import { setRuntimeService } from "./runtime.ts";
import { saveConfig } from "../config.ts";

export type Pane = "sidebar" | "query" | "results";
export type ResultView = "table" | "docs" | "detail";
export type QueryMode = "find" | "aggregate";

export interface Modal {
  kind: "confirm" | "help" | "error";
  title?: string;
  lines?: string[];
  onYes?: () => void;
  retry?: () => void;
}

export interface Toast {
  text: string;
  color: Color;
}

export interface ThemeModalState {
  sel: number;
  previous: string;
}

export interface ConnModalState {
  sel: number;
  adding: boolean;
  formField: "name" | "uri";
  formName: string;
  formUri: string;
  formCursor: number;
  error: string | null;
}

export interface PaletteModalState {
  query: string;
  cursor: number;
  sel: number;
}

export interface QuerySlice {
  input: QueryInput;
  validation: QueryValidation;
  expanded: boolean;
  activeField: QueryField;
  cursor: number;
  history: string[];
  historyIdx: number;
  mode: QueryMode;
  pipeline: string;
  pipelineValidation: FieldValidation;
  pipelineCursor: number;
  pipelineHistory: string[];
  pipelineHistoryIdx: number;
}

export interface ResultsSlice {
  docs: Record<string, unknown>[];
  offset: number;
  pageSize: number;
  exactCount: number | null;
  estimatedTotal: number | null;
  elapsedMs: number;
  loading: boolean;
  error: string | null;
  view: ResultView;
  selRow: number;
  colOffset: number;
  docsLine: number;
  schema: SchemaSummary | null;
  foldedPaths: Set<string>;
  detailFolds: Set<string>;
  detailLine: number;
  aggregate: boolean;
}

export interface Tab {
  id: number;
  label: string;
  ns: Namespace | null;
  query: QuerySlice;
  results: ResultsSlice;
}

function allValid(v: QueryValidation): boolean {
  return (Object.keys(v) as QueryField[]).every((f) => v[f].valid);
}

const FIELD_ORDER: QueryField[] = [
  "filter", "project", "sort", "collation", "hint", "skip", "limit", "maxTimeMS",
];

export interface StoreState {
  conn: { host: string; latencyMs: number | null; ok: boolean; name?: string };
  tree: {
    databases: DatabaseInfo[];
    collectionsByDb: Record<string, CollectionInfo[]>;
    expandedDbs: Set<string>;
    loadingDbs: Set<string>;
    sidebarFilter: string;
    sidebarFilterMode: boolean;
    sidebarFilterCursor: number;
    sidebarSel: number;
  };
  ns: Namespace | null;
  query: QuerySlice;
  results: ResultsSlice;
  tabs: Tab[];
  activeTab: number;
  nextTabId: number;
  ui: {
    focusedPane: Pane;
    modal: Modal | null;
    toast: Toast | null;
    themeName: string;
    themeModal: ThemeModalState | null;
    connModal: ConnModalState | null;
    paletteModal: PaletteModalState | null;
  };

  // actions
  setFocus: (pane: Pane) => void;
  cyclePane: (dir: 1 | -1) => void;
  toast: (text: string, color: Color) => void;
  setModal: (modal: Modal | null) => void;
  setThemeModal: (m: ThemeModalState | null) => void;
  setConnModal: (m: ConnModalState | null) => void;
  setPaletteModal: (m: PaletteModalState | null) => void;
  setThemeName: (name: string) => void;

  loadDatabases: () => Promise<void>;
  toggleDb: (name: string) => Promise<void>;
  loadAllCollections: () => Promise<void>;
  reloadTree: () => Promise<void>;
  openCollection: (ns: Namespace) => Promise<void>;
  switchConnection: (name: string, uri: string) => Promise<void>;

  // tabs
  switchTab: (i: number) => void;
  nextTab: (dir: 1 | -1) => void;
  openInNewTab: (ns: Namespace) => Promise<void>;
  duplicateTab: () => Promise<void>;
  newEmptyTab: () => void;
  closeTab: () => void;

  sidebarMove: (delta: number) => void;
  sidebarTo: (index: number) => void;
  setSidebarFilterMode: (on: boolean) => void;
  setSidebarFilter: (value: string, cursor: number) => void;

  setQueryField: (field: QueryField, value: string, cursor: number) => void;
  setActiveField: (field: QueryField) => void;
  setExpanded: (expanded: boolean) => void;
  recallHistory: (dir: 1 | -1) => void;
  runQuery: () => Promise<void>;
  refresh: () => Promise<void>;
  setPage: (offset: number) => Promise<void>;
  sortBy: (field: string) => Promise<void>;

  // aggregate
  toggleMode: () => void;
  setPipeline: (value: string, cursor: number) => void;
  recallPipelineHistory: (dir: 1 | -1) => void;
  runAggregate: () => Promise<void>;

  setView: (view: ResultView) => void;
  setSelRow: (row: number) => void;
  scrollCols: (dir: 1 | -1) => void;
  setColOffset: (n: number) => void;
  setDocsLine: (line: number) => void;
  toggleFold: (key: string) => void;
  openDetail: (row?: number) => void;
  setDetailLine: (line: number) => void;
  toggleDetailFold: (key: string) => void;
  detailMoveDoc: (dir: 1 | -1) => void;

  explain: () => Promise<ExplainSummary | null>;
}

let service: MongoService | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let countAbort: AbortController | null = null;
let findToken = 0;
let countToken = 0;

export function getService(): MongoService {
  if (!service) throw new Error("store not initialized");
  return service;
}

function freshQuerySlice(validation: QueryValidation): QuerySlice {
  return {
    input: { ...DEFAULT_QUERY_INPUT },
    validation,
    expanded: false,
    activeField: "filter",
    cursor: 0,
    history: [],
    historyIdx: -1,
    mode: "find",
    pipeline: "",
    pipelineValidation: { valid: true },
    pipelineCursor: 0,
    pipelineHistory: [],
    pipelineHistoryIdx: -1,
  };
}

function freshResultsSlice(): ResultsSlice {
  return {
    docs: [],
    offset: 0,
    pageSize: 50,
    exactCount: null,
    estimatedTotal: null,
    elapsedMs: 0,
    loading: false,
    error: null,
    view: "table",
    selRow: 0,
    colOffset: 0,
    docsLine: 0,
    schema: null,
    foldedPaths: new Set<string>(),
    detailFolds: new Set<string>(),
    detailLine: 0,
    aggregate: false,
  };
}

function freshTree(): StoreState["tree"] {
  return {
    databases: [],
    collectionsByDb: {},
    expandedDbs: new Set<string>(),
    loadingDbs: new Set<string>(),
    sidebarFilter: "",
    sidebarFilterMode: false,
    sidebarFilterCursor: 0,
    sidebarSel: 0,
  };
}

function snapshotActive(s: StoreState): Tab {
  return {
    ...s.tabs[s.activeTab]!,
    ns: s.ns,
    label: s.ns?.coll ?? "—",
    query: s.query,
    results: s.results,
  };
}

export const useStore = create<StoreState>((set, get) => ({
  conn: { host: "", latencyMs: null, ok: false },
  tree: freshTree(),
  ns: null,
  query: freshQuerySlice(emptyValidation()),
  results: freshResultsSlice(),
  tabs: [{ id: 1, label: "—", ns: null, query: freshQuerySlice(emptyValidation()), results: freshResultsSlice() }],
  activeTab: 0,
  nextTabId: 2,
  ui: {
    focusedPane: "sidebar",
    modal: null,
    toast: null,
    themeName: "mongo",
    themeModal: null,
    connModal: null,
    paletteModal: null,
  },

  setFocus: (pane) => set((s) => ({ ui: { ...s.ui, focusedPane: pane } })),

  cyclePane: (dir) =>
    set((s) => {
      const order: Pane[] = ["sidebar", "query", "results"];
      const idx = order.indexOf(s.ui.focusedPane);
      const next = order[(idx + dir + order.length) % order.length]!;
      return { ui: { ...s.ui, focusedPane: next } };
    }),

  toast: (text, color) => {
    if (toastTimer) clearTimeout(toastTimer);
    set((s) => ({ ui: { ...s.ui, toast: { text, color } } }));
    toastTimer = setTimeout(() => set((s) => ({ ui: { ...s.ui, toast: null } })), 4000);
  },

  setModal: (modal) => set((s) => ({ ui: { ...s.ui, modal } })),
  setThemeModal: (themeModal) => set((s) => ({ ui: { ...s.ui, themeModal } })),
  setConnModal: (connModal) => set((s) => ({ ui: { ...s.ui, connModal } })),
  setPaletteModal: (paletteModal) => set((s) => ({ ui: { ...s.ui, paletteModal } })),
  setThemeName: (themeName) => set((s) => ({ ui: { ...s.ui, themeName } })),

  loadDatabases: async () => {
    try {
      const dbs = await getService().listDatabases();
      set((s) => ({ tree: { ...s.tree, databases: dbs } }));
    } catch (e) {
      get().toast(message(e), T.red);
    }
  },

  toggleDb: async (name) => {
    const { tree } = get();
    const expanded = new Set(tree.expandedDbs);
    if (expanded.has(name)) {
      expanded.delete(name);
      set((s) => ({ tree: { ...s.tree, expandedDbs: expanded } }));
      return;
    }
    expanded.add(name);
    set((s) => ({ tree: { ...s.tree, expandedDbs: expanded } }));
    if (tree.collectionsByDb[name]) return;
    const loading = new Set(tree.loadingDbs);
    loading.add(name);
    set((s) => ({ tree: { ...s.tree, loadingDbs: loading } }));
    try {
      const colls = await getService().listCollections(name);
      set((s) => {
        const done = new Set(s.tree.loadingDbs);
        done.delete(name);
        return {
          tree: {
            ...s.tree,
            collectionsByDb: { ...s.tree.collectionsByDb, [name]: colls },
            loadingDbs: done,
          },
        };
      });
    } catch (e) {
      set((s) => {
        const done = new Set(s.tree.loadingDbs);
        done.delete(name);
        return { tree: { ...s.tree, loadingDbs: done } };
      });
      get().toast(message(e), T.red);
    }
  },

  // Load collection names for every database not yet loaded, so the sidebar
  // search finds collections across ALL databases (not just expanded ones).
  // Name-only (no counts) keeps it cheap even with many databases.
  loadAllCollections: async () => {
    const dbs = get().tree.databases;
    await Promise.all(dbs.map(async (db) => {
      if (get().tree.collectionsByDb[db.name]) return; // already loaded (with or without counts)
      try {
        const names = await getService().listCollectionNames(db.name);
        set((s) => (s.tree.collectionsByDb[db.name]
          ? {}
          : { tree: { ...s.tree, collectionsByDb: { ...s.tree.collectionsByDb, [db.name]: names.map((name) => ({ name, estimatedCount: null })) } } }));
      } catch { /* best-effort; search just won't include this db */ }
    }));
  },

  reloadTree: async () => {
    set((s) => ({
      tree: { ...s.tree, collectionsByDb: {}, databases: [] },
    }));
    await get().loadDatabases();
    // re-load collections for still-expanded dbs
    for (const db of get().tree.expandedDbs) {
      try {
        const colls = await getService().listCollections(db);
        set((s) => ({ tree: { ...s.tree, collectionsByDb: { ...s.tree.collectionsByDb, [db]: colls } } }));
      } catch { /* ignore */ }
    }
  },

  openCollection: async (ns) => {
    set((s) => ({
      ns,
      query: {
        ...s.query,
        input: { ...DEFAULT_QUERY_INPUT },
        validation: getService().validateQuery({ ...DEFAULT_QUERY_INPUT }),
        expanded: false,
        activeField: "filter",
        cursor: 0,
        historyIdx: -1,
        mode: "find",
      },
      results: {
        ...s.results,
        docs: [],
        offset: 0,
        exactCount: null,
        estimatedTotal: null,
        elapsedMs: 0,
        selRow: 0,
        colOffset: 0,
        docsLine: 0,
        schema: null,
        foldedPaths: new Set<string>(),
        error: null,
        aggregate: false,
      },
      ui: { ...s.ui, focusedPane: "results" },
    }));
    await doFind(set, get, 0);
    void sampleSchemaBg(set, get, ns);
  },

  switchConnection: async (name, uri) => {
    const previous = service;
    const svc = createMongoService(uri);
    let info: ConnectionInfo;
    try {
      info = await svc.connect();
    } catch (e) {
      try { await svc.close(); } catch { /* ignore */ }
      get().toast(message(e), T.red);
      return;
    }
    try { await previous?.close(); } catch { /* best effort */ }
    service = svc;
    setRuntimeService(svc);
    const validation = svc.validateQuery({ ...DEFAULT_QUERY_INPUT });
    set((s) => ({
      conn: { host: info.host, latencyMs: info.latencyMs, ok: info.ok, name },
      tree: freshTree(),
      ns: null,
      query: freshQuerySlice(validation),
      results: freshResultsSlice(),
      tabs: [{ id: 1, label: "—", ns: null, query: freshQuerySlice(validation), results: freshResultsSlice() }],
      activeTab: 0,
      nextTabId: 2,
      ui: { ...s.ui, connModal: null, focusedPane: "sidebar" },
    }));
    saveConfig({ lastConnection: name });
    get().toast(`connected to ${name}`, T.accent);
    await get().loadDatabases();
  },

  switchTab: (i) => {
    const s = get();
    if (i < 0 || i >= s.tabs.length || i === s.activeTab) return;
    const tabs = s.tabs.slice();
    tabs[s.activeTab] = snapshotActive(s);
    const target = tabs[i]!;
    set({ activeTab: i, tabs, ns: target.ns, query: target.query, results: target.results });
  },

  nextTab: (dir) => {
    const s = get();
    if (s.tabs.length <= 1) return;
    const i = (s.activeTab + dir + s.tabs.length) % s.tabs.length;
    get().switchTab(i);
  },

  openInNewTab: async (ns) => {
    const s = get();
    const validation = getService().validateQuery({ ...DEFAULT_QUERY_INPUT });
    const tabs = s.tabs.slice();
    tabs[s.activeTab] = snapshotActive(s);
    const id = s.nextTabId;
    const q = freshQuerySlice(validation);
    const r = freshResultsSlice();
    tabs.push({ id, label: ns.coll, ns: null, query: q, results: r });
    set({ tabs, activeTab: tabs.length - 1, nextTabId: id + 1, ns: null, query: q, results: r });
    await get().openCollection(ns);
  },

  duplicateTab: async () => {
    const s = get();
    if (!s.ns) {
      get().toast("no collection to duplicate", T.dim);
      return;
    }
    const tabs = s.tabs.slice();
    tabs[s.activeTab] = snapshotActive(s);
    const id = s.nextTabId;
    const q: QuerySlice = { ...s.query, historyIdx: -1, pipelineHistoryIdx: -1 };
    const r = freshResultsSlice();
    tabs.push({ id, label: s.ns.coll, ns: s.ns, query: q, results: r });
    set({ tabs, activeTab: tabs.length - 1, nextTabId: id + 1, ns: s.ns, query: q, results: r, ui: { ...s.ui, focusedPane: "results" } });
    if (q.mode === "aggregate") {
      await get().runAggregate();
    } else {
      await doFind(set, get, 0);
      void runCount(set, get);
    }
  },

  newEmptyTab: () => {
    const s = get();
    const validation = getService().validateQuery({ ...DEFAULT_QUERY_INPUT });
    const tabs = s.tabs.slice();
    tabs[s.activeTab] = snapshotActive(s);
    const id = s.nextTabId;
    const q = freshQuerySlice(validation);
    const r = freshResultsSlice();
    tabs.push({ id, label: "—", ns: null, query: q, results: r });
    set({ tabs, activeTab: tabs.length - 1, nextTabId: id + 1, ns: null, query: q, results: r, ui: { ...s.ui, focusedPane: "sidebar" } });
  },

  closeTab: () => {
    const s = get();
    if (s.tabs.length <= 1) {
      const validation = getService().validateQuery({ ...DEFAULT_QUERY_INPUT });
      const q = freshQuerySlice(validation);
      const r = freshResultsSlice();
      set({
        ns: null,
        query: q,
        results: r,
        tabs: [{ id: s.tabs[0]!.id, label: "—", ns: null, query: q, results: r }],
        activeTab: 0,
        ui: { ...s.ui, focusedPane: "sidebar" },
      });
      return;
    }
    const tabs = s.tabs.slice();
    tabs.splice(s.activeTab, 1);
    const nextActive = Math.min(s.activeTab, tabs.length - 1);
    const target = tabs[nextActive]!;
    set({ tabs, activeTab: nextActive, ns: target.ns, query: target.query, results: target.results });
  },

  sidebarMove: (delta) =>
    set((s) => ({ tree: { ...s.tree, sidebarSel: Math.max(0, s.tree.sidebarSel + delta) } })),

  sidebarTo: (index) => set((s) => ({ tree: { ...s.tree, sidebarSel: Math.max(0, index) } })),

  setSidebarFilterMode: (on) => {
    set((s) => ({
      tree: {
        ...s.tree,
        sidebarFilterMode: on,
        sidebarFilter: on ? s.tree.sidebarFilter : "",
        sidebarFilterCursor: on ? s.tree.sidebarFilterCursor : 0,
      },
    }));
    if (on) void get().loadAllCollections(); // make search reach every database
  },

  setSidebarFilter: (value, cursor) =>
    set((s) => ({ tree: { ...s.tree, sidebarFilter: value, sidebarFilterCursor: cursor, sidebarSel: 0 } })),

  setQueryField: (field, value, cursor) =>
    set((s) => {
      const input = { ...s.query.input, [field]: value };
      return { query: { ...s.query, input, cursor, validation: getService().validateQuery(input) } };
    }),

  setActiveField: (field) =>
    set((s) => ({ query: { ...s.query, activeField: field, cursor: s.query.input[field].length } })),

  setExpanded: (expanded) =>
    set((s) => ({ query: { ...s.query, expanded, activeField: expanded ? s.query.activeField : "filter" } })),

  recallHistory: (dir) =>
    set((s) => {
      const { history } = s.query;
      if (history.length === 0) return {};
      let idx = s.query.historyIdx + dir;
      idx = Math.max(-1, Math.min(history.length - 1, idx));
      const value = idx === -1 ? "" : history[idx]!;
      const input = { ...s.query.input, filter: value };
      return {
        query: {
          ...s.query,
          historyIdx: idx,
          input,
          cursor: value.length,
          validation: getService().validateQuery(input),
        },
      };
    }),

  runQuery: async () => {
    const { query, ns } = get();
    if (!ns) return;
    if (!allValid(query.validation)) {
      const bad = FIELD_ORDER.find((f) => !query.validation[f].valid)!;
      // Never refuse silently: jump the cursor to the offending field so the
      // inline error is visible, and expand the bar if the field is hidden.
      set((s) => ({
        query: {
          ...s.query,
          activeField: bad,
          cursor: s.query.input[bad].length,
          expanded: s.query.expanded || bad !== "filter",
        },
        ui: { ...s.ui, focusedPane: "query" },
      }));
      get().toast(`${bad}: ${query.validation[bad].error ?? "invalid"} — fix or clear it`, T.red);
      return;
    }
    pushHistory(set, get, query.input.filter);
    set((s) => ({ results: { ...s.results, offset: 0, selRow: 0, colOffset: 0, docsLine: 0 } }));
    await doFind(set, get, 0);
    void runCount(set, get);
  },

  refresh: async () => {
    if (!get().ns) return;
    if (get().query.mode === "aggregate") {
      await get().runAggregate();
      return;
    }
    await doFind(set, get, get().results.offset);
    void runCount(set, get);
  },

  setPage: async (offset) => {
    if (!get().ns) return;
    const total = get().results.exactCount ?? get().results.estimatedTotal ?? Infinity;
    if (offset < 0 || offset >= total) return;
    set((s) => ({ results: { ...s.results, selRow: 0, docsLine: 0 } }));
    await doFind(set, get, offset);
  },

  sortBy: async (field) => {
    if (get().query.mode === "aggregate") return;
    const cur = get().query.input.sort.trim();
    const asc = `{ "${field}": 1 }`;
    const desc = `{ "${field}": -1 }`;
    const nextSort = cur === asc ? desc : cur === desc ? "" : asc;
    set((s) => {
      const input = { ...s.query.input, sort: nextSort };
      return { query: { ...s.query, input, validation: getService().validateQuery(input) } };
    });
    await get().runQuery();
  },

  toggleMode: () =>
    set((s) => {
      const mode: QueryMode = s.query.mode === "find" ? "aggregate" : "find";
      return {
        query: { ...s.query, mode, activeField: "filter", expanded: false },
        ui: { ...s.ui, focusedPane: "query" },
      };
    }),

  setPipeline: (value, cursor) =>
    set((s) => ({
      query: { ...s.query, pipeline: value, pipelineCursor: cursor, pipelineValidation: validatePipelineText(value) },
    })),

  recallPipelineHistory: (dir) =>
    set((s) => {
      const { pipelineHistory } = s.query;
      if (pipelineHistory.length === 0) return {};
      let idx = s.query.pipelineHistoryIdx + dir;
      idx = Math.max(-1, Math.min(pipelineHistory.length - 1, idx));
      const value = idx === -1 ? "" : pipelineHistory[idx]!;
      return {
        query: {
          ...s.query,
          pipelineHistoryIdx: idx,
          pipeline: value,
          pipelineCursor: value.length,
          pipelineValidation: validatePipelineText(value),
        },
      };
    }),

  runAggregate: async () => {
    const { query, ns } = get();
    if (!ns) return;
    const text = query.pipeline;
    if (!text.trim()) {
      get().toast("pipeline is empty", T.dim);
      return;
    }
    const validation = validatePipelineText(text);
    if (!validation.valid) {
      set((s) => ({ ui: { ...s.ui, focusedPane: "query" } }));
      get().toast(`pipeline: ${validation.error ?? "invalid"} — fix or clear it`, T.red);
      return;
    }
    let stages: Record<string, unknown>[];
    try {
      stages = parsePipeline(text);
    } catch (e) {
      get().toast(message(e), T.red);
      return;
    }
    const maxTimeMS = query.input.maxTimeMS.trim() ? Number(query.input.maxTimeMS) : 10_000;
    const token = ++findToken;
    if (countAbort) countAbort.abort();
    set((s) => ({ results: { ...s.results, loading: true, error: null } }));
    try {
      const { docs, elapsedMs } = await getService().runAggregate(ns, stages, maxTimeMS);
      if (token !== findToken) return;
      pushPipelineHistory(set, get, text);
      set((s) => ({
        results: {
          ...s.results,
          docs,
          offset: 0,
          exactCount: docs.length,
          estimatedTotal: null,
          elapsedMs: Math.round(elapsedMs),
          loading: false,
          error: null,
          aggregate: true,
          selRow: 0,
          docsLine: 0,
          detailLine: 0,
          foldedPaths: computeDefaultFolds(docs),
        },
      }));
    } catch (e) {
      if (token !== findToken) return;
      set((s) => ({ results: { ...s.results, loading: false, error: message(e) } }));
      get().toast(message(e), T.red);
    }
  },

  setView: (view) => set((s) => ({ results: { ...s.results, view } })),

  setSelRow: (row) =>
    set((s) => ({ results: { ...s.results, selRow: Math.max(0, Math.min(s.results.docs.length - 1, row)) } })),

  // Horizontal column paging for the table view; upper bound is clamped by the
  // TableView (which knows the real column count) via setColOffset.
  scrollCols: (dir) => set((s) => ({ results: { ...s.results, colOffset: Math.max(0, s.results.colOffset + dir) } })),
  setColOffset: (n) => set((s) => ({ results: { ...s.results, colOffset: Math.max(0, n) } })),

  setDocsLine: (line) => set((s) => ({ results: { ...s.results, docsLine: Math.max(0, line) } })),

  toggleFold: (key) =>
    set((s) => {
      const folded = new Set(s.results.foldedPaths);
      if (folded.has(key)) folded.delete(key);
      else folded.add(key);
      return { results: { ...s.results, foldedPaths: folded } };
    }),

  openDetail: (row) =>
    set((s) => {
      const selRow = Math.max(0, Math.min(s.results.docs.length - 1, row ?? s.results.selRow));
      const doc = s.results.docs[selRow];
      if (!doc) return {};
      return {
        results: {
          ...s.results,
          selRow,
          view: "detail",
          detailFolds: detailDefaultFolds(doc),
          detailLine: 0,
        },
      };
    }),

  setDetailLine: (line) => set((s) => ({ results: { ...s.results, detailLine: Math.max(0, line) } })),

  toggleDetailFold: (key) =>
    set((s) => {
      const folded = new Set(s.results.detailFolds);
      if (folded.has(key)) folded.delete(key);
      else folded.add(key);
      return { results: { ...s.results, detailFolds: folded } };
    }),

  detailMoveDoc: (dir) => {
    const s = get();
    const next = s.results.selRow + dir;
    if (next >= 0 && next < s.results.docs.length) s.openDetail(next);
  },

  explain: async () => {
    const { ns, query } = get();
    if (!ns) return null;
    if (query.mode === "aggregate") {
      get().toast("explain is not available in aggregate mode", T.dim);
      return null;
    }
    try {
      const parsed = getService().parseQuery(query.input);
      return await getService().explain(ns, parsed);
    } catch (e) {
      get().toast(message(e), T.red);
      return null;
    }
  },
}));

function emptyValidation(): QueryValidation {
  const base = {} as QueryValidation;
  for (const f of FIELD_ORDER) base[f] = { valid: true };
  return base;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type SetFn = (partial: Partial<StoreState> | ((s: StoreState) => Partial<StoreState>)) => void;
type GetFn = () => StoreState;

async function doFind(set: SetFn, get: GetFn, offset: number): Promise<void> {
  const { ns, query } = get();
  if (!ns) return;
  const token = ++findToken;
  set((s) => ({ results: { ...s.results, loading: true, error: null } }));
  try {
    const parsed = getService().parseQuery(query.input);
    const page = await getService().runFind(ns, parsed, offset, get().results.pageSize);
    if (token !== findToken) return;
    set((s) => ({
      results: {
        ...s.results,
        docs: page.docs,
        offset: page.offset,
        exactCount: page.exactCount,
        estimatedTotal: page.estimatedTotal,
        elapsedMs: Math.round(page.elapsedMs),
        loading: false,
        aggregate: false,
        selRow: Math.min(s.results.selRow, Math.max(0, page.docs.length - 1)),
        docsLine: 0,
        foldedPaths: computeDefaultFolds(page.docs),
        detailLine: 0,
        detailFolds:
          s.results.view === "detail" && page.docs.length
            ? detailDefaultFolds(page.docs[Math.min(s.results.selRow, page.docs.length - 1)]!)
            : s.results.detailFolds,
      },
    }));
  } catch (e) {
    if (token !== findToken) return;
    set((s) => ({ results: { ...s.results, loading: false, error: message(e) } }));
    get().toast(message(e), T.red);
  }
}

async function runCount(set: SetFn, get: GetFn): Promise<void> {
  const { ns, query } = get();
  if (!ns) return;
  if (!query.input.filter.trim()) return; // exact count only meaningful for a real filter
  if (countAbort) countAbort.abort();
  countAbort = new AbortController();
  const signal = countAbort.signal;
  const token = ++countToken;
  try {
    const parsed = getService().parseQuery(query.input);
    const count = await getService().countExact(ns, parsed, signal);
    if (token !== countToken) return;
    set((s) => ({ results: { ...s.results, exactCount: count } }));
  } catch (e) {
    if (signal.aborted) return;
    // ignore other count errors silently; find already succeeded
    void e;
  }
}

async function sampleSchemaBg(set: SetFn, get: GetFn, ns: Namespace): Promise<void> {
  try {
    const schema = await getService().sampleSchema(ns);
    if (get().ns && get().ns!.db === ns.db && get().ns!.coll === ns.coll) {
      set((s) => ({ results: { ...s.results, schema } }));
    }
  } catch { /* schema is best-effort */ }
}

function pushHistory(set: SetFn, get: GetFn, filter: string): void {
  const trimmed = filter.trim();
  if (!trimmed) return;
  set((s) => {
    const history = [trimmed, ...s.query.history.filter((h) => h !== trimmed)].slice(0, 50);
    return { query: { ...s.query, history, historyIdx: -1 } };
  });
}

function pushPipelineHistory(set: SetFn, get: GetFn, pipeline: string): void {
  const trimmed = pipeline.trim();
  if (!trimmed) return;
  set((s) => {
    const pipelineHistory = [trimmed, ...s.query.pipelineHistory.filter((h) => h !== trimmed)].slice(0, 50);
    return { query: { ...s.query, pipelineHistory, pipelineHistoryIdx: -1 } };
  });
}

/** Called from index.tsx before render. Wires the service and starts the ping loop. */
export function initStore(svc: MongoService, conn: ConnectionInfo, name?: string): void {
  service = svc;
  useStore.setState((s) => ({
    conn: { host: conn.host, latencyMs: conn.latencyMs, ok: conn.ok, name },
    query: { ...s.query, validation: svc.validateQuery(s.query.input) },
  }));
  pingTimer = setInterval(async () => {
    try {
      const latency = await svc.ping();
      useStore.setState((s) => ({ conn: { ...s.conn, latencyMs: latency, ok: true } }));
    } catch {
      useStore.setState((s) => ({ conn: { ...s.conn, ok: false } }));
    }
  }, 15000);
}

/** Stop all timers and abort in-flight work (for clean shutdown). */
export function teardownStore(): void {
  if (pingTimer) clearInterval(pingTimer);
  if (toastTimer) clearTimeout(toastTimer);
  if (countAbort) countAbort.abort();
  pingTimer = null;
  toastTimer = null;
}
