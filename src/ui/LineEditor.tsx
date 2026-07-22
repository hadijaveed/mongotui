import type { ReactNode } from "react";
import type { KeyEvent } from "@opentui/core";
import type { FieldValidation } from "../shared/types.ts";
import { T, type Color } from "./theme.ts";
import { tokenizeQuery } from "./tokenize.ts";

export interface EditorState {
  value: string;
  cursor: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Is this key a printable character insertion? */
function isPrintable(key: KeyEvent): boolean {
  if (key.ctrl || key.meta) return false;
  if (key.name === "space") return true;
  const seq = key.sequence;
  return typeof seq === "string" && seq.length === 1 && seq.charCodeAt(0) >= 0x20 && seq.charCodeAt(0) !== 0x7f;
}

// Bracket/quote pairs that auto-close in the query editors (not in plain text fields).
const AUTO_PAIRS: Record<string, string> = { "{": "}", "[": "]", "(": ")", '"': '"', "'": "'" };
const AUTO_CLOSERS = new Set(Object.values(AUTO_PAIRS));

export interface EditorOpts {
  /** Auto-close `{ [ ( " '`, type-through the closer, and pair-delete on backspace. */
  autoPairs?: boolean;
}

/** Pure single-line editor reducer. Returns a new state; cursor always clamped. */
export function applyKey(state: EditorState, key: KeyEvent, opts?: EditorOpts): EditorState {
  const { value } = state;
  const at = clamp(state.cursor, 0, value.length);

  if (isPrintable(key)) {
    const ch = key.name === "space" ? " " : key.sequence;
    if (opts?.autoPairs && ch.length === 1) {
      // Type-through: typing a closer right before the matching auto-inserted one steps over it
      // (so `{}` + typing `}` lands after, no duplicate).
      if (AUTO_CLOSERS.has(ch) && value[at] === ch) return { value, cursor: at + 1 };
      // Auto-close: typing an opener inserts its closer and keeps the cursor between the pair.
      const close = AUTO_PAIRS[ch];
      if (close) return { value: value.slice(0, at) + ch + close + value.slice(at), cursor: at + 1 };
    }
    return { value: value.slice(0, at) + ch + value.slice(at), cursor: at + ch.length };
  }

  switch (key.name) {
    case "backspace": {
      if (at === 0) return { value, cursor: at };
      // Deleting the opener of an empty pair (cursor between `{|}`) removes the closer too.
      const prev = value[at - 1];
      if (opts?.autoPairs && prev !== undefined && AUTO_PAIRS[prev] !== undefined && value[at] === AUTO_PAIRS[prev]) {
        return { value: value.slice(0, at - 1) + value.slice(at + 1), cursor: at - 1 };
      }
      return { value: value.slice(0, at - 1) + value.slice(at), cursor: at - 1 };
    }
    case "delete":
      if (at >= value.length) return { value, cursor: at };
      return { value: value.slice(0, at) + value.slice(at + 1), cursor: at };
    case "left":
      return { value, cursor: Math.max(0, at - 1) };
    case "right":
      return { value, cursor: Math.min(value.length, at + 1) };
    case "home":
      return { value, cursor: 0 };
    case "end":
      return { value, cursor: value.length };
    case "a":
      return key.ctrl ? { value, cursor: 0 } : { value, cursor: at };
    case "e":
      return key.ctrl ? { value, cursor: value.length } : { value, cursor: at };
    case "w": {
      if (!key.ctrl) return { value, cursor: at };
      let i = at;
      while (i > 0 && /\s/.test(value[i - 1]!)) i--;
      while (i > 0 && !/\s/.test(value[i - 1]!)) i--;
      return { value: value.slice(0, i) + value.slice(at), cursor: i };
    }
    case "u":
      return key.ctrl ? { value: value.slice(at), cursor: 0 } : { value, cursor: at };
    default:
      return { value, cursor: at };
  }
}

interface Cell {
  ch: string;
  color: Color;
}

function toCells(value: string, colorize: boolean): Cell[] {
  if (!colorize) return [...value].map((ch) => ({ ch, color: T.text }));
  const cells: Cell[] = [];
  for (const span of tokenizeQuery(value)) {
    for (const ch of span.text) cells.push({ ch, color: span.color });
  }
  return cells;
}

function renderCells(cells: Cell[], cursor: number | null): ReactNode[] {
  const nodes: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < cells.length) {
    if (cursor !== null && i === cursor) {
      nodes.push(
        <span key={key++} fg={T.bg} bg={T.text}>
          {cells[i]!.ch}
        </span>,
      );
      i++;
      continue;
    }
    const color = cells[i]!.color;
    let text = "";
    while (i < cells.length && cells[i]!.color === color && !(cursor !== null && i === cursor)) {
      text += cells[i]!.ch;
      i++;
    }
    nodes.push(
      <span key={key++} fg={color}>
        {text}
      </span>,
    );
  }
  if (cursor !== null && cursor >= cells.length) {
    nodes.push(
      <span key={key++} fg={T.bg} bg={T.text}>
        {" "}
      </span>,
    );
  }
  return nodes;
}

export interface LineEditorProps {
  value: string;
  cursor: number;
  focused: boolean;
  placeholder?: string;
  colorize?: boolean;
  width?: number;
  validity?: FieldValidation;
}

/**
 * Controlled, styled single-line editor. Key handling is external (via applyKey);
 * this component only renders the value with token colors, a cursor cell, and
 * horizontal scroll that keeps the cursor visible.
 */
export function LineEditor({ value, cursor, focused, placeholder, colorize = true, width }: LineEditorProps): ReactNode {
  if (value.length === 0) {
    return (
      <text>
        {focused ? (
          <span fg={T.bg} bg={T.text}>
            {" "}
          </span>
        ) : null}
        {placeholder ? <span fg={T.dim}>{placeholder}</span> : null}
      </text>
    );
  }

  const cells = toCells(value, colorize);
  const cur = focused ? clamp(cursor, 0, cells.length) : null;
  const w = width && width > 0 ? width : cells.length + 1;
  let start = 0;
  if (cur !== null && cur >= w) start = cur - w + 1;
  const visible = cells.slice(start, start + w);
  const vc = cur === null ? null : cur - start;
  return <text>{renderCells(visible, vc)}</text>;
}
