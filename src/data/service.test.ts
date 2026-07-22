import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MongoClient as MongoClientType } from "mongodb";
import { BSON } from "./format.ts";
import { createMongoService, QUERY_DEFAULTS } from "./service.ts";
import { DEFAULT_QUERY_INPUT, type QueryInput } from "../shared/types.ts";

const URI = "mongodb://localhost:27017";
const DB = "mongotui_test";
const NS = { db: DB, coll: "items" };
let fixtureClient: MongoClientType;
const service = createMongoService(URI);

beforeAll(async () => {
  const mongodb = require("mongodb") as typeof import("mongodb");
  fixtureClient = new mongodb.MongoClient(URI, { serverSelectionTimeoutMS: 5_000 });
  try {
    await fixtureClient.connect();
  } catch (error) {
    throw new Error(`MongoDB fixture connection failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const db = fixtureClient.db(DB);
  await db.dropDatabase();
  await db.collection("items").insertMany([
    { _id: new BSON.ObjectId("507f1f77bcf86cd799439011"), rank: 1, group: "a", optional: true, nested: { score: 1 } },
    { rank: 2, group: "a", nested: { score: 2 } },
    { rank: 3, group: "b", nested: { score: 3 } },
    { rank: 4, group: "a", nested: { score: 4 } },
    { rank: 5, group: "b", nested: { score: 5 } },
  ]);
  await db.collection("other").insertOne({ _id: new BSON.ObjectId("607f1f77bcf86cd799439011"), label: "target" });
});

afterAll(async () => {
  await service.close();
  await fixtureClient.db(DB).dropDatabase();
  await fixtureClient.close();
});

function input(patch: Partial<QueryInput> = {}): QueryInput {
  return { ...DEFAULT_QUERY_INPUT, ...patch };
}

describe("query parsing", () => {
  test("validates shell BSON and rejects bad syntax and negative numbers", () => {
    expect(service.validateQuery(input({ filter: "{_id: ObjectId('507f1f77bcf86cd799439011'), d: ISODate('2020-01-01')}" })).filter.valid).toBe(true);
    expect(service.validateQuery(input({ filter: "{ broken" })).filter.valid).toBe(false);
    expect(service.validateQuery(input({ skip: "-1" })).skip).toEqual({ valid: false, error: "must be a non-negative integer" });
    expect(service.validateQuery(input({ hint: "rank_1" })).hint.valid).toBe(true);
    expect(service.validateQuery(input({ hint: "{ rank: 1 }" })).hint.valid).toBe(true);
  });

  test("uses application defaults", () => {
    expect(service.parseQuery(input())).toEqual(QUERY_DEFAULTS);
    expect(service.parseQuery(input({ limit: "4", maxTimeMS: "0" }))).toMatchObject({ limit: 4, maxTimeMS: 0 });
  });
});

describe("Mongo service integration", () => {
  test("pages with skip, limit, sort, projection, and detects a short final page", async () => {
    const query = service.parseQuery(input({ sort: "{ rank: 1 }", project: "{ rank: 1, _id: 0 }", skip: "1", limit: "4" }));
    const first = await service.runFind(NS, query, 0, 2);
    expect(first.docs).toEqual([{ rank: 2 }, { rank: 3 }]);
    expect(first.exactCount).toBeNull();
    const last = await service.runFind(NS, query, 2, 3);
    expect(last.docs).toEqual([{ rank: 4 }, { rank: 5 }]);
    expect(last.exactCount).toBeNull();
    const short = await service.runFind(NS, service.parseQuery(input({ sort: "{ rank: 1 }" })), 4, 3);
    expect(short.docs).toHaveLength(1);
    expect(short.exactCount).toBe(5);
  });

  test("counts exact filter matches", async () => {
    expect(await service.countExact(NS, service.parseQuery(input({ filter: "{ group: 'a' }" })))).toBe(3);
  });

  test("samples nested schema with probabilities", async () => {
    const schema = await service.sampleSchema(NS, 100);
    expect(schema.sampleSize).toBe(5);
    expect(schema.fields.find((field) => field.path === "nested.score")?.types).toContain("int32");
    expect(schema.fields.find((field) => field.path === "optional")?.probability).toBe(0.2);
  });

  test("summarizes COLLSCAN then IXSCAN", async () => {
    const query = service.parseQuery(input({ filter: "{ rank: { $gte: 2 } }" }));
    expect((await service.explain(NS, query)).plan).toBe("COLLSCAN");
    await fixtureClient.db(DB).collection("items").createIndex({ rank: 1 });
    expect((await service.explain(NS, query)).plan).toBe("IXSCAN (rank_1)");
  });

  test("finds string ObjectId references across collections", async () => {
    const found = await service.findByIdAcrossCollections(DB, "607f1f77bcf86cd799439011");
    expect(found?.coll).toBe("other");
    expect(found?.doc.label).toBe("target");
  });
});

