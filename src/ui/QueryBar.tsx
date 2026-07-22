import { useTerminalDimensions } from "@opentui/react";
import type { QueryField } from "../shared/types.ts";
import { useStore, type QueryMode, type StoreState } from "../state/store.ts";
import { T, type Color } from "./theme.ts";
import { LineEditor } from "./LineEditor.tsx";
import { currentToken, suggest, type Suggestion } from "./autocomplete.ts";

const RIGHT_W = 24;

/**
 * Always-visible mode toggle (`find · agg`) plus, in find mode, an `options`
 * button that reveals the Project / Sort / Collation / Hint / Skip / Limit /
 * MaxTimeMS rows — so those are discoverable without knowing the `tab` shortcut.
 */
function ModeControls({ mode, expanded }: { mode: QueryMode; expanded?: boolean }): React.ReactNode {
  return (
    <box style={{ flexGrow: 1, flexDirection: "row", justifyContent: "flex-end", alignItems: "center" }}>
      <box onMouseDown={(e) => { e.stopPropagation?.(); useStore.getState().toggleMode(); }}>
        <text>
          <span fg={mode === "find" ? T.focus : T.dim}>find</span>
          <span fg={T.dim}>{" · "}</span>
          <span fg={mode === "aggregate" ? T.focus : T.dim}>agg</span>
        </text>
      </box>
      {mode === "find" ? (
        <box onMouseDown={(e) => { e.stopPropagation?.(); const s = useStore.getState(); s.setFocus("query"); s.setExpanded(!expanded); }}>
          <text><span fg={expanded ? T.focus : T.dim}>{`  ${expanded ? "▴" : "▾"} options`}</span></text>
        </box>
      ) : null}
    </box>
  );
}

interface OptionField {
  field: QueryField;
  label: string;
  placeholder: string;
  colorize: boolean;
}

// Placeholders are prefixed so an empty row can never be mistaken for a set
// value: object fields show an `e.g.` example, scalars show their default.
const OPTION_FIELDS: OptionField[] = [
  { field: "project", label: "Project", placeholder: "e.g. { title: 1, year: 1 }", colorize: true },
  { field: "sort", label: "Sort", placeholder: "e.g. { year: -1 }", colorize: true },
  { field: "collation", label: "Collation", placeholder: "e.g. { locale: 'en', strength: 2 }", colorize: true },
  { field: "hint", label: "Hint", placeholder: `e.g. { year: 1 } or "index_name"`, colorize: true },
  { field: "skip", label: "Skip", placeholder: "default 0", colorize: false },
  { field: "limit", label: "Limit", placeholder: "default 50 (0 = no limit)", colorize: false },
  { field: "maxTimeMS", label: "MaxTimeMS", placeholder: "default 10000", colorize: false },
];

const LABEL_W = 11;

const PIPELINE_PLACEHOLDER = `[ { $match: { … } }, { $group: { _id: "$field", n: { $sum: 1 } } } ]`;

function PipelineBar({ focused }: { focused: boolean }): React.ReactNode {
  const query = useStore((s) => s.query);
  const dims = useTerminalDimensions();
  const inner = Math.max(20, dims.width - 30 - 4);

  const v = query.pipelineValidation;
  const borderColor = !v.valid ? T.red : focused ? T.focus : T.border;

  let title = "pipeline";
  let titleColor: Color = focused ? T.focus : T.dim;
  if (!v.valid) {
    title = `pipeline ✗ ${v.error ?? "invalid"}`;
    titleColor = T.red;
  } else if (query.pipeline.trim()) {
    title = "pipeline ✓";
    titleColor = T.focus;
  }

  const editorWidth = Math.max(20, inner - RIGHT_W);

  return (
    <box
      title={title}
      titleColor={titleColor}
      border
      borderStyle="rounded"
      borderColor={borderColor}
      focusedBorderColor={borderColor}
      focused={focused}
      style={{ flexDirection: "column", backgroundColor: T.panel, height: 3 }}
      onMouseDown={() => useStore.getState().setFocus("query")}
    >
      <box style={{ height: 1, flexDirection: "row" }}>
        <box style={{ width: editorWidth }}>
          <LineEditor
            value={query.pipeline}
            cursor={query.pipelineCursor}
            focused={focused}
            colorize
            width={editorWidth}
            placeholder={PIPELINE_PLACEHOLDER}
          />
        </box>
        <ModeControls mode="aggregate" />
      </box>
    </box>
  );
}

