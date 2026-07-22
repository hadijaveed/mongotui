import { useEffect, useRef } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { bsonTypeName, cellText, QUERY_PARSER } from "../data/format.ts";
import { useStore } from "../state/store.ts";
import { T } from "./theme.ts";
import { cellColor } from "./valueSpans.tsx";

interface Column {
  path: string;
  width: number;
}

function getByPath(doc: Record<string, unknown>, path: string): unknown {
  if (path in doc) return doc[path];
  let cur: unknown = doc;
  for (const part of path.split(".")) {
    if (cur && typeof cur === "object" && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else return undefined;
  }
  return cur;
}

function isNameish(path: string): boolean {
  return /(^|\.)(name|title)$/i.test(path);
}

const SCALAR_TYPES = new Set(["string", "int32", "double", "long", "decimal128", "date", "bool"]);

/**
 * Rank schema fields for column display: identifying fields first, scalars over
 * arrays/refs, parents with visible children excluded, deep paths dampened.
 */
function scoreField(f: { path: string; probability: number; types: string[] }): number {
  const primary = f.types[0] ?? "undefined";
  const depth = f.path.split(".").length;
  let score = f.probability;
  if (/(^|\.)(name|title|label|email|username|key)$/i.test(f.path)) score += 0.5;
  if (/(^|\.)(year|date|created|updated|released|status|type)/i.test(f.path)) score += 0.15;
  if (SCALAR_TYPES.has(primary)) score += 0.2;
  if (primary === "array") score -= 0.3;
  if (primary === "objectId") score -= 0.2;
  score -= 0.15 * (depth - 1);
  return score;
}

function pickColumnPaths(
  docs: Record<string, unknown>[],
  schemaFields: { path: string; probability: number; types: string[] }[],
  projectText: string,
): string[] {
  if (projectText.trim()) {
    try {
      const proj = QUERY_PARSER.parseProject(projectText) as Record<string, unknown>;
      const keys = Object.keys(proj);
      const included = keys.filter((k) => proj[k] === 1 || proj[k] === true);
      if (included.length) {
        const idExcluded = proj._id === 0 || proj._id === false;
        const cols = included.filter((k) => k !== "_id");
        return idExcluded ? cols : ["_id", ...cols.filter((c) => c !== "_id")];
      }
      // exclusion projection: schema columns minus excluded
      const excluded = new Set(keys.filter((k) => proj[k] === 0 || proj[k] === false));
      return ["_id", ...schemaFields.map((f) => f.path).filter((p) => p !== "_id" && !excluded.has(p))];
    } catch {
      /* fall through to schema */
    }
  }
  const hasChildren = new Set<string>();
  for (const f of schemaFields) {
    const idx = f.path.lastIndexOf(".");
    if (idx > 0) hasChildren.add(f.path.slice(0, idx));
  }
  const ranked = schemaFields
    .filter((f) => f.path !== "_id" && !((f.types[0] ?? "") === "object" && hasChildren.has(f.path)))
    .map((f) => ({ path: f.path, score: scoreField(f) }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return ["_id", ...ranked.map((f) => f.path)];
}

/**
 * Aggregate result columns come from the result docs, not the collection schema:
 * union of top-level keys across the first 20 docs, _id first, then by frequency
 * then name.
 */
function aggregateColumnPaths(docs: Record<string, unknown>[]): string[] {
  const freq = new Map<string, number>();
  for (const doc of docs.slice(0, 20)) {
    if (!doc || typeof doc !== "object") continue;
    for (const key of Object.keys(doc)) freq.set(key, (freq.get(key) ?? 0) + 1);
  }
  const keys = [...freq.keys()].filter((k) => k !== "_id");
  keys.sort((a, b) => (freq.get(b)! - freq.get(a)!) || a.localeCompare(b));
  return freq.has("_id") ? ["_id", ...keys] : keys;
}

function buildColumns(
  paths: string[],
  docs: Record<string, unknown>[],
  available: number,
): Column[] {
  const columns: Column[] = [];
  let used = 0;
  let firstStringCapped = false;
  for (const path of paths) {
    let max = path.length;
    let looksString = false;
    for (const doc of docs) {
      const v = getByPath(doc, path);
      if (v === undefined) continue;
      if (bsonTypeName(v) === "string") looksString = true;
      max = Math.max(max, cellText(v, 99).length);
    }
    const cap = !firstStringCapped && looksString && isNameish(path) ? 32 : 26;
    let width = Math.max(6, Math.min(cap, max));
    if (cap === 32) firstStringCapped = true;
    if (used + width + 1 > available && columns.length > 0) {
      const remaining = available - used - 1;
      if (remaining >= 6) {
        width = remaining;
        columns.push({ path, width });
      }
      break;
    }
    columns.push({ path, width });
    used += width + 1;
  }
  return columns;
}

export function TableView(): React.ReactNode {
  const results = useStore((s) => s.results);
  const query = useStore((s) => s.query);
  const dims = useTerminalDimensions();
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const lastClick = useRef<{ row: number; at: number }>({ row: -1, at: 0 });

  const available = Math.max(20, dims.width - 30 - 4);
  const schemaFields = results.schema?.fields ?? [];
  const paths = results.aggregate
    ? aggregateColumnPaths(results.docs)
    : pickColumnPaths(results.docs, schemaFields, query.input.project);
  // Horizontal column paging: `< >` / clicks shift a window across all columns so
  // wide rows aren't truncated away. TableView owns the real column count, so it
  // clamps the store's offset here.
  const maxOff = Math.max(0, paths.length - 1);
  const off = Math.min(results.colOffset, maxOff);
  const INDICATOR_W = 18;
  let columns = buildColumns(paths.slice(off), results.docs, available);
  let hiddenRight = paths.length - (off + columns.length);
  // When columns overflow, reserve room on the right for the `‹ cols x–y/z ›`
  // indicator so it never collides with the last data column.
  if (off > 0 || hiddenRight > 0) {
    columns = buildColumns(paths.slice(off), results.docs, available - INDICATOR_W);
    hiddenRight = paths.length - (off + columns.length);
  }

  useEffect(() => {
    if (results.colOffset > maxOff) useStore.getState().setColOffset(maxOff);
  }, [results.colOffset, maxOff]);

  let sortMap: Record<string, unknown> = {};
  if (query.validation.sort.valid && query.input.sort.trim()) {
    try {
      sortMap = QUERY_PARSER.parseSort(query.input.sort) as Record<string, unknown>;
    } catch { /* ignore */ }
  }

  useEffect(() => {
    scrollRef.current?.scrollChildIntoView(`tr-${results.selRow}`);
  }, [results.selRow]);

  const onRowClick = (i: number): void => {
    const now = Date.now();
    const store = useStore.getState();
    store.setFocus("results");
    store.setSelRow(i);
    if (lastClick.current.row === i && now - lastClick.current.at < 350) {
      store.openDetail(i);
    }
    lastClick.current = { row: i, at: now };
  };

  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      <box style={{ height: 1, flexDirection: "row" }}>
        {columns.map((col) => {
          const dir = sortMap[col.path];
          const arrow = dir === 1 || dir === "1" ? " ↑" : dir === -1 || dir === "-1" ? " ↓" : "";
          const sorted = arrow !== "";
          const head = (col.path + arrow).slice(0, col.width).padEnd(col.width);
          return (
            <box
              key={col.path}
              onMouseDown={() => {
                useStore.getState().setFocus("results");
                void useStore.getState().sortBy(col.path);
              }}
            >
              <text><span fg={sorted ? T.text : T.dim}>{head + " "}</span></text>
            </box>
          );
        })}
        {off > 0 || hiddenRight > 0 ? (
          <box style={{ flexGrow: 1, flexDirection: "row", justifyContent: "flex-end", alignItems: "center" }}>
            <box onMouseDown={() => useStore.getState().scrollCols(-1)}>
              <text><span fg={off > 0 ? T.focus : T.dim}>{"‹ "}</span></text>
            </box>
            <text><span fg={T.dim}>{`cols ${off + 1}–${off + columns.length}/${paths.length}`}</span></text>
            <box onMouseDown={() => useStore.getState().scrollCols(1)}>
              <text><span fg={hiddenRight > 0 ? T.focus : T.dim}>{" ›"}</span></text>
            </box>
          </box>
        ) : null}
      </box>
      <scrollbox ref={scrollRef} style={{ flexGrow: 1 }}>
        {results.docs.length === 0 && !results.loading ? (
          <text><span fg={T.dim}>no documents</span></text>
        ) : (
          results.docs.map((doc, i) => (
            <box
              key={i}
              id={`tr-${i}`}
              onMouseDown={() => onRowClick(i)}
              style={{ height: 1, flexDirection: "row", backgroundColor: i === results.selRow ? T.selBg : undefined }}
            >
              {columns.map((col) => {
                const v = getByPath(doc, col.path);
                if (v === undefined) {
                  return (
                    <text key={col.path}><span fg={T.dim}>{"—".padEnd(col.width) + " "}</span></text>
                  );
                }
                const { color, attributes } = cellColor(v);
                const text = cellText(v, col.width).padEnd(col.width);
                return (
                  <text key={col.path}><span fg={color} attributes={attributes}>{text + " "}</span></text>
                );
              })}
            </box>
          ))
        )}
      </scrollbox>
    </box>
  );
}
