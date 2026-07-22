import { useTerminalDimensions } from "@opentui/react";
import { useStore } from "../state/store.ts";
import { T, themeNames, type Color } from "./theme.ts";
import { LineEditor } from "./LineEditor.tsx";
import { buildCommands, filterCommands, type Command } from "./commands.ts";
import {
  connCancelAdd,
  connConnectSelected,
  connDeleteSelected,
  connSelect,
  connStartAdd,
  connSubmitAdd,
  connTestSelected,
  displayUri,
  keepTheme,
  previewThemeAt,
  savedConnections,
} from "./actions.ts";

const HELP_GROUPS: { title: string; keys: [string, string][] }[] = [
  {
    title: "Global",
    keys: [
      [":", "command palette (or ⌃k / ⌃p)"],
      ["tab", "cycle pane focus"],
      ["1 / 2 / 3", "focus sidebar / query / results"],
      ["/", "focus query or sidebar filter"],
      ["esc", "back out one level"],
      ["? ", "this help"],
      ["R", "reload tree / page"],
      ["E", "explain query"],
      [", ", "theme picker"],
      ["C", "connections"],
      ["q", "quit"],
    ],
  },
  {
    title: "Tabs",
    keys: [
      ["o", "open collection in new tab"],
      ["T", "duplicate current tab"],
      ["X", "close current tab"],
      ["[ / ]", "prev / next tab"],
    ],
  },
  {
    title: "Sidebar",
    keys: [
      ["j / k", "move"],
      ["enter / l", "expand db / open collection"],
      ["h", "collapse"],
      ["g / G", "top / bottom"],
      ["/", "filter"],
    ],
  },
  {
    title: "Query",
    keys: [
      ["enter", "run find / pipeline"],
      ["tab / ▾", "show / cycle options"],
      ["A", "toggle find / aggregate"],
      ["esc", "back to filter / results"],
      ["↑ / ↓", "history recall"],
    ],
  },
  {
    title: "Results",
    keys: [
      ["j / k", "move"],
      ["enter", "open document"],
      ["v", "toggle view"],
      ["h / l", "prev / next page"],
      ["< / >", "scroll columns"],
    ],
  },
  {
    title: "Documents",
    keys: [
      ["space", "fold / unfold"],
      ["J / K", "next / prev doc"],
      ["g / G", "top / bottom"],
    ],
  },
  {
    title: "Editing",
    keys: [
      ["e", "edit selected"],
      ["c", "clone"],
      ["n", "new"],
      ["d", "delete"],
      ["y", "copy as EJSON"],
    ],
  },
];

function Overlay({ children, border }: { children: React.ReactNode; border: Color }): React.ReactNode {
  return (
    <box
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        justifyContent: "center",
        alignItems: "center",
        zIndex: 100,
      }}
    >
      <box
        border
        borderStyle="double"
        borderColor={border}
        style={{ padding: 1, minWidth: 44, backgroundColor: T.panel, flexDirection: "column" }}
      >
        {children}
      </box>
    </box>
  );
}

function HelpModal(): React.ReactNode {
  return (
    <Overlay border={T.focus}>
      <text><span fg={T.focus} attributes={1}>mongotui · keys</span></text>
      <box style={{ flexDirection: "row", gap: 3 }}>
        {[HELP_GROUPS.slice(0, 4), HELP_GROUPS.slice(4)].map((col, ci) => (
          <box key={ci} style={{ flexDirection: "column" }}>
            {col.map((group) => (
              <box key={group.title} style={{ flexDirection: "column" }}>
                <text><span fg={T.focus}>{group.title}</span></text>
                {group.keys.map(([k, d]) => (
                  <text key={k}>
                    <span fg={T.key}>{k.padEnd(12)}</span>
                    <span fg={T.dim}>{d}</span>
                  </text>
                ))}
              </box>
            ))}
          </box>
        ))}
      </box>
      <text><span fg={T.dim}>esc close</span></text>
    </Overlay>
  );
}

