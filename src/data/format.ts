import type { Binary as BinaryType, Decimal128 as Decimal128Type, Long as LongType, ObjectId as ObjectIdType } from "bson";

type ParserApi = typeof import("mongodb-query-parser");
type BsonApi = typeof import("bson");

// bson@7 probes a Node v8 API that Bun 1.3.14 exposes but does not implement.
const processWithBuiltins = process as unknown as { getBuiltinModule?: (name: string) => unknown };
const originalGetBuiltinModule = processWithBuiltins.getBuiltinModule;
if (originalGetBuiltinModule) {
  processWithBuiltins.getBuiltinModule = (name: string) =>
    name === "v8" ? {} : originalGetBuiltinModule.call(process, name);
}
const parser = require("mongodb-query-parser") as ParserApi;
const bson = require("bson") as BsonApi;
if (originalGetBuiltinModule) processWithBuiltins.getBuiltinModule = originalGetBuiltinModule;

export const BSON = bson;
export const QUERY_PARSER = parser;

function oneLineError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const first = raw.split(/\r?\n/, 1)[0]?.trim() || "invalid value";
  return first
    .replace(/^Unexpected/, "unexpected")
    .replace(/\s+in\s+\(.*$/, "") // drop the parser's source-snippet tail
    .replace(/\s+/g, " ");
}

export function toShellString(doc: unknown, indent = 2): string {
  try {
    return parser.toJSString(doc, indent) ?? "undefined";
  } catch (error) {
    throw new Error(oneLineError(error));
  }
}

function bsonTag(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  return (value as { _bsontype?: string })._bsontype;
}

export function bsonTypeName(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "date";
  if (value instanceof RegExp) return "regex";

  const tag = bsonTag(value)?.toLowerCase();
  if (tag === "objectid") return "objectId";
  if (tag === "int32") return "int32";
  if (tag === "double") return "double";
  if (tag === "long") return "long";
  if (tag === "decimal128") return "decimal128";
  if (tag === "binary") return "binary";
  if (tag === "timestamp") return "timestamp";
  if (tag === "minkey") return "minKey";
  if (tag === "maxkey") return "maxKey";
  if (tag === "bsonregexp") return "regex";

  switch (typeof value) {
    case "string": return "string";
    case "boolean": return "bool";
    case "number": return Number.isInteger(value) && value >= -2_147_483_648 && value <= 2_147_483_647 ? "int32" : "double";
    case "bigint": return "long";
    case "object": return "object";
    default: return "undefined";
  }
}

function truncate(text: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  if (text.length <= maxLen) return text;
  if (maxLen === 1) return "…";
  return `${text.slice(0, maxLen - 1)}…`;
}

function objectIdHex(value: ObjectIdType): string {
  return value.toHexString();
}

function preview(value: unknown): string {
  const type = bsonTypeName(value);
  if (type === "objectId") {
    const hex = objectIdHex(value as ObjectIdType);
    return `${hex.slice(0, 6)}…${hex.slice(-6)}`;
  }
  if (value instanceof Date) {
    const iso = value.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
  }
  if (Array.isArray(value)) {
    const shown = value.slice(0, 3).map((entry) => preview(entry));
    return `[ ${shown.join(", ")}${value.length > 3 ? ", …" : ""} ]`;
  }
  if (value && typeof value === "object" && type === "object") {
    return `{ … ${Object.keys(value).length} fields }`;
  }
  if (typeof value === "string") return value;
  if (value instanceof RegExp) return value.toString();
  if (type === "binary") return `<binary ${(value as BinaryType).buffer.length} bytes>`;
  if (type === "decimal128" || type === "long" || type === "timestamp") {
    return (value as Decimal128Type | LongType).toString();
  }
  return String(value);
}

export function cellText(value: unknown, maxLen: number): string {
  return truncate(preview(value).replace(/\s*[\r\n]+\s*/g, " "), maxLen);
}

export function docToEditable(doc: Record<string, unknown>): string {
  return toShellString(doc);
}

export function parseEditedDoc(text: string): Record<string, unknown> {
  try {
    const parsed = parser.parseFilter(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("document must be an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(oneLineError(error));
  }
}

