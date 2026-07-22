import { describe, expect, test } from "bun:test";
import { DEFAULT_QUERY_INPUT, type QueryInput } from "../shared/types.ts";
import { createMongoService } from "./service.ts";

const service = createMongoService("mongodb://localhost:27017");
const input = (patch: Partial<QueryInput>): QueryInput => ({ ...DEFAULT_QUERY_INPUT, ...patch });

describe("all query-field validators", () => {
  test("accept valid values for every field", () => {
    const result = service.validateQuery(input({
      filter: "{ rank: { $gte: 2 } }",
      project: "{ rank: 1, _id: 0 }",
      sort: "{ rank: -1 }",
      collation: "{ locale: 'en', strength: 2 }",
      hint: "rank_1",
      skip: "0",
      limit: "20",
      maxTimeMS: "1000",
    }));
    expect(Object.values(result).every(({ valid }) => valid)).toBe(true);
  });

  test("rejects invalid values for every field", () => {
    const cases: Partial<Record<keyof QueryInput, string>> = {
      filter: "{ nope",
      project: "[]",
      sort: "{ rank: 3 }",
      collation: "{ locale: 2 }",
      hint: "{ rank: 3 }",
      skip: "-1",
      limit: "1.5",
      maxTimeMS: "NaN",
    };
    for (const [field, value] of Object.entries(cases) as [keyof QueryInput, string][]) {
      expect(service.validateQuery(input({ [field]: value }))[field].valid).toBe(false);
    }
    expect(service.validateQuery(input({ filter: "{ nope" })).filter.error).toStartWith("unexpected token");
  });
});

