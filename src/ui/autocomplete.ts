/**
 * Pure autocomplete logic for the query editors: a curated list of MongoDB
 * `$operators` plus the current collection's sampled field paths. No opentui,
 * no store — everything here is a pure function so it is trivially testable.
 */

export interface Suggestion {
  text: string;
  hint: string;
  /** Text actually inserted (defaults to `text`) — lets snippets display `ObjectId('…')` but insert `ObjectId('')`. */
  insert?: string;
  /** Cursor offset within `insert` after accepting (defaults to end) — e.g. inside the quotes. */
  caret?: number;
}

/** Constructor snippets: accepted with the cursor placed INSIDE the quotes. */
export const SNIPPETS: Suggestion[] = [
  { text: "ObjectId('…')", insert: "ObjectId('')", caret: 10, hint: "match by id" },
  { text: "ISODate('…')", insert: "ISODate('')", caret: 9, hint: "date value" },
];

/** Query operators offered in both find and aggregate mode. `$where` is excluded. */
export const FIND_OPERATORS: Suggestion[] = [
  { text: "$eq", hint: "equals" },
  { text: "$ne", hint: "not equal" },
  { text: "$gt", hint: "greater than" },
  { text: "$gte", hint: "greater than or equal" },
  { text: "$lt", hint: "less than" },
  { text: "$lte", hint: "less than or equal" },
  { text: "$in", hint: "in array" },
  { text: "$nin", hint: "not in array" },
  { text: "$and", hint: "logical and" },
  { text: "$or", hint: "logical or" },
  { text: "$nor", hint: "logical nor" },
  { text: "$not", hint: "logical not" },
  { text: "$exists", hint: "field exists" },
  { text: "$type", hint: "BSON type" },
  { text: "$regex", hint: "regex match" },
  { text: "$options", hint: "regex options" },
  { text: "$expr", hint: "aggregation expression" },
  { text: "$mod", hint: "modulo" },
  { text: "$all", hint: "all elements match" },
  { text: "$size", hint: "array length" },
  { text: "$elemMatch", hint: "array element match" },
  { text: "$text", hint: "text search" },
  { text: "$search", hint: "text search term" },
];

/** Aggregation pipeline stages + accumulators, offered only in aggregate mode. */
export const STAGE_OPERATORS: Suggestion[] = [
  { text: "$match", hint: "filter stage" },
  { text: "$group", hint: "group stage" },
  { text: "$project", hint: "reshape fields" },
  { text: "$sort", hint: "sort stage" },
  { text: "$limit", hint: "limit stage" },
  { text: "$skip", hint: "skip stage" },
  { text: "$unwind", hint: "unwind array" },
  { text: "$lookup", hint: "join collection" },
  { text: "$addFields", hint: "add fields" },
  { text: "$set", hint: "add/update fields" },
  { text: "$unset", hint: "remove fields" },
  { text: "$count", hint: "count documents" },
  { text: "$sample", hint: "random sample" },
  { text: "$sortByCount", hint: "group + sort by count" },
  { text: "$replaceRoot", hint: "promote sub-document" },
  { text: "$facet", hint: "multi-pipeline" },
  { text: "$bucket", hint: "bucket by range" },
  { text: "$densify", hint: "fill gaps" },
  { text: "$sum", hint: "accumulator: sum" },
  { text: "$avg", hint: "accumulator: avg" },
  { text: "$min", hint: "accumulator: min" },
  { text: "$max", hint: "accumulator: max" },
  { text: "$first", hint: "accumulator: first" },
  { text: "$last", hint: "accumulator: last" },
  { text: "$push", hint: "accumulator: push" },
  { text: "$addToSet", hint: "accumulator: unique array" },
];

const TOKEN_CHAR = /[A-Za-z0-9_.$]/;
const MAX_SUGGESTIONS = 8;

/**
 * The run of `[A-Za-z0-9_.$]` characters ending at `cursor`. May be empty when
 * the cursor sits after whitespace, punctuation, or at the start of the value.
 */
export function currentToken(value: string, cursor: number): { token: string; start: number } {
  const at = Math.max(0, Math.min(cursor, value.length));
  let start = at;
  while (start > 0 && TOKEN_CHAR.test(value[start - 1]!)) start--;
  return { token: value.slice(start, at), start };
}

function operatorsFor(mode: "find" | "aggregate"): Suggestion[] {
  return mode === "aggregate" ? [...FIND_OPERATORS, ...STAGE_OPERATORS] : FIND_OPERATORS;
}

/**
 * Rank suggestions for a token.
 * - empty token → nothing.
 * - `$`-token → operators only (find ops, plus stages in aggregate mode);
 *   prefix matches first, then substring matches.
 * - otherwise → field paths first (prefix then substring, case-insensitive),
 *   then operators that substring-match. Capped at 8.
 */
export function suggest(token: string, fields: string[], mode: "find" | "aggregate"): Suggestion[] {
  if (!token) return [];
  const lc = token.toLowerCase();
  const ops = operatorsFor(mode);
  // A suggestion that would insert exactly the current token is a no-op — after
  // accepting `year`, `year` must not be re-suggested (it would eat Enter forever
  // and block history recall). Applied to every branch via this filter.
  const noNoop = (list: Suggestion[]): Suggestion[] => list.filter((s) => (s.insert ?? s.text) !== token);

  if (token.startsWith("$")) {
    const prefix = ops.filter((o) => o.text.toLowerCase().startsWith(lc));
    const substr = ops.filter((o) => !o.text.toLowerCase().startsWith(lc) && o.text.toLowerCase().includes(lc));
    return noNoop([...prefix, ...substr]).slice(0, MAX_SUGGESTIONS);
  }

  const fieldSugs: Suggestion[] = fields.map((path) => ({ text: path, hint: "field" }));
  const fPrefix = fieldSugs.filter((f) => f.text.toLowerCase().startsWith(lc));
  const sPrefix = SNIPPETS.filter((s) => s.text.toLowerCase().startsWith(lc));
  const fSubstr = fieldSugs.filter((f) => !f.text.toLowerCase().startsWith(lc) && f.text.toLowerCase().includes(lc));
  const sSubstr = SNIPPETS.filter((s) => !s.text.toLowerCase().startsWith(lc) && s.text.toLowerCase().includes(lc));
  const oSubstr = ops.filter((o) => o.text.toLowerCase().includes(lc));
  return noNoop([...fPrefix, ...sPrefix, ...fSubstr, ...sSubstr, ...oSubstr]).slice(0, MAX_SUGGESTIONS);
}

/** Replace the WHOLE token under the cursor (both directions — `ye|ar` must not leave `ar` behind); cursor lands after the insert or at the snippet's caret. */
export function applySuggestion(value: string, cursor: number, s: Suggestion): { value: string; cursor: number } {
  const { start } = currentToken(value, cursor);
  let end = Math.max(0, Math.min(cursor, value.length));
  while (end < value.length && TOKEN_CHAR.test(value[end]!)) end++;
  const insert = s.insert ?? s.text;
  const next = value.slice(0, start) + insert + value.slice(end);
  return { value: next, cursor: start + (s.caret ?? insert.length) };
}
