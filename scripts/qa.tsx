/**
 * Visual QA driver: boots the real app against the seeded local MongoDB with the
 * test renderer, walks through the primary flows, and writes a char frame per
 * checkpoint to the directory given as argv[2] (default: ./qa-frames).
 */
import { testRender } from "@opentui/react/test-utils";
import { createMongoService } from "../src/data/service.ts";
import { initStore, teardownStore, useStore } from "../src/state/store.ts";
import { sidebarRows } from "../src/ui/Sidebar.tsx";
import { openConnections } from "../src/ui/actions.ts";
import { saveConfig } from "../src/config.ts";
import { App } from "../src/ui/App.tsx";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUT = process.argv[2] ?? "qa-frames";
mkdirSync(OUT, { recursive: true });

// Sandbox config writes (theme keep / connection add) into a throwaway dir so the
// QA run never touches the user's real ~/.config/mongotui/config.json.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "mongotui-qa-cfg-"));

const URI = process.env.MONGOTUI_URI ?? "mongodb://localhost:27017";
const service = createMongoService(URI);
const info = await service.connect();
initStore(service, info);
await useStore.getState().loadDatabases();

const t = await testRender(<App />, { width: 140, height: 38 });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(name: string, pred: () => boolean, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i++) {
    await t.renderOnce();
    if (pred()) return;
    await sleep(25);
  }
  console.error(`TIMEOUT waiting for: ${name}`);
}

let n = 0;
const snap = async (name: string): Promise<void> => {
  await t.renderOnce();
  n++;
  writeFileSync(join(OUT, `${String(n).padStart(2, "0")}-${name}.txt`), t.captureCharFrame());
  console.error(`snap ${name}`);
};

await until("boot", () => t.captureCharFrame().includes("mflix"));
await snap("boot");

// open mflix.movies
await until("tree", () => sidebarRows(useStore.getState().tree).some((r) => r.db === "mflix"));
useStore.getState().sidebarTo(sidebarRows(useStore.getState().tree).findIndex((r) => r.db === "mflix"));
await t.mockInput.pressKey("l");
await until("colls", () => Boolean(useStore.getState().tree.collectionsByDb.mflix));
useStore.getState().sidebarTo(sidebarRows(useStore.getState().tree).findIndex((r) => r.coll === "movies"));
t.mockInput.pressEnter();
await until("docs", () => useStore.getState().results.docs.length > 0, 300);
await snap("table-unfiltered");

// filter query
useStore.getState().setFocus("results");
await t.mockInput.pressKey("/");
await until("query-focus", () => useStore.getState().ui.focusedPane === "query");
await t.mockInput.typeText('{ year: { $gte: 2010 }, "imdb.rating": { $gte: 8 } }');
await snap("query-typed");
t.mockInput.pressEnter();
await until("exact-count", () => useStore.getState().results.exactCount !== null, 300);
await snap("table-filtered");

// expanded options with sort
await t.mockInput.pressTab(); // expand → project
await t.mockInput.pressTab(); // sort
await t.mockInput.typeText('{ "imdb.rating": -1 }');
await snap("query-expanded");
t.mockInput.pressEnter();
await until("sorted", () => !useStore.getState().results.loading, 300);
await snap("table-sorted");

// invalid filter
useStore.getState().setQueryField("filter", "{ year: { $gte", 14);
await snap("query-invalid");
useStore.getState().setQueryField("filter", "{ year: { $gte: 2010 } }", 24);

// invalid SORT + enter: must jump activeField to sort and show error in title
useStore.getState().setQueryField("sort", "?", 1);
t.mockInput.pressEnter();
await t.renderOnce();
console.error(
  `after enter w/ bad sort: activeField=${useStore.getState().query.activeField} expanded=${useStore.getState().query.expanded} toast=${useStore.getState().ui.toast?.text}`,
);
await snap("query-invalid-sort");
useStore.getState().setQueryField("sort", "", 0);
useStore.getState().setExpanded(false);

