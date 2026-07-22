import { useTerminalDimensions } from "@opentui/react";
import type { QueryField } from "../shared/types.ts";
import { useStore, type QueryMode } from "../state/store.ts";
import { T, type Color } from "./theme.ts";
import { LineEditor } from "./LineEditor.tsx";

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

const OPTION_FIELDS: OptionField[] = [
  { field: "project", label: "Project", placeholder: "{ field: 0 }", colorize: true },
  { field: "sort", label: "Sort", placeholder: "{ field: -1 }", colorize: true },
  { field: "collation", label: "Collation", placeholder: "{ locale: 'simple' }", colorize: true },
  { field: "hint", label: "Hint", placeholder: `{ field: -1 } or "indexName"`, colorize: true },
  { field: "skip", label: "Skip", placeholder: "0", colorize: false },
  { field: "limit", label: "Limit", placeholder: "50", colorize: false },
  { field: "maxTimeMS", label: "MaxTimeMS", placeholder: "10000", colorize: false },
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
            return (
              <box
                key={opt.field}
                style={{ height: 1, flexDirection: "row" }}
                onMouseDown={() => clickField(opt.field, true)}
              >
                <box style={{ width: LABEL_W }}>
                  <text><span fg={active ? T.text : T.dim}>{opt.label}</span></text>
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
