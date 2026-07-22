import { useEffect, useMemo, useRef } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useStore } from "../state/store.ts";
import { T } from "./theme.ts";
import { Spans } from "./valueSpans.tsx";
import { docsBodyLines, flattenDocs, shortDocId, type DocLine } from "./docsModel.ts";

const UNDERLINE = 4;

/** Documents view: one bordered Compass-style card per document. */
export function DocsView(): React.ReactNode {
  const results = useStore((s) => s.results);
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);

  const lines = useMemo(
    () => docsBodyLines(results.docs, results.foldedPaths),
    [results.docs, results.foldedPaths],
  );
  const sel = Math.min(results.docsLine, Math.max(0, lines.length - 1));
  const selDoc = lines[sel]?.docIdx ?? -1;

  // Group body lines into cards, keeping each line's global index for cursor + scroll.
  const cards = useMemo(() => {
    const out: { docIdx: number; items: { line: DocLine; index: number }[] }[] = [];
    lines.forEach((line, index) => {
      const last = out[out.length - 1];
      if (last && last.docIdx === line.docIdx) last.items.push({ line, index });
      else out.push({ docIdx: line.docIdx, items: [{ line, index }] });
    });
    return out;
  }, [lines]);

  useEffect(() => {
    scrollRef.current?.scrollChildIntoView(`dl-${sel}`);
  }, [sel]);

  const onLineClick = (i: number): void => {
    const store = useStore.getState();
    store.setFocus("results");
    store.setDocsLine(i);
    const line = lines[i];
    if (line) {
      store.setSelRow(line.docIdx);
      if (line.foldKey) store.toggleFold(line.foldKey);
    }
  };

  const onCardClick = (docIdx: number): void => {
    const store = useStore.getState();
    store.setFocus("results");
    store.setSelRow(docIdx);
    store.openDetail(docIdx);
  };

  if (results.docs.length === 0 && !results.loading) {
    return (
      <scrollbox ref={scrollRef} focusable={false} style={{ flexGrow: 1 }}>
        <text><span fg={T.dim}>no documents</span></text>
      </scrollbox>
    );
  }

  return (
    // viewportCulling must stay OFF: culled (off-screen) line boxes have no laid-out
    // position, so scrollChildIntoView(`dl-…`) can't follow the cursor into a card
    // below the fold. A page is capped at 50 docs, so rendering them all is cheap.
    <scrollbox ref={scrollRef} focusable={false} viewportCulling={false} style={{ flexGrow: 1 }}>
      {cards.map((card) => {
        const doc = results.docs[card.docIdx]!;
        const active = card.docIdx === selDoc;
        const title = `${card.docIdx + 1}/${results.docs.length} · _id: ${shortDocId(doc._id)}`;
        return (
          <box
            key={card.docIdx}
            id={`dc-${card.docIdx}`}
            title={title}
            titleColor={active ? T.focus : T.dim}
            border
            borderStyle="rounded"
            borderColor={active ? T.focus : T.border}
            onMouseDown={() => onCardClick(card.docIdx)}
            style={{ flexDirection: "column", backgroundColor: T.panel, marginBottom: 1 }}
          >
            {card.items.map(({ line, index }) => (
              <box
                key={line.id}
                id={`dl-${index}`}
                onMouseDown={(e) => {
                  e.stopPropagation?.();
                  onLineClick(index);
                }}
                style={{ height: 1, flexDirection: "row", backgroundColor: index === sel ? T.selBg : undefined }}
              >
                <text>
                  <span>{"  ".repeat(line.indent)}</span>
                  <Spans spans={line.spans} />
                </text>
              </box>
            ))}
          </box>
        );
      })}
    </scrollbox>
  );
}

/** Single-document view opened with Enter: near-fully expanded, J/K to move between docs. */
export function DetailView(): React.ReactNode {
  const results = useStore((s) => s.results);
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);

  const doc = results.docs[results.selRow];
  const lines = useMemo(
    () => (doc ? flattenDocs([doc], results.detailFolds).filter((l) => l.kind !== "header") : []),
    [doc, results.detailFolds],
  );
  const sel = Math.min(results.detailLine, Math.max(0, lines.length - 1));

  useEffect(() => {
    scrollRef.current?.scrollChildIntoView(`dt-${sel}`);
  }, [sel]);

  if (!doc) {
    return <text><span fg={T.dim}>no document</span></text>;
  }

  const onLineClick = (i: number): void => {
    const store = useStore.getState();
    store.setFocus("results");
    store.setDetailLine(i);
    const line = lines[i];
    if (line?.foldKey) store.toggleDetailFold(line.foldKey);
  };

  return (
    <scrollbox ref={scrollRef} focusable={false} viewportCulling={false} style={{ flexGrow: 1 }}>
      {lines.map((line, i) => (
        <box
          key={line.id}
          id={`dt-${i}`}
          onMouseDown={() => onLineClick(i)}
          style={{ height: 1, flexDirection: "row", backgroundColor: i === sel ? T.selBg : undefined }}
        >
          <text>
            <span>{"  ".repeat(line.indent)}</span>
            <Spans spans={line.spans} />
          </text>
        </box>
      ))}
    </scrollbox>
  );
}