// docs view
await t.mockInput.pressEscape();
await until("results-focus", () => useStore.getState().ui.focusedPane === "results");
await t.mockInput.pressKey("v");
await snap("docs-view");

for (let i = 0; i < 6; i++) await t.mockInput.pressKey("j");
await snap("docs-nav");

// detail view via Enter from table
await t.mockInput.pressKey("v"); // back to table
await t.renderOnce();
await t.mockInput.pressKey("j");
await t.mockInput.pressKey("j");
t.mockInput.pressEnter();
await until("detail", () => useStore.getState().results.view === "detail");
await snap("detail-view");
await t.mockInput.pressKey("J"); // next doc
await t.renderOnce();
console.error(`detail doc after J: ${useStore.getState().results.selRow}`);
await t.mockInput.pressEscape();
await until("back-to-table", () => useStore.getState().results.view === "table");

// scrolling: clear the filter so a full 50-row page loads (viewport is ~27 rows)
useStore.getState().setQueryField("filter", "", 0);
await useStore.getState().runQuery();
await until("full-page", () => useStore.getState().results.docs.length === 50, 300);
await t.mockInput.pressKey("G");
await t.renderOnce();
const selAfterG = useStore.getState().results.selRow;
const lastTitle = String((useStore.getState().results.docs[selAfterG] as { title?: string }).title ?? "@@nope");
console.error(`selRow after G: ${selAfterG}; last-row-visible: ${t.captureCharFrame().includes(lastTitle)} (${lastTitle})`);
await snap("table-bottom");
await t.mockInput.pressKey("g");
await t.renderOnce();

// mouse wheel over the table: viewport should move even though selection stays
const firstRowTitle = String((useStore.getState().results.docs[0] as { title?: string }).title ?? "@@nope");
for (let i = 0; i < 5; i++) await t.mockMouse.scroll(70, 20, "down");
await t.renderOnce();
console.error(`wheel: first row "${firstRowTitle}" still visible after 5 wheel-downs: ${t.captureCharFrame().includes(firstRowTitle)}`);
await snap("after-wheel");

await t.mockInput.pressKey("?");
await snap("help");
console.error(`modal after ?: ${useStore.getState().ui.modal?.kind}`);
await t.mockInput.pressEscape();
await until("help-closed", () => useStore.getState().ui.modal === null);
console.error(`modal after esc: ${useStore.getState().ui.modal?.kind}`);

await t.mockInput.pressKey("d");
await until("confirm-open", () => useStore.getState().ui.modal?.kind === "confirm");
await snap("confirm-delete");
await t.mockInput.pressEscape();
await until("confirm-closed", () => useStore.getState().ui.modal === null);

// mouse: back to table view, click row 5, then click the year column header to sort
await t.mockInput.pressKey("v");
await t.renderOnce();
const frame = t.captureCharFrame();
const headerLine = frame.split("\n").findIndex((l) => l.includes("title"));
t.mockMouse.click(40, headerLine + 4); // 4th visible row
await t.renderOnce();
console.error(`selRow after click at row-line ${headerLine + 4}: ${useStore.getState().results.selRow}`);
const headerCols = frame.split("\n")[headerLine] ?? "";
const yearX = headerCols.indexOf("year");
if (yearX >= 0 && headerLine >= 0) {
  t.mockMouse.click(yearX + 1, headerLine);
  await until("sort-applied", () => useStore.getState().query.input.sort.includes("year"), 100);
  console.error(`sort after header click: ${useStore.getState().query.input.sort}`);
}
await snap("mouse-sorted");

// ---- TABS: open users in a NEW tab via `o`, verify the movies filter survives a switch ----
if (useStore.getState().ns?.coll !== "movies") {
  await useStore.getState().openCollection({ db: "mflix", coll: "movies" });
  await until("movies-open", () => useStore.getState().ns?.coll === "movies", 300);
}
useStore.getState().setFocus("query");
useStore.getState().setActiveField("filter");
useStore.getState().setQueryField("filter", '{ year: { $gte: 2015 } }', 24);
await useStore.getState().runQuery();
await until("movies-refiltered", () => !useStore.getState().results.loading, 300);

