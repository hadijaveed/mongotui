/**
 * End-to-end multi-connection coverage (requires a live MongoDB on localhost:27017).
 *
 * Exercises the full "manage several saved connections" path that ships in the
 * connections modal: ping-test each one, connect/switch between them, switch back,
 * and reject an unreachable URI without corrupting state. Also locks the
 * "nested documents are collapsed by default" guarantee at the store level.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { MongoClient as MongoClientType } from "mongodb";
import { createMongoService } from "../data/service.ts";
import { initStore, teardownStore, useStore } from "./store.ts";
import { saveConfig } from "../config.ts";
import { connConnectSelected, connTestSelected } from "../ui/actions.ts";

const URI_A = "mongodb://localhost:27017";
const URI_B = "mongodb://127.0.0.1:27017"; // same server, different host string → genuinely two connections
const DB = "mongotui_conn_test";
const NS = { db: DB, coll: "docs" };
let fixtureClient: MongoClientType;

const s = () => useStore.getState();
const openConn = (sel: number) =>
  s().setConnModal({ sel, adding: false, formField: "name", formName: "", formUri: "", formCursor: 0, error: null });

beforeAll(async () => {
  // Isolate config so we never read or clobber the real user config.
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "mongotui-cfg-"));

  const mongodb = require("mongodb") as typeof import("mongodb");
  fixtureClient = new mongodb.MongoClient(URI_A, { serverSelectionTimeoutMS: 5_000 });
  try {
    await fixtureClient.connect();
  } catch (error) {
    throw new Error(`MongoDB fixture connection failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const db = fixtureClient.db(DB);
  await db.dropDatabase();
  await db.collection<{ _id: number; name: string; nested: unknown }>("docs").insertMany([
    { _id: 1, name: "a", nested: { deep: { score: 1 }, tags: ["x", "y"] } },
    { _id: 2, name: "b", nested: { deep: { score: 2 }, tags: ["z"] } },
  ]);

  saveConfig({ connections: [{ name: "local", uri: URI_A }, { name: "loopback", uri: URI_B }] });

  const service = createMongoService(URI_A);
  const info = await service.connect();
  initStore(service, info, "local");
  await s().loadDatabases();
});

afterAll(async () => {
  teardownStore();
  await fixtureClient.close();
});

describe("nested documents are collapsed by default", () => {
  test("opening a collection loads with nested containers folded", async () => {
    await s().openCollection(NS);
    const folds = s().results.foldedPaths;
    expect(folds.size).toBeGreaterThan(0); // at least the `nested` objects/arrays are folded
    // every folded key is doc-scoped `${idx}:${path}` — prove a nested path is folded, not just top level
    const keys = [...folds];
    expect(keys.some((k) => k.includes("nested"))).toBe(true);
  });
});

describe("multiple saved connections", () => {
  test("both saved connections ping as reachable", async () => {
    openConn(0);
    await connTestSelected();
    expect(s().ui.toast?.text).toContain("reachable");

    openConn(1);
    await connTestSelected();
    expect(s().ui.toast?.text).toContain("reachable");
  });

  test("connecting to the selected connection switches the active session", async () => {
    openConn(1); // "loopback"
    await connConnectSelected();
    expect(s().conn.name).toBe("loopback");
    expect(s().ui.connModal).toBeNull(); // modal closes on connect
    expect(s().ns).toBeNull(); // namespace reset for the new connection
    expect(s().tabs).toHaveLength(1); // tabs reset to a single fresh tab
  });

  test("switching back to the first connection works", async () => {
    await s().switchConnection("local", URI_A);
    expect(s().conn.name).toBe("local");
    expect(s().conn.ok).toBe(true);
  });

  // The service pins serverSelectionTimeoutMS to 5s, so a refused connect takes ~5s.
  test("an unreachable connection is rejected without corrupting state", async () => {
    await s().switchConnection("dead", "mongodb://localhost:1");
    expect(s().conn.name).toBe("local"); // unchanged — we stayed on the good one
    expect(s().ui.toast?.text).toBeTruthy(); // an error toast was shown
  }, 15_000);
});