function ThemeModal(): React.ReactNode {
  const tm = useStore((s) => s.ui.themeModal);
  const themeName = useStore((s) => s.ui.themeName);
  if (!tm) return null;
  return (
    <Overlay border={T.accent}>
      <text><span fg={T.accent} attributes={1}>theme</span></text>
      {themeNames.map((name, i) => {
        const active = i === tm.sel;
        const applied = name === themeName;
        return (
          <box key={name} onMouseDown={() => (active ? keepTheme() : previewThemeAt(i))}>
            <text>
              <span fg={active ? T.accent : T.dim}>{active ? "▸ " : "  "}</span>
              <span fg={active ? T.text : T.dim}>{name.padEnd(14)}</span>
              <span fg={T.focus}>{applied ? "●" : " "}</span>
            </text>
          </box>
        );
      })}
      <text> </text>
      <box style={{ flexDirection: "row", gap: 2 }}>
        <text><span fg={T.dim}>j/k preview</span></text>
        <box onMouseDown={() => keepTheme()}><text><span fg={T.accent}>[ ⏎ keep ]</span></text></box>
        <text><span fg={T.dim}>esc revert</span></text>
      </box>
    </Overlay>
  );
}

function ConnModal(): React.ReactNode {
  const m = useStore((s) => s.ui.connModal);
  const conn = useStore((s) => s.conn);
  if (!m) return null;
  const list = savedConnections();

  if (m.adding) {
    return (
      <Overlay border={T.accent}>
        <text><span fg={T.accent} attributes={1}>add connection</span></text>
        <box style={{ flexDirection: "row" }}>
          <box style={{ width: 6 }}><text><span fg={m.formField === "name" ? T.text : T.dim}>Name</span></text></box>
          <box style={{ width: 42 }}>
            <LineEditor value={m.formName} cursor={m.formCursor} focused={m.formField === "name"} colorize={false} width={42} placeholder="local" />
          </box>
        </box>
        <box style={{ flexDirection: "row" }}>
          <box style={{ width: 6 }}><text><span fg={m.formField === "uri" ? T.text : T.dim}>URI</span></text></box>
          <box style={{ width: 42 }}>
            <LineEditor value={m.formUri} cursor={m.formCursor} focused={m.formField === "uri"} colorize={false} width={42} placeholder="localhost:27017" />
          </box>
        </box>
        {m.error ? <text><span fg={T.red}>{`✗ ${m.error}`}</span></text> : <text> </text>}
        <box style={{ flexDirection: "row", gap: 2 }}>
          <text><span fg={T.dim}>tab switch</span></text>
          <box onMouseDown={() => void connSubmitAdd()}><text><span fg={T.accent}>[ ⏎ connect ]</span></text></box>
          <text><span fg={T.dim}>esc back</span></text>
        </box>
      </Overlay>
    );
  }

  return (
    <Overlay border={T.accent}>
      <text><span fg={T.accent} attributes={1}>connections</span></text>
      {list.length === 0 ? (
        <text><span fg={T.dim}>no saved connections — press a to add one</span></text>
      ) : (
        list.map((c, i) => {
          const active = i === m.sel;
          const connected = c.name === conn.name;
          return (
            <box key={c.name} onMouseDown={() => (active ? void connConnectSelected() : connSelect(i))}>
              <text>
                <span fg={active ? T.accent : T.dim}>{active ? "▸ " : "  "}</span>
                <span fg={active ? T.text : T.dim}>{c.name.padEnd(14)}</span>
                <span fg={T.dim}>{displayUri(c.uri)}</span>
                <span fg={T.focus}>{connected ? "  ● connected" : ""}</span>
              </text>
            </box>
          );
        })
      )}
      <text> </text>
      <box style={{ flexDirection: "row", gap: 2 }}>
        <box onMouseDown={() => connStartAdd()}><text><span fg={T.accent}>[ a add ]</span></text></box>
        <box onMouseDown={() => void connConnectSelected()}><text><span fg={T.accent}>[ ⏎ connect ]</span></text></box>
        <box onMouseDown={() => void connTestSelected()}><text><span fg={T.focus}>[ t test ]</span></text></box>
        <box onMouseDown={() => connDeleteSelected()}><text><span fg={T.red}>[ D delete ]</span></text></box>
        <text><span fg={T.dim}>esc close</span></text>
      </box>
    </Overlay>
  );
}