useStore.getState().setFocus("sidebar");
useStore.getState().sidebarTo(sidebarRows(useStore.getState().tree).findIndex((r) => r.coll === "users"));
await t.mockInput.pressKey("o"); // open users in a new tab
await until("users-tab", () => useStore.getState().ns?.coll === "users" && useStore.getState().tabs.length >= 2, 300);
await snap("tab-users");
console.error(`tabs after 'o' on users: count=${useStore.getState().tabs.length} activeNs=${useStore.getState().ns?.coll}`);

await t.mockInput.pressKey("["); // switch back to movies tab
await until("back-to-movies", () => useStore.getState().ns?.coll === "movies", 200);
console.error(`movies filter survived tab switch: "${useStore.getState().query.input.filter}"`);
await snap("tab-movies-restored");
await t.mockInput.pressKey("]"); // forward to users again
await until("forward-users", () => useStore.getState().ns?.coll === "users", 200);
await t.mockInput.pressKey("["); // and back to movies for the aggregate test
await until("movies-again", () => useStore.getState().ns?.coll === "movies", 200);

// ---- AGGREGATE: A toggles mode, run a $group pipeline over movies ----
useStore.getState().setFocus("results");
await t.mockInput.pressKey("A");
await until("agg-mode", () => useStore.getState().query.mode === "aggregate", 200);
await t.mockInput.typeText('[ { $group: { _id: "$year", n: { $sum: 1 } } } ]');
await snap("aggregate-typed");
t.mockInput.pressEnter();
await until("agg-results", () => useStore.getState().results.aggregate && !useStore.getState().results.loading, 400);
console.error(`aggregate: docs=${useStore.getState().results.docs.length} aggregate=${useStore.getState().results.aggregate}`);
await snap("aggregate-results");
await t.mockInput.pressEscape(); // leave pipeline editor
await until("agg-results-focus", () => useStore.getState().ui.focusedPane === "results", 200);

// ---- THEME: open picker, preview + keep tokyonight ----
await t.mockInput.pressKey(","); // open theme picker
await until("theme-modal", () => useStore.getState().ui.themeModal !== null, 200);
await t.mockInput.pressKey("j"); // mongo → terminal
await t.mockInput.pressKey("j"); // terminal → tokyonight (live preview)
await snap("theme-tokyonight");
console.error(`theme preview: ${useStore.getState().ui.themeName}`);
t.mockInput.pressEnter(); // keep
await until("theme-kept", () => useStore.getState().ui.themeModal === null, 200);
console.error(`theme kept: ${useStore.getState().ui.themeName}`);

// ---- CONNECTIONS: open the manager modal ----
await t.mockInput.pressKey("C");
await until("conn-modal", () => useStore.getState().ui.connModal !== null, 200);
await snap("connections");
console.error(`connections modal open: ${useStore.getState().ui.connModal !== null}`);
await t.mockInput.pressEscape();
await until("conn-closed", () => useStore.getState().ui.connModal === null, 200);

// ---- TAB BAR: click the `[ + ]` button to spawn a new empty tab ----
{
  const before = useStore.getState().tabs.length;
  const frame = t.captureCharFrame().split("\n");
  const row = frame.findIndex((l) => l.includes("[ + ]"));
  const col = row >= 0 ? (frame[row] ?? "").indexOf("[ + ]") : -1;
  if (row >= 0 && col >= 0) {
    t.mockMouse.click(col + 2, row);
    await until("plus-newtab", () => useStore.getState().tabs.length > before, 100);
  }
  console.error(`tab-bar '+' click: tabs ${before} → ${useStore.getState().tabs.length} (row=${row} col=${col})`);
  await snap("tab-plus-clicked");
}

