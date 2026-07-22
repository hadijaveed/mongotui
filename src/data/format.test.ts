import { describe, expect, test } from "bun:test";
import { computeDiff, describeDiff } from "./diff.ts";
import { BSON, bsonTypeName, cellText, docToEditable, parseEditedDoc, sanitizeLabel } from "./format.ts";

describe("format and edit diff", () => {
  test("editor shell syntax round-trips BSON values and nesting", () => {
    const doc = {
      _id: new BSON.ObjectId("507f1f77bcf86cd799439011"),
      released: new Date("2020-01-02T03:04:05.000Z"),
      nested: { score: 8.7 },
    };
    const parsed = parseEditedDoc(docToEditable(doc));
    expect((parsed._id as InstanceType<typeof BSON.ObjectId>).equals(doc._id)).toBe(true);
    expect((parsed.released as Date).getTime()).toBe(doc.released.getTime());
    expect(parsed.nested).toEqual(doc.nested);
  });

  test("type names and compact cells", () => {
    expect(bsonTypeName(new BSON.ObjectId())).toBe("objectId");
    expect(bsonTypeName(new BSON.Long(4))).toBe("long");
    expect(bsonTypeName([1])).toBe("array");
    expect(cellText(new BSON.ObjectId("507f1f77bcf86cd799439011"), 20)).toBe("507f1f…439011");
    expect(cellText("a very long value", 8)).toBe("a very …");
  });

  test("diffs nested leaves, additions, removals, arrays, dates, and ignores _id", () => {
    const id = new BSON.ObjectId("507f1f77bcf86cd799439011");
    const diff = computeDiff(
      { _id: id, imdb: { rating: 8, votes: 10 }, tags: ["a"], released: new Date(0), gone: 1 },
      { _id: new BSON.ObjectId(), imdb: { rating: 8.7, votes: 10, rank: 2 }, tags: ["b"], released: new Date(1) },
    );
    expect(diff.set).toEqual({
      "imdb.rating": 8.7,
      "imdb.rank": 2,
      tags: ["b"],
      released: new Date(1),
    });
    expect(diff.unset).toEqual(["gone"]);
    expect(Object.keys(computeDiff({ _id: id }, { _id: new BSON.ObjectId(id.toHexString()) }).set)).toHaveLength(0);
    expect(describeDiff(diff)).toContain("set  imdb.rating = 8.7");
  });
});

describe("sanitizeLabel", () => {
  test("strips carriage returns / newlines that blank a terminal row", () => {
    expect(sanitizeLabel("patient\rcareprograms")).toBe("patientcareprograms");
    expect(sanitizeLabel("surveys\n")).toBe("surveys");
  });
  test("strips other control chars and collapses whitespace", () => {
    expect(sanitizeLabel("a\u0000b\tc  d")).toBe("abc d");
  });
  test("trims and truncates", () => {
    expect(sanitizeLabel("  spaced  ")).toBe("spaced");
    expect(sanitizeLabel("x".repeat(50), 10).length).toBeLessThanOrEqual(10);
  });
  test("an all-control-char name collapses to empty (caller can skip it)", () => {
    expect(sanitizeLabel("\r\n\u0001")).toBe("");
  });
});
