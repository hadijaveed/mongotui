import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { applyKey, type EditorState } from "./LineEditor.tsx";

// applyKey only reads name/sequence/ctrl/meta off the key.
function press(ch: string): KeyEvent {
  return { name: ch, sequence: ch, ctrl: false, meta: false, shift: false } as unknown as KeyEvent;
}
const BACKSPACE = { name: "backspace", sequence: "", ctrl: false, meta: false } as unknown as KeyEvent;
const PAIRS = { autoPairs: true };
const type = (s: EditorState, k: KeyEvent, opts?: { autoPairs?: boolean }) => applyKey(s, k, opts);

describe("query editor auto-pairs", () => {
  test("typing an opener inserts its closer with the cursor between", () => {
    expect(type({ value: "", cursor: 0 }, press("{"), PAIRS)).toEqual({ value: "{}", cursor: 1 });
    expect(type({ value: "", cursor: 0 }, press("["), PAIRS)).toEqual({ value: "[]", cursor: 1 });
    expect(type({ value: "", cursor: 0 }, press("("), PAIRS)).toEqual({ value: "()", cursor: 1 });
    expect(type({ value: "", cursor: 0 }, press('"'), PAIRS)).toEqual({ value: '""', cursor: 1 });
  });

  test("typing the closer in front of an auto-inserted one steps over it (no duplicate)", () => {
    // After `{` we're at `{|}`; typing `}` should land after, not produce `{}}`.
    const afterOpen = type({ value: "", cursor: 0 }, press("{"), PAIRS);
    expect(type(afterOpen, press("}"), PAIRS)).toEqual({ value: "{}", cursor: 2 });
  });

  test("backspace between an empty pair deletes both sides", () => {
    expect(type({ value: "{}", cursor: 1 }, BACKSPACE, PAIRS)).toEqual({ value: "", cursor: 0 });
  });

  test("backspace on a normal char still deletes just one", () => {
    expect(type({ value: "ab", cursor: 2 }, BACKSPACE, PAIRS)).toEqual({ value: "a", cursor: 1 });
  });

  test("real filter typing: `{` then `name` builds `{name}` with cursor inside", () => {
    let s: EditorState = { value: "", cursor: 0 };
    s = type(s, press("{"), PAIRS);
    for (const ch of "name") s = type(s, press(ch), PAIRS);
    expect(s).toEqual({ value: "{name}", cursor: 5 });
  });

  test("without autoPairs (plain fields) nothing is auto-closed", () => {
    expect(type({ value: "", cursor: 0 }, press("{"))).toEqual({ value: "{", cursor: 1 });
    expect(type({ value: "", cursor: 0 }, press('"'))).toEqual({ value: '"', cursor: 1 });
  });
});