// ---- COMMAND PALETTE: ctrl+k opens, filter → documents view, dynamic jump ----
useStore.getState().setFocus("results");
if (useStore.getState().ns?.coll !== "movies") {
  await useStore.getState().openCollection({ db: "mflix", coll: "movies" });
  await until("movies-for-palette", () => useStore.getState().results.docs.length > 0, 300);
}
useStore.getState().setView("table");
t.mockInput.pressKey("k", { ctrl: true });
await until("palette-open", () => useStore.getState().ui.paletteModal !== null, 100);
await snap("palette-open");
console.error(`palette opened via ctrl+k: ${useStore.getState().ui.paletteModal !== null}`);

await t.mockInput.typeText("docum"); // fuzzy → "documents view"
await t.renderOnce();
await snap("palette-filter-docum");
console.error(`palette query="${useStore.getState().ui.paletteModal?.query}"`);
t.mockInput.pressEnter(); // run "documents view"
await until("palette-docs-view", () => useStore.getState().results.view === "docs", 100);
console.error(`view after palette 'documents view' run: ${useStore.getState().results.view} (palette closed: ${useStore.getState().ui.paletteModal === null})`);
await snap("palette-docs-applied");

// dynamic collection jump: ctrl+p, type "users", Enter → open mflix.users
t.mockInput.pressKey("p", { ctrl: true });
await until("palette-open-2", () => useStore.getState().ui.paletteModal !== null, 100);
await t.mockInput.typeText("users");
await t.renderOnce();
await snap("palette-filter-users");
t.mockInput.pressEnter();
await until("palette-users-open", () => useStore.getState().ns?.coll === "users", 300);
console.error(`ns after palette dynamic jump 'users': ${useStore.getState().ns?.coll}`);
await snap("palette-users-open");

// ---- `:` PALETTE + `o` NEW TAB FROM RESULTS (tmux-proof, non-sidebar contexts) ----
await t.renderOnce();
useStore.getState().setFocus("results");
await t.mockInput.pressKey(":"); // colon opens the palette from the results pane
await until("colon-palette", () => useStore.getState().ui.paletteModal !== null, 100);
console.error(`':' opened palette from results: ${useStore.getState().ui.paletteModal !== null}`);
// esc closes it; the test-harness key delivery is async, so nudge again if needed.
await t.mockInput.pressEscape();
let colonClosed = false;
for (let i = 0; i < 80; i++) {
  await t.renderOnce();
  if (useStore.getState().ui.paletteModal === null) { colonClosed = true; break; }
  if (i === 25) await t.mockInput.pressEscape();
  await sleep(20);
}
console.error(`':' palette closed on esc: ${colonClosed}`);
useStore.getState().setPaletteModal(null); // safety: never leave a stray palette open for the next step

// select a collection in the sidebar, then press `o` while focused on RESULTS
useStore.getState().setFocus("sidebar");
useStore.getState().sidebarTo(sidebarRows(useStore.getState().tree).findIndex((r) => r.coll === "directors"));
useStore.getState().setFocus("results");
const tabsBeforeO = useStore.getState().tabs.length;
await t.mockInput.pressKey("o"); // `o` is global now — opens the selected coll in a new tab
await until("o-from-results", () => useStore.getState().tabs.length > tabsBeforeO, 200);
console.error(`'o' from results: tabs ${tabsBeforeO} → ${useStore.getState().tabs.length}`);

// ---- DOCS-VIEW SCROLL: the viewport must follow the cursor into off-screen cards ----
await useStore.getState().openCollection({ db: "mflix", coll: "comments" });
await until("comments-open", () => useStore.getState().results.docs.length > 0, 300);
useStore.getState().setFocus("results");
useStore.getState().setView("docs");
await t.renderOnce();
for (let i = 0; i < 60; i++) await t.mockInput.pressKey("j");
await t.renderOnce();
await t.renderOnce();
{
  const st = useStore.getState();
  const visibleCards = [...t.captureCharFrame().matchAll(/(\d+)\/\d+ · _id/g)].map((m) => m[1]);
  const selDocNum = String(st.results.selRow + 1);
  console.error(`docs-scroll: selRow=${st.results.selRow} docsLine=${st.results.docsLine} visibleCards=[${visibleCards.join(",")}] selVisible=${visibleCards.includes(selDocNum)}`);
  await snap("docs-scroll-follows");
}

