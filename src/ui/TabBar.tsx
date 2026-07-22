import { useStore } from "../state/store.ts";
import { T } from "./theme.ts";

const UNDERLINE = 4; // TextAttributes.UNDERLINE

/** Height-1 row of open tabs. Visible whenever ≥1 tab has an open collection. */
export function TabBar(): React.ReactNode {
  const tabs = useStore((s) => s.tabs);
  const activeTab = useStore((s) => s.activeTab);
  const ns = useStore((s) => s.ns);

  const anyNs = ns !== null || tabs.some((t, i) => i !== activeTab && t.ns !== null);
  if (!anyNs) return null;

  const labelOf = (t: (typeof tabs)[number], i: number): string =>
    i === activeTab ? (ns?.coll ?? "—") : t.ns ? t.label : "—";

  return (
    <box style={{ height: 1, flexDirection: "row", paddingX: 1, backgroundColor: T.bg }}>
      {tabs.map((t, i) => {
        const active = i === activeTab;
        return (
          <box key={t.id} style={{ flexDirection: "row" }}>
            <box onMouseDown={() => useStore.getState().switchTab(i)}>
              <text>
                <span
                  fg={active ? T.accent : T.dim}
                  bg={active ? T.selBg : undefined}
                  attributes={active ? UNDERLINE : 0}
                >
                  {` ${i + 1}:${labelOf(t, i)} `}
                </span>
              </text>
            </box>
            {active ? (
              <box onMouseDown={() => useStore.getState().closeTab()}>
                <text><span fg={T.dim} bg={T.selBg}>{"×  "}</span></text>
              </box>
            ) : (
              <text><span> </span></text>
            )}
          </box>
        );
      })}
      <box onMouseDown={() => useStore.getState().newEmptyTab()}>
        <text><span fg={T.focus}>{"[ + ]"}</span></text>
      </box>
      {tabs.length === 1 ? (
        <box style={{ flexGrow: 1, alignItems: "flex-end" }}>
          <text><span fg={T.dim}>[o] new tab from sidebar</span></text>
        </box>
      ) : null}
    </box>
  );
}
