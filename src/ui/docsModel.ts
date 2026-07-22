import type { ObjectId } from "bson";
import { bsonTypeName, cellText } from "../data/format.ts";
import { T } from "./theme.ts";
import { valueSpans, type Span } from "./valueSpans.tsx";

export interface DocLine {
  id: string;
  docIdx: number;
  kind: "header" | "line";
  foldKey?: string;
  indent: number;
  spans: Span[];
}

function isFoldable(value: unknown): boolean {
  const t = bsonTypeName(value);
  if (t === "array") return (value as unknown[]).length > 0;
  if (t === "object") return Object.keys(value as object).length > 0;
  return false;
}

function shortId(value: unknown): string {
  if (bsonTypeName(value) === "objectId") {
    const hex = (value as ObjectId).toHexString();
    return `${hex.slice(0, 6)}…${hex.slice(-6)}`;
  }
  return cellText(value, 24);
}

/** Short display form of a document _id, for card titles. */
export function shortDocId(value: unknown): string {
  return shortId(value);
}

/** Body lines only (headers excluded) — the navigable/rendered lines for the card view. */
export function docsBodyLines(docs: Record<string, unknown>[], folded: Set<string>): DocLine[] {
  return flattenDocs(docs, folded).filter((l) => l.kind !== "header");
}

/**
 * Documents view starts fully collapsed: every nested object / array is folded
 * (all depths), so each card is a compact list of its top-level fields with
 * nested structures shown as `{ … N fields }` / `[ … N ]` summaries the user can
 * unfold on demand with `space`. Scalars always render inline.
 */
export function computeDefaultFolds(docs: Record<string, unknown>[]): Set<string> {
  const folds = new Set<string>();
  docs.forEach((doc, docIdx) => {
    const walk = (value: unknown, path: string): void => {
      if (!isFoldable(value)) return;
      folds.add(`${docIdx}:${path}`);
      if (Array.isArray(value)) {
        value.forEach((child, i) => walk(child, `${path}.${i}`));
      } else {
        for (const [k, child] of Object.entries(value as object)) walk(child, `${path}.${k}`);
      }
    };
    for (const [k, v] of Object.entries(doc)) walk(v, k);
  });
  return folds;
}

/** Detail view starts almost fully expanded — only long arrays fold. */
export function detailDefaultFolds(doc: Record<string, unknown>): Set<string> {
  const folds = new Set<string>();
  const walk = (value: unknown, path: string): void => {
    if (!isFoldable(value)) return;
    if (Array.isArray(value)) {
      if (value.length > 30) folds.add(`0:${path}`);
      value.forEach((child, i) => walk(child, `${path}.${i}`));
    } else {
      for (const [k, child] of Object.entries(value as object)) walk(child, `${path}.${k}`);
    }
  };
  for (const [k, v] of Object.entries(doc)) walk(v, k);
  return folds;
}

function keyPrefix(key: string | null): Span[] {
  return key === null ? [] : [
    { text: key, color: T.key },
    { text: ": ", color: T.dim },
  ];
}

/** Flatten a page of docs into printable lines, honoring folded paths. */
export function flattenDocs(docs: Record<string, unknown>[], folded: Set<string>): DocLine[] {
  const lines: DocLine[] = [];

  const emit = (
    key: string | null,
    value: unknown,
    path: string,
    depth: number,
    docIdx: number,
    last: boolean,
  ): void => {
    const comma = last ? "" : ",";
    if (!isFoldable(value)) {
      lines.push({
        id: `d${docIdx}-${path}`,
        docIdx,
        kind: "line",
        indent: depth,
        spans: [...keyPrefix(key), ...valueSpans(value), { text: comma, color: T.dim }],
      });
      return;
    }
    const foldKey = `${docIdx}:${path}`;
    const isArr = Array.isArray(value);
    const openCh = isArr ? "[" : "{";
    const closeCh = isArr ? "]" : "}";

    if (folded.has(foldKey)) {
      const count = isArr ? (value as unknown[]).length : Object.keys(value as object).length;
      const summary = isArr ? `[ … ${count} ]` : `{ … ${count} fields }`;
      lines.push({
        id: `d${docIdx}-${path}`,
        docIdx,
        kind: "line",
        foldKey,
        indent: depth,
        spans: [
          { text: "▸ ", color: T.dim },
          ...keyPrefix(key),
          { text: summary, color: T.dim },
          { text: comma, color: T.dim },
        ],
      });
      return;
    }

    lines.push({
      id: `d${docIdx}-${path}`,
      docIdx,
      kind: "line",
      foldKey,
      indent: depth,
      spans: [{ text: "▾ ", color: T.dim }, ...keyPrefix(key), { text: openCh, color: T.dim }],
    });

    if (isArr) {
      const arr = value as unknown[];
      arr.forEach((child, i) => emit(null, child, `${path}.${i}`, depth + 1, docIdx, i === arr.length - 1));
    } else {
      const entries = Object.entries(value as object);
      entries.forEach(([k, child], i) => emit(k, child, `${path}.${k}`, depth + 1, docIdx, i === entries.length - 1));
    }

    lines.push({
      id: `d${docIdx}-${path}-close`,
      docIdx,
      kind: "line",
      indent: depth,
      spans: [{ text: closeCh, color: T.dim }, { text: comma, color: T.dim }],
    });
  };

  docs.forEach((doc, docIdx) => {
    lines.push({
      id: `d${docIdx}-header`,
      docIdx,
      kind: "header",
      indent: 0,
      spans: [
        { text: `── ${docIdx + 1}/${docs.length} ─ _id: `, color: T.dim },
        { text: shortId(doc._id), color: T.dim },
        { text: " ──", color: T.dim },
      ],
    });
    const entries = Object.entries(doc);
    entries.forEach(([k, v], i) => emit(k, v, k, 1, docIdx, i === entries.length - 1));
  });

  return lines;
}