// ---- Autocomplete popup ----------------------------------------------------

interface ActiveAutocomplete {
  value: string;
  cursor: number;
  suggestions: Suggestion[];
  isOption: boolean;
  activeField: QueryField;
}

/** Compute the suggestions for whatever query field is currently active. */
export function queryAutocomplete(s: StoreState): ActiveAutocomplete {
  const q = s.query;
  if (q.mode === "aggregate") {
    // Aggregate mode has no per-collection field schema in scope → stages + ops.
    const { token } = currentToken(q.pipeline, q.pipelineCursor);
    return { value: q.pipeline, cursor: q.pipelineCursor, suggestions: suggest(token, [], "aggregate"), isOption: false, activeField: "filter" };
  }
  const field = q.activeField;
  const value = q.input[field];
  const fields = (s.results.schema?.fields ?? []).map((f) => f.path);
  const { token } = currentToken(value, q.cursor);
  return { value, cursor: q.cursor, suggestions: suggest(token, fields, "find"), isOption: field !== "filter", activeField: field };
}

/** The popup is shown iff the query pane is focused, has suggestions, and wasn't dismissed. */
export function suggestVisible(s: StoreState): boolean {
  if (s.ui.focusedPane !== "query") return false;
  if (s.query.suggestDismissed) return false;
  return queryAutocomplete(s).suggestions.length > 0;
}

const SIDEBAR_W = 30;
const POPUP_MAX_W = 48;

/**
 * Store-derived overlay (like the command palette) rendered at App level so the
 * bordered QueryBar box can't clip it. Absolutely positioned directly below the
 * active field row, near the token start column.
 */
export function Autocomplete(): React.ReactNode {
  const store = useStore();
  const dims = useTerminalDimensions();

  // Never draw over a modal / palette.
  if (store.ui.modal || store.ui.themeModal || store.ui.connModal || store.ui.paletteModal) return null;
  if (!suggestVisible(store)) return null;

  const ac = queryAutocomplete(store);
  const suggestions = ac.suggestions.slice(0, 8);
  const sel = Math.min(Math.max(0, store.query.suggestSel), suggestions.length - 1);

  const tabBarVisible = store.ns !== null || store.tabs.some((t, i) => i !== store.activeTab && t.ns !== null);
  const queryBarTop = 1 + (tabBarVisible ? 1 : 0);
  const innerRow = ac.isOption ? 1 + OPTION_FIELDS.findIndex((o) => o.field === ac.activeField) : 0;
  const top = queryBarTop + 1 /* top border */ + innerRow + 1 /* below the active row */;

  const innerW = Math.min(
    POPUP_MAX_W,
    Math.max(...suggestions.map((s) => 1 + s.text.length + 2 + s.hint.length)),
  );
  const boxW = innerW + 2;
  const editorX = SIDEBAR_W + 1 /* query border */ + (ac.isOption ? LABEL_W : 0);
  const { start } = currentToken(ac.value, ac.cursor);
  const left = Math.max(editorX, Math.min(editorX + start, dims.width - boxW - 1));

  return (
    <box
      border
      borderStyle="rounded"
      borderColor={T.border}
      style={{ position: "absolute", top, left, zIndex: 90, width: boxW, backgroundColor: T.panel, flexDirection: "column" }}
    >
      {suggestions.map((sug, i) => {
        const selected = i === sel;
        return (
          <box
            key={sug.text}
            style={{ height: 1, flexDirection: "row", width: innerW, backgroundColor: selected ? T.selBg : undefined }}
          >
            <text wrapMode="none">
              <span fg={selected ? T.focus : T.dim}>{selected ? "▎" : " "}</span>
              <span fg={T.text}>{sug.text}</span>
              <span fg={T.dim}>{`  ${sug.hint}`}</span>
            </text>
          </box>
        );
      })}
    </box>
  );
}

