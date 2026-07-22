import { describe, expect, test } from "bun:test";
import { computeDiff, describeDiff } from "./diff.ts";
import { BSON } from "./format.ts";

const oid = (hex: string) => new BSON.ObjectId(hex);

describe("computeDiff", () => {
  test("identical documents produce an empty diff", () => {
    const doc = { a: 1, nested: { b: "x" }, when: new Date(1000) };
    expect(computeDiff(doc, structuredClone(doc))).toEqual({ set: {}, unset: [] });
  });

  test("changed nested leaf sets the deep path only", () => {
    const diff = computeDiff(
      { imdb: { rating: 8.6, votes: 100 } },
      { imdb: { rating: 8.7, votes: 100 } },
    );
    expect(diff).toEqual({ set: { "imdb.rating": 8.7 }, unset: [] });
  });

  test("removing a whole subdocument unsets the parent path, not its leaves", () => {
    const diff = computeDiff(
      { title: "x", tomatoes: { viewer: { rating: 3 }, critic: { rating: 4 } } },
      { title: "x" },
    );
    expect(diff).toEqual({ set: {}, unset: ["tomatoes"] });
  });

  test("adding a nested object sets it whole at its path", () => {
    const diff = computeDiff({ a: 1 }, { a: 1, meta: { source: "web", n: 2 } });
    expect(diff).toEqual({ set: { meta: { source: "web", n: 2 } }, unset: [] });
  });

  test("any array change replaces the whole array", () => {
    const diff = computeDiff(
      { genres: ["Drama", "Music"], keep: [1, 2] },
      { genres: ["Drama"], keep: [1, 2] },
    );
    expect(diff).toEqual({ set: { genres: ["Drama"] }, unset: [] });
  });

  test("equal ObjectId and Date values are not diffed; changed ones are", () => {
    const a = oid("507f1f77bcf86cd799439011");
    const same = { ref: oid("507f1f77bcf86cd799439011"), when: new Date(5000) };
    expect(computeDiff({ ref: a, when: new Date(5000) }, same)).toEqual({ set: {}, unset: [] });

    const changed = computeDiff(
      { ref: a, when: new Date(5000) },
      { ref: oid("607f1f77bcf86cd799439011"), when: new Date(6000) },
    );
    expect(Object.keys(changed.set).sort()).toEqual(["ref", "when"]);
  });

  test("_id is never part of the diff", () => {
    const diff = computeDiff(
      { _id: oid("507f1f77bcf86cd799439011"), a: 1 },
      { _id: oid("607f1f77bcf86cd799439011"), a: 2 },
    );
    expect(diff).toEqual({ set: { a: 2 }, unset: [] });
  });

  test("scalar to object and object to scalar replace at the path", () => {
    expect(computeDiff({ v: 1 }, { v: { n: 1 } })).toEqual({ set: { v: { n: 1 } }, unset: [] });
    expect(computeDiff({ v: { n: 1 } }, { v: 1 })).toEqual({ set: { v: 1 }, unset: [] });
  });

  test("describeDiff renders one readable line per operation", () => {
    const lines = describeDiff({ set: { "imdb.rating": 8.7 }, unset: ["tomatoes"] });
    expect(lines).toEqual(["set  imdb.rating = 8.7", "unset tomatoes"]);
  });
});
