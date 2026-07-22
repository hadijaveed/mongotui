import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import type { MongoService } from "../shared/types.ts";
import { createMongoService } from "../data/service.ts";
import { initStore, teardownStore, useStore } from "../state/store.ts";
import { App } from "./App.tsx";
import { sidebarRows } from "./Sidebar.tsx";
import { tokenizeQuery } from "./tokenize.ts";
import { T } from "./theme.ts";

const URI = process.env.MONGOTUI_URI ?? "mongodb://localhost:27017";
let service: MongoService;

beforeAll(async () => {
  Bun.spawnSync(["bun", "run", "scripts/seed.ts"], { env: { ...process.env, MONGOTUI_URI: URI } });
  service = createMongoService(URI);
  const info = await service.connect();
  initStore(service, info);
  await useStore.getState().loadDatabases();
});

afterAll(async () => {
  teardownStore();
  await service.close();
});

describe("mongotui ui", () => {
  it("tokenizes query text with key/operator/value colors", () => {
    const spans = tokenizeQuery(`{ year: { $gte: 2010 } }`);
    const text = spans.map((s) => s.text).join("");
    expect(text).toBe(`{ year: { $gte: 2010 } }`);
    expect(spans.find((s) => s.text === "year")?.color).toBe(T.key);
    expect(spans.find((s) => s.text === "$gte")?.color).toBe(T.op);
    expect(spans.find((s) => s.text === "2010")?.color).toBe(T.num);
  });

  it("renders the shell with databases and mflix", async () => {
    const t = await testRender(<App />, { width: 120, height: 36 });
    await t.waitFor(() => {
      const f = t.captureCharFrame();
      return f.includes("mongotui") && f.includes("databases") && f.includes("mflix");
    });
    expect(t.captureCharFrame()).toContain("mflix");
  });

  it("navigates into mflix.movies", async () => {
    const t = await testRender(<App />, { width: 120, height: 36 });
    await t.waitFor(() => sidebarRows(useStore.getState().tree).some((r) => r.db === "mflix"));

    const rows = sidebarRows(useStore.getState().tree);
    useStore.getState().sidebarTo(rows.findIndex((r) => r.type === "db" && r.db === "mflix"));
    await t.mockInput.pressKey("l"); // expand mflix
    await t.waitFor(() => Boolean(useStore.getState().tree.collectionsByDb.mflix));

    const rows2 = sidebarRows(useStore.getState().tree);
    useStore.getState().sidebarTo(rows2.findIndex((r) => r.type === "coll" && r.coll === "movies"));
    t.mockInput.pressEnter(); // open movies

    await t.waitFor(() => t.captureCharFrame().includes("movies ·"), { maxPasses: 200 });
    expect(useStore.getState().ns?.coll).toBe("movies");
  });

  it("runs a filter query and shows matches in a table", async () => {
    const t = await testRender(<App />, { width: 120, height: 36 });
    await t.waitFor(() => Boolean(useStore.getState().tree.collectionsByDb.mflix) || sidebarRows(useStore.getState().tree).some((r) => r.db === "mflix"));

    // ensure a collection is open
    await useStore.getState().openCollection({ db: "mflix", coll: "movies" });
    await t.waitFor(() => useStore.getState().results.docs.length > 0, { maxPasses: 200 });

    useStore.getState().setFocus("results");
    await t.mockInput.pressKey("/"); // focus query filter
    await t.waitFor(() => useStore.getState().ui.focusedPane === "query");

    await t.mockInput.typeText("{ year: { $gte: 2010 } }");
    t.mockInput.pressEnter();

    await t.waitFor(() => t.captureCharFrame().includes("matched"), { maxPasses: 200 });
    const frame = t.captureCharFrame();
    expect(frame).toContain("_id");
  });
});
