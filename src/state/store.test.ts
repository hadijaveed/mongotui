import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ConnectionInfo, MongoService, QueryInput, QueryValidation } from "../shared/types.ts";
import { initStore, teardownStore, useStore } from "./store.ts";

const FIELDS: (keyof QueryInput)[] = [
  "filter", "project", "sort", "collation", "hint", "skip", "limit", "maxTimeMS",
];

// Minimal stub: tab switching + snapshotting never hits the network, only
// validateQuery is needed to build fresh query slices.
const stub = {
  validateQuery(_input: QueryInput): QueryValidation {
    const v = {} as QueryValidation;
    for (const f of FIELDS) v[f] = { valid: true };
    return v;
  },
  async close() {},
} as unknown as MongoService;

const info: ConnectionInfo = { uri: "mongodb://stub", host: "stub", latencyMs: 0, ok: true };

beforeAll(() => {
  initStore(stub, info);
});

afterAll(() => {
  teardownStore();
});

describe("tab switching preserves per-tab state", () => {
  test("filter text, results, and view survive a switch away and back", () => {
    const s = () => useStore.getState();

    // Tab 0: type a filter, fake some results + docs view.
    useStore.setState((st) => ({ ns: { db: "mflix", coll: "movies" } }));
    s().setQueryField("filter", "{ year: { $gte: 2010 } }", 24);
    useStore.setState((st) => ({
      results: { ...st.results, docs: [{ _id: 1 }, { _id: 2 }], view: "docs", selRow: 1, aggregate: false },
    }));

    expect(s().query.input.filter).toBe("{ year: { $gte: 2010 } }");

    // Open a second, empty tab — live state becomes fresh.
    s().newEmptyTab();
    expect(s().tabs).toHaveLength(2);
    expect(s().activeTab).toBe(1);
    expect(s().ns).toBeNull();
    expect(s().query.input.filter).toBe(""); // fresh tab has no filter

    // The snapshot of tab 0 must retain the filter (the reported bug).
    expect(s().tabs[0]!.query.input.filter).toBe("{ year: { $gte: 2010 } }");

    // Switch back — everything restores exactly.
    s().switchTab(0);
    expect(s().activeTab).toBe(0);
    expect(s().ns).toEqual({ db: "mflix", coll: "movies" });
    expect(s().query.input.filter).toBe("{ year: { $gte: 2010 } }");
    expect(s().results.docs).toHaveLength(2);
    expect(s().results.view).toBe("docs");
    expect(s().results.selRow).toBe(1);
  });

  test("aggregate mode + pipeline text are part of the tab snapshot", () => {
    const s = () => useStore.getState();
    // Fresh baseline
    s().closeTab();
    s().closeTab();
    useStore.setState(() => ({ ns: { db: "mflix", coll: "movies" } }));
    s().toggleMode();
    expect(s().query.mode).toBe("aggregate");
    s().setPipeline("[ { $group: { _id: null } } ]", 10);

    s().newEmptyTab();
    expect(s().query.mode).toBe("find"); // fresh tab defaults to find
    expect(s().tabs[0]!.query.mode).toBe("aggregate");
    expect(s().tabs[0]!.query.pipeline).toBe("[ { $group: { _id: null } } ]");

    s().switchTab(0);
    expect(s().query.mode).toBe("aggregate");
    expect(s().query.pipeline).toBe("[ { $group: { _id: null } } ]");
  });
});
