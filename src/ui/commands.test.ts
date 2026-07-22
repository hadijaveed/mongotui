import { describe, expect, test } from "bun:test";
import type { StoreState } from "../state/store.ts";
import { buildCommands, filterCommands, fuzzyScore, type Command } from "./commands.ts";

// Minimal store snapshot: buildCommands only reads these fields at build time
// (run closures pull fresh state via useStore.getState(), never invoked here).
function fakeStore(over: {
  ns?: { db: string; coll: string } | null;
  docs?: number;
  aggregate?: boolean;
  mode?: "find" | "aggregate";
  tabs?: number;
  collectionsByDb?: Record<string, { name: string }[]>;
}): StoreState {
  return {
    ns: over.ns ?? null,
    results: { docs: new Array(over.docs ?? 0).fill({}), aggregate: over.aggregate ?? false },
    query: { mode: over.mode ?? "find" },
    tabs: new Array(over.tabs ?? 1).fill({}),
    tree: { collectionsByDb: over.collectionsByDb ?? {} },
  } as unknown as StoreState;
}

describe("fuzzyScore ranking", () => {
  test("prefix beats substring beats subsequence, no-match is null", () => {
    const prefix = fuzzyScore("connections", "conn");
    const substring = fuzzyScore("reload", "load");
    const subseq = fuzzyScore("documents view", "dcmnt");
    expect(prefix).toBe(3);
    expect(substring).toBe(2);
    expect(subseq).toBe(1);
    expect(prefix!).toBeGreaterThan(substring!);
    expect(substring!).toBeGreaterThan(subseq!);
    expect(fuzzyScore("help", "xyz")).toBeNull();
    expect(fuzzyScore("anything", "")).toBe(0);
  });

  test("filterCommands orders prefix > substring > subsequence, empty query keeps order", () => {
    const cmds: Command[] = [
      { id: "a", name: "table view", description: "", run: () => {} },       // subsequence of "tv"? no
      { id: "b", name: "toggle view", description: "", run: () => {} },
      { id: "c", name: "view results", description: "", run: () => {} },
    ];
    // "view": prefix on "view results"(3), substring on "table view"/"toggle view"(2)
    const ranked = filterCommands(cmds, "view");
    expect(ranked[0]!.id).toBe("c");
    expect(filterCommands(cmds, "").map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  test("name matches outrank description-only matches", () => {
    const cmds: Command[] = [
      { id: "desc", name: "reload", description: "open the theme picker", run: () => {} },
      { id: "name", name: "themes", description: "unrelated", run: () => {} },
    ];
    const ranked = filterCommands(cmds, "theme");
    expect(ranked[0]!.id).toBe("name");
    expect(ranked.map((c) => c.id)).toContain("desc");
  });
});

describe("buildCommands guards", () => {
  test("no document actions when results has no docs", () => {
    const ids = buildCommands(fakeStore({ ns: { db: "d", coll: "c" }, docs: 0 })).map((c) => c.id);
    expect(ids).not.toContain("doc.edit");
    expect(ids).not.toContain("doc.delete");
    expect(ids).not.toContain("doc.clone");
    expect(ids).not.toContain("doc.copy");
    expect(ids).not.toContain("view.detail");
    // new document is still available on an open collection
    expect(ids).toContain("doc.new");
  });

  test("document actions appear when docs are present and writable", () => {
    const ids = buildCommands(fakeStore({ ns: { db: "d", coll: "c" }, docs: 3 })).map((c) => c.id);
    expect(ids).toContain("doc.edit");
    expect(ids).toContain("doc.delete");
    expect(ids).toContain("doc.copy");
    expect(ids).toContain("view.detail");
  });

  test("aggregate results are read-only: no edit/delete, copy still allowed", () => {
    const ids = buildCommands(
      fakeStore({ ns: { db: "d", coll: "c" }, docs: 3, aggregate: true, mode: "aggregate" }),
    ).map((c) => c.id);
    expect(ids).not.toContain("doc.edit");
    expect(ids).not.toContain("doc.delete");
    expect(ids).toContain("doc.copy");
    expect(ids).not.toContain("query.explain"); // explain is find-mode only
  });

  test("dynamic collection jumps list current db first", () => {
    const cmds = buildCommands(
      fakeStore({
        ns: { db: "mflix", coll: "movies" },
        docs: 1,
        collectionsByDb: { admin: [{ name: "system" }], mflix: [{ name: "movies" }, { name: "users" }] },
      }),
    );
    const jumps = cmds.filter((c) => c.id.startsWith("jump."));
    expect(jumps.map((c) => c.name)).toEqual(["mflix.movies", "mflix.users", "admin.system"]);
    expect(jumps[0]!.description).toBe("open collection");
  });
});