const PALETTE_MAX = 12;
const PALETTE_NAME_W = 26;

function runPaletteCommand(cmd: Command): void {
  useStore.getState().setPaletteModal(null);
  void cmd.run();
}

function PaletteModal(): React.ReactNode {
  const p = useStore((s) => s.ui.paletteModal);
  // Re-render when the underlying state that shapes the command list changes.
  useStore((s) => s.ns);
  useStore((s) => s.results.docs.length);
  const dims = useTerminalDimensions();
  if (!p) return null;

  const results = filterCommands(buildCommands(useStore.getState()), p.query);
  const width = Math.min(72, dims.width - 8);
  const sel = Math.min(p.sel, Math.max(0, results.length - 1));
  const start = sel >= PALETTE_MAX ? sel - PALETTE_MAX + 1 : 0;
  const visible = results.slice(start, start + PALETTE_MAX);

  return (
    <box
      style={{
        position: "absolute", top: 0, left: 0, width: "100%", height: "100%",
        justifyContent: "center", alignItems: "center", zIndex: 100,
      }}
    >
      <box
        border
        borderStyle="rounded"
        borderColor={T.accent}
        style={{ width, backgroundColor: T.panel, flexDirection: "column" }}
      >
        <box style={{ height: 1, flexDirection: "row", paddingX: 1 }}>
          <text><span fg={T.accent}>{"> "}</span></text>
          <box style={{ flexGrow: 1 }}>
            <LineEditor value={p.query} cursor={p.cursor} focused colorize={false} width={width - 4} placeholder="type a command…" />
          </box>
        </box>
        {visible.length === 0 ? (
          <box style={{ height: 1, paddingX: 1 }}><text><span fg={T.dim}>no matching commands</span></text></box>
        ) : (
          visible.map((cmd, i) => {
            const selected = start + i === sel;
            return (
              <box
                key={cmd.id}
                onMouseDown={() => runPaletteCommand(cmd)}
                style={{ height: 1, flexDirection: "row", paddingX: 1, backgroundColor: selected ? T.selBg : undefined }}
              >
                <text><span fg={selected ? T.focus : T.dim}>{selected ? "▎" : " "}</span></text>
                <box style={{ width: PALETTE_NAME_W }}><text><span fg={T.text}>{cmd.name}</span></text></box>
                <box style={{ flexGrow: 1 }}><text><span fg={T.dim}>{cmd.description}</span></text></box>
                {cmd.hint ? <text><span fg={T.dim}>{cmd.hint}</span></text> : null}
              </box>
            );
          })
        )}
        <box style={{ height: 1, paddingX: 1 }}><text><span fg={T.dim}>↑↓ move · ⏎ run · esc close</span></text></box>
      </box>
    </box>
  );
}

export function Modals(): React.ReactNode {
  const modal = useStore((s) => s.ui.modal);
  const themeModal = useStore((s) => s.ui.themeModal);
  const connModal = useStore((s) => s.ui.connModal);
  const paletteModal = useStore((s) => s.ui.paletteModal);

  if (paletteModal) return <PaletteModal />;
  if (themeModal) return <ThemeModal />;
  if (connModal) return <ConnModal />;
  if (!modal) return null;

  if (modal.kind === "help") return <HelpModal />;

  const border = modal.kind === "error" ? T.red : T.focus;
  const footer =
    modal.kind === "error"
      ? modal.retry
        ? "e edit again · esc dismiss"
        : "esc dismiss"
      : "enter/y confirm · esc cancel";

  return (
    <Overlay border={border}>
      <text><span fg={modal.kind === "error" ? T.red : T.text} attributes={1}>{modal.title ?? ""}</span></text>
      {(modal.lines ?? []).map((line, i) => (
        <text key={i}><span fg={T.dim}>{line}</span></text>
      ))}
      <text> </text>
      <text><span fg={T.dim}>{footer}</span></text>
    </Overlay>
  );
}
