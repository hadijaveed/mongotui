import { useEffect, useRef } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useStore, type StoreState } from "../state/store.ts";
import { T } from "./theme.ts";
import { LineEditor } from "./LineEditor.tsx";
import { sanitizeLabel } from "../data/format.ts";

export interface SidebarRow {
  type: "db" | "coll";
  db: string;
  coll?: string;
}

function compact(n: number | null): string {
  if (n === null) return "";
  const fmt = (x: number, s: string): string => `${x.toFixed(1).replace(/\.0$/, "")}${s}`;
  if (n < 1000) return String(n);
  if (n < 1e6) return fmt(n / 1e3, "k");
  if (n < 1e9) return fmt(n / 1e6, "M");
  return fmt(n / 1e9, "B");
}

/** Flatten databases/collections into the visible, filtered row list. */
export function sidebarRows(tree: StoreState["tree"]): SidebarRow[] {
  const rows: SidebarRow[] = [];
  const filter = tree.sidebarFilter.trim().toLowerCase();
  for (const db of tree.databases) {
    const colls = tree.collectionsByDb[db.name];
    const dbMatch = !filter || db.name.toLowerCase().includes(filter);
    const matching = filter
      ? (colls ?? []).filter((c) => c.name.toLowerCase().includes(filter))
      : (colls ?? []);
    if (filter && !dbMatch && matching.length === 0) continue;
    rows.push({ type: "db", db: db.name });
    const show = filter ? true : tree.expandedDbs.has(db.name);
    if (show && colls) {
      const list = filter && !dbMatch ? matching : colls;
      for (const c of list) rows.push({ type: "coll", db: db.name, coll: c.name });
    }
  }
  return rows;
}

const INNER = 27;

export function Sidebar({ focused }: { focused: boolean }): React.ReactNode {
  const tree = useStore((s) => s.tree);
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const rows = sidebarRows(tree);
  const sel = Math.min(tree.sidebarSel, Math.max(0, rows.length - 1));

  useEffect(() => {
    scrollRef.current?.scrollChildIntoView(`sb-${sel}`);
  }, [sel]);

  const onActivate = (i: number): void => {
    const store = useStore.getState();
    store.setFocus("sidebar");
    store.sidebarTo(i);
    const row = rows[i];
    if (!row) return;
    if (row.type === "db") void store.toggleDb(row.db);
    else void store.openCollection({ db: row.db, coll: row.coll! });
  };

  const bc = focused ? T.focus : T.border;
  const searching = tree.sidebarFilterMode;
  const filtering = searching && tree.sidebarFilter.trim().length > 0;
  return (
    <box
      title="databases"
      titleColor={focused ? T.focus : T.dim}
      border
      borderStyle="rounded"
      borderColor={bc}
      focusedBorderColor={bc}
      focused={focused}
      style={{ width: 30, flexDirection: "column", backgroundColor: T.panel }}
    >
      {/* Always-visible search box: `/` (or a click) searches collections across
          every database, not just the ones you've expanded. */}
      <box
        style={{ height: 1, flexDirection: "row", backgroundColor: searching ? T.selBg : undefined }}
        onMouseDown={() => useStore.getState().setSidebarFilterMode(true)}
      >
        <text><span fg={searching ? T.focus : T.dim}>{"⌕ "}</span></text>
        {searching ? (
          <LineEditor
            value={tree.sidebarFilter}
            cursor={tree.sidebarFilterCursor}
            focused
            colorize={false}
            width={INNER - 2}
            placeholder="search collections"
          />
        ) : tree.sidebarFilter.trim() ? (
          <text wrapMode="none">
            <span fg={T.focus}>{tree.sidebarFilter}</span>
            <span fg={T.dim}> · esc clears</span>
          </text>
        ) : (
          <text><span fg={T.dim}>search collections… /</span></text>
        )}
      </box>
      <scrollbox ref={scrollRef} focusable={false} viewportCulling={false} style={{ flexGrow: 1 }}>
        {rows.length === 0 ? (
          <text><span fg={T.dim}>{filtering ? "no matches" : tree.databases.length ? "no collections" : "loading…"}</span></text>
        ) : (
          rows.map((row, i) => (
            <SidebarRowView
              key={`${row.type}-${row.db}-${row.coll ?? ""}`}
              id={`sb-${i}`}
              row={row}
              selected={i === sel}
              expanded={tree.expandedDbs.has(row.db)}
              loading={tree.loadingDbs.has(row.db)}
              collCount={tree.collectionsByDb[row.db]?.length ?? null}
              estCount={
                row.type === "coll"
                  ? tree.collectionsByDb[row.db]?.find((c) => c.name === row.coll)?.estimatedCount ?? null
                  : null
              }
              onClick={() => onActivate(i)}
            />
          ))
        )}
      </scrollbox>
    </box>
  );
}

interface RowProps {
  id: string;
  row: SidebarRow;
  selected: boolean;
  expanded: boolean;
  loading: boolean;
  collCount: number | null;
  estCount: number | null;
  onClick: () => void;
}

function SidebarRowView({ id, row, selected, expanded, loading, collCount, estCount, onClick }: RowProps): React.ReactNode {
  const bar = { text: selected ? "▎" : " ", color: selected ? T.focus : T.dim };
  // Name and count are separate flex children with wrapping off: when the
  // scrollbox shows a scrollbar the row loses columns, and a single padded
  // text used to wrap into blank ghost rows / clip the count instead of
  // truncating the name. `·` = count unknown (failed/not loaded) — a real
  // empty collection shows 0.
  let name: React.ReactNode;
  let right: string | null = null;
  if (row.type === "db") {
    const marker = expanded ? "▾" : "▸";
    const count = collCount !== null ? ` (${collCount})` : loading ? " …" : "";
    name = (
      <>
        <span fg={T.text}>{`${marker} ${sanitizeLabel(row.db, INNER)}`}</span>
        <span fg={T.dim}>{count}</span>
      </>
    );
  } else {
    // sanitizeLabel: control chars in a real collection name would otherwise
    // reset the terminal cursor and blank the row (see format.ts).
    name = <span fg={T.text}>{`  ${sanitizeLabel(row.coll ?? "", INNER - 2)}`}</span>;
    right = estCount === null ? "·" : compact(estCount);
  }
  return (
    <box
      id={id}
      onMouseDown={onClick}
      style={{ height: 1, flexDirection: "row", backgroundColor: selected ? T.selBg : undefined }}
    >
      <text wrapMode="none" style={{ flexGrow: 1, flexShrink: 1 }}>
        <span fg={bar.color}>{bar.text}</span>
        {name}
      </text>
      {right !== null && (
        <text wrapMode="none" style={{ flexShrink: 0 }}>
          <span fg={T.dim}>{` ${right}`}</span>
        </text>
      )}
    </box>
  );
}
