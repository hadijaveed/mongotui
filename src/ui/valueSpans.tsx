import type { ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import type { Binary, Decimal128, Long, ObjectId } from "bson";
import { bsonTypeName, cellText } from "../data/format.ts";
import { T, type Color } from "./theme.ts";

export interface Span {
  text: string;
  color: Color;
  bg?: Color;
  attributes?: number;
}

const DIM_ITALIC = TextAttributes.DIM | TextAttributes.ITALIC;

function quote(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** Shell-style spans for a single BSON value (primitives + special types). */
export function valueSpans(value: unknown): Span[] {
  const type = bsonTypeName(value);
  switch (type) {
    case "objectId": {
      const hex = (value as ObjectId).toHexString();
      return [
        { text: "ObjectId(", color: T.fn },
        { text: quote(hex), color: T.str },
        { text: ")", color: T.fn },
      ];
    }
    case "date": {
      const iso = (value as Date).toISOString();
      return [
        { text: "ISODate(", color: T.fn },
        { text: quote(iso), color: T.str },
        { text: ")", color: T.fn },
      ];
    }
    case "long":
      return [
        { text: "NumberLong(", color: T.fn },
        { text: quote((value as Long).toString()), color: T.num },
        { text: ")", color: T.fn },
      ];
    case "decimal128":
      return [
        { text: "NumberDecimal(", color: T.fn },
        { text: quote((value as Decimal128).toString()), color: T.num },
        { text: ")", color: T.fn },
      ];
    case "binary": {
      const len = (value as Binary).buffer?.length ?? 0;
      return [{ text: `<binary ${len} bytes>`, color: T.dim }];
    }
    case "string":
      return [{ text: quote(value as string), color: T.str }];
    case "int32":
    case "double":
    case "timestamp":
      return [{ text: String(value), color: T.num }];
    case "bool":
      return [{ text: String(value), color: T.bool }];
    case "null":
      return [{ text: "null", color: T.bool }];
    case "undefined":
      return [{ text: "undefined", color: T.dim, attributes: DIM_ITALIC }];
    case "regex":
      return [{ text: String(value), color: T.red }];
    default:
      // object / array fall through here only when rendered inline (empty).
      return [{ text: cellText(value, 60), color: T.dim }];
  }
}

/** Color for a table cell, keyed by BSON type. */
export function cellColor(value: unknown): { color: Color; attributes?: number } {
  switch (bsonTypeName(value)) {
    case "string":
      return { color: T.text };
    case "int32":
    case "double":
    case "long":
    case "decimal128":
      return { color: T.num };
    case "objectId":
      return { color: T.dim };
    case "date":
      return { color: T.cyan };
    case "bool":
      return { color: T.bool };
    case "array":
    case "object":
      return { color: T.dim };
    case "null":
    case "undefined":
      return { color: T.dim, attributes: DIM_ITALIC };
    default:
      return { color: T.text };
  }
}

/** Render Span[] into <span> nodes. */
export function Spans({ spans }: { spans: Span[] }): ReactNode {
  return (
    <>
      {spans.map((s, i) => (
        <span key={i} fg={s.color} bg={s.bg} attributes={s.attributes}>
          {s.text}
        </span>
      ))}
    </>
  );
}