// ---- HORIZONTAL COLUMN SCROLL: `>` reveals columns that don't fit the width ----
useStore.getState().setView("table");
await until("schema", () => useStore.getState().results.schema !== null, 200); // columns come from the sampled schema
await t.renderOnce();
const offBefore = useStore.getState().results.colOffset;
await t.mockInput.pressKey(">");
await until("col-right", () => useStore.getState().results.colOffset > offBefore, 40);
const offAfter = useStore.getState().results.colOffset;
const colsIndicator = t.captureCharFrame().includes("cols ");
console.error(`col-scroll: colOffset ${offBefore} → ${offAfter}, cols-indicator=${colsIndicator}`);
await snap("table-cols-scrolled");
await t.mockInput.pressKey("<");
await until("col-left", () => useStore.getState().results.colOffset < offAfter, 40);
console.error(`col-scroll back: colOffset now ${useStore.getState().results.colOffset}`);

// ---- CONNECTION TEST: `t` pings a saved connection without switching ----
saveConfig({ connections: [{ name: "qa-local", uri: URI }] });
openConnections();
await until("conn-mgr", () => useStore.getState().ui.connModal !== null, 100);
await t.mockInput.pressKey("t"); // test the highlighted connection
await until("conn-test-toast", () => /reachable|✗/.test(useStore.getState().ui.toast?.text ?? ""), 200);
console.error(`conn-test toast: "${useStore.getState().ui.toast?.text}"`);
await snap("connection-tested");
useStore.getState().setConnModal(null);

// ---- SELECTION CLEAR: a mouse drag must not leave a stale highlight after mouse-up ----
useStore.getState().setView("table");
await t.renderOnce();
const dragRow = (t.captureCharFrame().split("\n").findIndex((l) => l.includes("_id"))) + 3;
await t.mockMouse.drag(20, dragRow, 30, dragRow);
await t.renderOnce();
const selAfterDrag = t.renderer.getSelection();
const selText = selAfterDrag?.getSelectedText() ?? "";
console.error(`renderer selection after drag-end: null=${selAfterDrag === null} text.trim.len=${selText.trim().length}`);
await snap("after-drag-selection-cleared");

// ---- COLLECTION SEARCH: `/` finds collections across ALL databases (not just expanded ones) ----
{
  // Fresh tree so nothing is pre-loaded; only databases are known.
  await useStore.getState().reloadTree();
  await until("dbs", () => useStore.getState().tree.databases.some((d) => d.name === "mflix"), 200);
  const loadedBefore = Boolean(useStore.getState().tree.collectionsByDb.mflix);
  useStore.getState().setFocus("sidebar");
  await t.mockInput.pressKey("/"); // opens search → loads every db's collection names
  await until("search-loaded", () => Boolean(useStore.getState().tree.collectionsByDb.mflix), 200);
  await t.mockInput.typeText("director");
  await until("search-match", () => sidebarRows(useStore.getState().tree).some((r) => r.coll === "directors"), 100);
  const rows = sidebarRows(useStore.getState().tree);
  console.error(`collection-search: mflix loaded before='${loadedBefore}' after '/'=true; 'director' matched directors=${rows.some((r) => r.coll === "directors")}`);
  await snap("collection-search");
  // Enter drops into the still-filtered sidebar list (does NOT open directly).
  t.mockInput.pressEnter();
  await t.renderOnce();
  const s1 = useStore.getState();
  console.error(`search Enter → mode=${s1.tree.sidebarFilterMode} filterKept="${s1.tree.sidebarFilter}" pane=${s1.ui.focusedPane} sel-is-coll=${sidebarRows(s1.tree)[s1.tree.sidebarSel]?.type === "coll"}`);
  await snap("search-dropped-to-list");
  // Enter in the list opens the selected collection (focus moves to results
  // once the find completes — wait for that before poking the sidebar again).
  t.mockInput.pressEnter();
  await until("search-open", () => useStore.getState().ns?.coll === "directors", 200);
  await until("open-focus", () => useStore.getState().ui.focusedPane === "results", 200);
  console.error(`list Enter → ns=${useStore.getState().ns?.db}.${useStore.getState().ns?.coll}`);
  // Mock key events dispatch on the event loop — give each one a real tick
  // before reading state, or assertions race the keypress.
  const tick = async (): Promise<void> => { await t.renderOnce(); await sleep(30); await t.renderOnce(); };
  // Esc back in the sidebar clears the applied filter.
  useStore.getState().setFocus("sidebar");
  await tick();
  await t.mockInput.pressEscape();
  await tick();
  console.error(`sidebar esc → filter cleared="${useStore.getState().tree.sidebarFilter}" (empty=ok)`);
  // Tab inside the search box must not be dead: it commits the filter and cycles panes.
  await t.mockInput.pressKey("/");
  await tick();
  await t.mockInput.typeText("mov");
  await tick();
  await t.mockInput.pressTab();
  await tick();
  const s2 = useStore.getState();
  console.error(`search Tab → mode=${s2.tree.sidebarFilterMode} pane=${s2.ui.focusedPane} filterKept="${s2.tree.sidebarFilter}"`);
  useStore.getState().setSidebarFilterMode(false); // clean up for later scenarios
  useStore.getState().setFocus("sidebar");
}

