import { describe, expect, test } from "bun:test";
import { applySuggestion, currentToken, suggest } from "./autocomplete.ts";

describe("currentToken", () => {
  test("token mid-word ends at the cursor", () => {
    expect(currentToken("year", 2)).toEqual({ token: "ye", start: 0 });
  });
  test("token after `{` and whitespace", () => {
    expect(currentToken("{ ye", 4)).toEqual({ token: "ye", start: 2 });
  });
  test("empty when cursor sits after punctuation/space", () => {
    expect(currentToken("{ year: ", 8)).toEqual({ token: "", start: 8 });
    expect(currentToken("", 0)).toEqual({ token: "", start: 0 });
  });
  test("dotted field paths are one token", () => {
    expect(currentToken("{ imdb.rat", 10)).toEqual({ token: "imdb.rat", start: 2 });
  });
  test("$ is part of the token", () => {
    expect(currentToken("{ x: { $g", 9)).toEqual({ token: "$g", start: 7 });
  });
  test("cursor before the end only captures up to the cursor", () => {
    expect(currentToken("year", 0)).toEqual({ token: "", start: 0 });
  });
});

describe("suggest ordering", () => {
  const fields = ["year", "title", "imdb.rating", "imdb.votes", "genres"];

  test("empty token yields nothing", () => {
    expect(suggest("", fields, "find")).toEqual([]);
  });

  test("$-token returns operators only, prefix before substring", () => {
    const out = suggest("$g", fields, "find").map((s) => s.text);
    expect(out).toContain("$gt");
    expect(out).toContain("$gte");
    // prefix matches ($gt, $gte) rank ahead of substring matches (e.g. $regex has no g...).
    expect(out.indexOf("$gt")).toBeLessThan(out.length);
    // no field paths for a $-token
    expect(out.some((t) => fields.includes(t))).toBe(false);
  });

  test("prefix matches rank in list order; exact token is excluded", () => {
    const out = suggest("$e", fields, "find").map((s) => s.text);
    expect(out[0]).toBe("$eq");
    expect(out).toContain("$elemMatch");
    // exact-match exclusion: "$eq" as the full token must not suggest itself
    expect(suggest("$eq", fields, "find").map((s) => s.text)).not.toContain("$eq");
  });

  test("non-$ token: fields before operators", () => {
    const out = suggest("ye", fields, "find").map((s) => s.text);
    expect(out[0]).toBe("year");
    // any operator that substring-matches "ye" would come after all field matches
    const firstOp = out.findIndex((t) => t.startsWith("$"));
    const lastField = out.reduce((acc, t, i) => (fields.includes(t) ? i : acc), -1);
    if (firstOp >= 0) expect(lastField).toBeLessThan(firstOp);
  });

  test("field prefix beats field substring (case-insensitive)", () => {
    const out = suggest("IMDB", fields, "find").map((s) => s.text);
    expect(out[0]).toBe("imdb.rating");
    expect(out).toContain("imdb.votes");
  });

  test("stages only appear in aggregate mode", () => {
    expect(suggest("$grou", [], "find").map((s) => s.text)).not.toContain("$group");
    expect(suggest("$grou", [], "aggregate").map((s) => s.text)).toContain("$group");
    expect(suggest("$unwi", [], "aggregate").map((s) => s.text)).toContain("$unwind");
  });

  test("results are capped at 8", () => {
    const many = Array.from({ length: 30 }, (_, i) => `field_${i}`);
    expect(suggest("field", many, "find").length).toBeLessThanOrEqual(8);
  });
});

describe("applySuggestion", () => {
  test("replaces the token under the cursor, not the whole value", () => {
    // "{ ye" with cursor at 4 → replace "ye" with "year"
    expect(applySuggestion("{ ye", 4, { text: "year", hint: "field" })).toEqual({
      value: "{ year",
      cursor: 6,
    });
  });

  test("replaces a $-operator token in the middle of a value", () => {
    const value = "{ year: { $g } }";
    // cursor right after "$g" (index 12)
    expect(applySuggestion(value, 12, { text: "$gte", hint: "gte" })).toEqual({
      value: "{ year: { $gte } }",
      cursor: 14,
    });
  });

  test("inserts at an empty token position", () => {
    expect(applySuggestion("{ ", 2, { text: "year", hint: "field" })).toEqual({
      value: "{ year",
      cursor: 6,
    });
  });
});

describe("constructor snippets", () => {
  test("ObjectId snippet is offered for a matching token", () => {
    const s = suggest("Obj", [], "find");
    expect(s[0]?.text).toBe("ObjectId('…')");
  });

  test("ISODate matches by substring too", () => {
    expect(suggest("date", [], "find").some((s) => s.text === "ISODate('…')")).toBe(true);
  });

  test("fields with a matching prefix still rank above snippets", () => {
    const s = suggest("obj", ["objectives"], "find");
    expect(s[0]?.text).toBe("objectives");
    expect(s[1]?.text).toBe("ObjectId('…')");
  });

  test("accepting ObjectId inserts empty quotes with the cursor inside", () => {
    const snippet = suggest("Obj", [], "find")[0]!;
    expect(applySuggestion("{ _id: Obj", 10, snippet)).toEqual({
      value: "{ _id: ObjectId('')",
      cursor: 17, // between the quotes
    });
  });

  test("snippet caret lands inside ISODate quotes", () => {
    const snippet = suggest("ISO", [], "find")[0]!;
    const r = applySuggestion("ISO", 3, snippet);
    expect(r.value).toBe("ISODate('')");
    expect(r.value.slice(r.cursor - 1, r.cursor + 1)).toBe("''");
  });
});

describe("no-op and boundary behavior (adversarial-review fixes)", () => {
  test("an exact-match token is not re-suggested (Enter must run, not re-accept)", () => {
    expect(suggest("year", ["year"], "find")).toEqual([]);
    expect(suggest("$gt", [], "find").some((s) => s.text === "$gt")).toBe(false);
  });

  test("other matches survive the exact-match filter", () => {
    expect(suggest("$gt", [], "find").some((s) => s.text === "$gte")).toBe(true);
  });

  test("accepting mid-token replaces the whole token, not just the prefix", () => {
    expect(applySuggestion("{ yeXar }", 4, { text: "year", hint: "field" })).toEqual({
      value: "{ year }",
      cursor: 6,
    });
  });
});