export function QueryBar({ focused }: { focused: boolean }): React.ReactNode {
  const query = useStore((s) => s.query);
  const dims = useTerminalDimensions();
  const inner = Math.max(20, dims.width - 30 - 4);

  if (query.mode === "aggregate") return <PipelineBar focused={focused} />;

  const fields = Object.keys(query.validation) as QueryField[];
  const firstInvalid = fields.find((f) => !query.validation[f].valid);
  const anyInvalid = firstInvalid !== undefined;
  const borderColor = anyInvalid ? T.red : focused ? T.focus : T.border;

  let title = "filter";
  let titleColor: Color = focused ? T.focus : T.dim;
  if (firstInvalid) {
    title = `${firstInvalid} ✗ ${query.validation[firstInvalid].error ?? "invalid"}`;
    titleColor = T.red;
  } else if (query.input.filter.trim()) {
    title = "filter ✓";
    titleColor = T.focus;
  }

  const filterActive = focused && query.activeField === "filter";
  const filterWidth = Math.max(20, inner - RIGHT_W);

  const activeErr =
    focused && query.expanded && !query.validation[query.activeField].valid
      ? query.validation[query.activeField].error
      : undefined;

  const clickField = (field: QueryField, expand: boolean): void => {
    const store = useStore.getState();
    store.setFocus("query");
    if (expand) store.setExpanded(true);
    store.setActiveField(field);
  };

  return (
    <box
      title={title}
      titleColor={titleColor}
      border
      borderStyle="rounded"
      borderColor={borderColor}
      focusedBorderColor={borderColor}
      focused={focused}
      style={{
        flexDirection: "column",
        backgroundColor: T.panel,
        height: 3 + (query.expanded ? OPTION_FIELDS.length : 0) + (activeErr ? 1 : 0),
      }}
    >
      <box style={{ height: 1, flexDirection: "row" }} onMouseDown={() => clickField("filter", false)}>
        <box style={{ width: filterWidth }}>
          <LineEditor
            value={query.input.filter}
            cursor={query.cursor}
            focused={filterActive}
            colorize
            width={filterWidth}
            placeholder="{ field: value }"
          />
        </box>
        <ModeControls mode="find" expanded={query.expanded} />
      </box>

      {query.expanded
        ? OPTION_FIELDS.map((opt) => {
            const active = focused && query.activeField === opt.field;
            const invalid = !query.validation[opt.field].valid;
            const isSet = query.input[opt.field].trim().length > 0;
            // Label color says at a glance which options are actually set:
            // accent = active, normal = has a value, dim = empty (placeholder).
            const labelFg = active ? T.focus : isSet ? T.text : T.dim;
            return (
              <box
                key={opt.field}
                style={{ height: 1, flexDirection: "row" }}
                onMouseDown={() => clickField(opt.field, true)}
              >
                <box style={{ width: LABEL_W }}>
                  <text><span fg={labelFg}>{isSet && !active ? `${opt.label} ●` : opt.label}</span></text>
                </box>
                <box style={{ flexGrow: 1 }}>
                  <LineEditor
                    value={query.input[opt.field]}
                    cursor={query.cursor}
                    focused={active}
                    colorize={opt.colorize}
                    width={inner - LABEL_W}
                    placeholder={opt.placeholder}
                    validity={query.validation[opt.field]}
                  />
                </box>
                {invalid ? <text><span fg={T.red}> ✗</span></text> : null}
              </box>
            );
          })
        : null}

      {activeErr ? (
        <box style={{ height: 1 }}>
          <text><span fg={T.red}>{`✗ ${activeErr}`}</span></text>
        </box>
      ) : null}
    </box>
  );
}
