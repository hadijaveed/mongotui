import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MongoClient as MongoClientType } from "mongodb";
import { BSON } from "./format.ts";
import { createMongoService } from "./service.ts";
import { parsePipeline, validatePipelineText } from "./aggregate.ts";

const URI = process.env.MONGOTUI_URI ?? "mongodb://localhost:27017";
const DB = "mongotui_agg_test";
const NS = { db: DB, coll: "items" };
let fixtureClient: MongoClientType;
const service = createMongoService(URI);

beforeAll(async () => {
  const mongodb = require("mongodb") as typeof import("mongodb");
  fixtureClient = new mongodb.MongoClient(URI, { serverSelectionTimeoutMS: 5_000 });
  await fixtureClient.connect();
  const db = fixtureClient.db(DB);
  await db.dropDatabase();
  await db.collection("items").insertMany([
    { group: "a", n: 1 },
    { group: "a", n: 2 },
    { group: "b", n: 3 },
    { group: "b", n: 4 },
    { group: "c", n: 5 },
  ]);
});

afterAll(async () => {
  await service.close();
  await fixtureClient.db(DB).dropDatabase();
  await fixtureClient.close();
});

describe("parsePipeline", () => {
  test("parses shell types like ObjectId inside a stage", () => {
    const stages = parsePipeline(`[ { $match: { _id: ObjectId("507f1f77bcf86cd799439011") } } ]`);
    expect(stages).toHaveLength(1);
    expect(BSON.EJSON.stringify(stages[0]!)).toContain("$oid");
  });

  test("parses multiple stages", () => {
    const stages = parsePipeline(`[ { $match: { group: "a" } }, { $group: { _id: "$group", n: { $sum: 1 } } } ]`);
    expect(stages).toHaveLength(2);
    expect(Object.keys(stages[0]!)).toEqual(["$match"]);
    expect(Object.keys(stages[1]!)).toEqual(["$group"]);
  });

  test("rejects a non-array pipeline", () => {
    expect(() => parsePipeline(`{ $match: {} }`)).toThrow("must be an array of stages");
    expect(() => parsePipeline(`[]`)).toThrow("must be an array of stages");
  });

  test("rejects a stage with two keys", () => {
    expect(() => parsePipeline(`[ { $match: {}, $group: {} } ]`)).toThrow(/single \$stage key/);
  });

  test("rejects a stage without a $-prefixed key", () => {
    expect(() => parsePipeline(`[ { match: {} } ]`)).toThrow(/single \$stage key/);
  });

  test("validatePipelineText: empty is valid, garbage is not", () => {
    expect(validatePipelineText("")).toEqual({ valid: true });
    expect(validatePipelineText("   ")).toEqual({ valid: true });
    expect(validatePipelineText(`[ { $match: {} } ]`).valid).toBe(true);
    expect(validatePipelineText(`[ { $out: "x" } ]`).valid).toBe(true); // structurally valid; rejected at run time
    expect(validatePipelineText(`{ not: "array" }`).valid).toBe(false);
  });
});

describe("runAggregate", () => {
  test("runs $match + $group against the test db", async () => {
    const stages = parsePipeline(`[ { $group: { _id: "$group", total: { $sum: "$n" } } }, { $sort: { _id: 1 } } ]`);
    const { docs } = await service.runAggregate(NS, stages, 10_000);
    expect(docs).toEqual([
      { _id: "a", total: 3 },
      { _id: "b", total: 7 },
      { _id: "c", total: 5 },
    ]);
  });

  test("rejects $out and $merge", async () => {
    await expect(service.runAggregate(NS, [{ $out: "dump" }], 10_000)).rejects.toThrow(/read-only/);
    await expect(service.runAggregate(NS, [{ $merge: { into: "dump" } }], 10_000)).rejects.toThrow(/read-only/);
  });

  test("appends { $limit: 500 } when no $limit stage is present", async () => {
    const many = Array.from({ length: 600 }, (_, i) => ({ k: i }));
    await fixtureClient.db(DB).collection("big").deleteMany({});
    await fixtureClient.db(DB).collection("big").insertMany(many);
    const { docs } = await service.runAggregate({ db: DB, coll: "big" }, [{ $match: {} }], 10_000);
    expect(docs).toHaveLength(500);
  });

  test("respects an explicit $limit stage", async () => {
    const { docs } = await service.runAggregate({ db: DB, coll: "big" }, [{ $match: {} }, { $limit: 7 }], 10_000);
    expect(docs).toHaveLength(7);
  });
});
