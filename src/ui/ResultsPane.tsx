import { useStore } from "../state/store.ts";
import { T } from "./theme.ts";
import { TableView } from "./TableView.tsx";
import { DocsView, DetailView } from "./DocsView.tsx";

function matchedText(exact: number | null, estimated: number | null): string {
  if (exact !== null) return `${exact} matched`;
  if (estimated !== null) return `~${estimated} matched`;
  return "? matched";
}

export function ResultsPane({ focused }: { focused: boolean }): React.ReactNode {
  const ns = useStore((s) => s.ns);
  const results = useStore((s) => s.results);

  if (!ns) {
    const bc = focused ? T.focus : T.border;
    return (
      <box
        title="results"
        titleColor={focused ? T.focus : T.dim}
        border
        borderStyle="rounded"
        borderColor={bc}
        focusedBorderColor={bc}
        focused={focused}
        style={{ flexGrow: 1, justifyContent: "center", alignItems: "center", backgroundColor: T.panel }}
      >
        <text><span fg={T.dim}>open a collection (enter in sidebar)</span></text>
      </box>
    );
  }

  const matched = matchedText(results.exactCount, results.estimatedTotal);
  const title = results.aggregate
    ? `${ns.coll} · aggregate · ${results.docs.length} docs · ${results.elapsedMs}ms${results.loading ? " · loading…" : ""}`
    : `${ns.coll} · ${matched} · ${results.elapsedMs}ms${results.loading ? " · loading…" : ""}`;

  const total = results.exactCount ?? results.estimatedTotal;
  const from = results.docs.length ? results.offset + 1 : 0;
  const to = results.offset + results.docs.length;
  const page = Math.floor(results.offset / results.pageSize) + 1;
  const pageInfo = results.aggregate
    ? `${results.docs.length} docs · single page`
    : total !== null
      ? `${from}–${to} of ${total} · page ${page}/${Math.max(1, Math.ceil(total / results.pageSize))}`
      : `${from}–${to} · page ${page}`;

  const bc = focused ? T.focus : T.border;
  return (
    <box
      title={title}
      titleColor={results.loading ? T.amber : focused ? T.focus : T.dim}
      border
      borderStyle="rounded"
      borderColor={bc}
      focusedBorderColor={bc}
      focused={focused}
      style={{ flexGrow: 1, flexDirection: "column", backgroundColor: T.panel }}
    >
      <box style={{ height: 1, flexDirection: "row" }}>
        <box onMouseDown={() => useStore.getState().setView("docs")}>
          <text><span fg={results.view === "docs" ? T.focus : T.dim}>[ Documents ]</span></text>
        </box>
        <text> </text>
        <box onMouseDown={() => useStore.getState().setView("table")}>
          <text><span fg={results.view === "table" ? T.focus : T.dim}>[ Table ]</span></text>
        </box>
        {results.view === "detail" ? (
          <text>
            <span> </span>
            <span fg={T.focus}>{`[ Doc ${results.selRow + 1}/${results.docs.length} ]`}</span>
          </text>
        ) : null}
        <box style={{ flexGrow: 1, alignItems: "flex-end" }}>
          <text>
            <span fg={T.dim}>
              {results.view === "detail" ? `J/K doc · esc back · ${pageInfo}` : pageInfo}
            </span>
          </text>
        </box>
      </box>
      {results.error ? (
        <text><span fg={T.red}>{results.error}</span></text>
      ) : results.view === "table" ? (
        <TableView />
      ) : results.view === "docs" ? (
        <DocsView />
      ) : (
        <DetailView />
      )}
    </box>
  );
}