// ---- SIDEBAR SCROLL: a long collection list must follow the cursor (no ghost/blank rows) ----
{
  // Long names + counts + a scrollbar reproduce the field bug: rows used to be
  // padded to the full inner width, so scrollbar columns made them wrap into
  // blank ghost rows and clipped counts ("26.4k" → "26.").
  const many = Array.from({ length: 120 }, (_, i) => ({
    name: i % 3 === 0 ? `qa_coll_long_name_padding_${String(i).padStart(3, "0")}` : `qa_coll_${String(i).padStart(3, "0")}`,
    estimatedCount: i % 2 === 0 ? (i + 1) * 137 : null,
  }));
  useStore.setState((s) => ({
    tree: {
      ...s.tree,
      databases: [{ name: "qa_scroll_db" } as unknown as (typeof s.tree.databases)[number]],
      collectionsByDb: { qa_scroll_db: many as unknown as (typeof s.tree.collectionsByDb)[string] },
      expandedDbs: new Set(["qa_scroll_db"]),
      sidebarSel: 1,
    },
  }));
  useStore.getState().setFocus("sidebar");
  for (let i = 0; i < 60; i++) { await t.mockInput.pressKey("j"); await t.renderOnce(); }
  await t.renderOnce();
  const sel = useStore.getState().tree.sidebarSel;
  const selName = many[sel - 1]!.name; // row 0 is the db header
  const frame = t.captureCharFrame();
  // Every line between the first and last visible collection row must be a real
  // row (blank left-columns there = the ghost-row bug), and counts must render
  // in full, never clipped by the scrollbar.
  const left = frame.split("\n").map((l) => l.slice(0, 30));
  const idxs = left.map((l, i) => (l.includes("qa_coll") ? i : -1)).filter((i) => i >= 0);
  const ghost = left.slice(idxs[0]!, idxs[idxs.length - 1]! + 1).filter((l) => l.trim() === "").length;
  const fullCount = frame.includes(String((sel % 2 === 1 ? sel : sel + 1) * 137)) || /\d+(\.\d+)?k/.test(left.join("\n"));
  console.error(`sidebar-scroll: sel=${sel} selectedVisible=${frame.includes(selName.slice(0, 20))} ghostRows=${ghost} countsRender=${fullCount} placeholder·=${left.some((l) => l.includes("·"))}`);
  await snap("sidebar-scroll-follows");
}

teardownStore();
await service.close();
console.log(`${n} frames written to ${OUT}`);
process.exit(0);
