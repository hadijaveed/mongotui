import jsTokens from "js-tokens";
import { T, type Color } from "./theme.ts";

export interface ColoredSpan {
  text: string;
  color: Color;
}

type Tok = { type: string; value: string };

/** Index of the next non-whitespace token after `i`, or -1. */
function nextMeaningful(tokens: Tok[], i: number): number {
  for (let j = i + 1; j < tokens.length; j++) {
    const t = tokens[j]!;
    if (t.type !== "WhiteSpace" && t.type !== "LineTerminatorSequence") return j;
  }
  return -1;
}

const KEYWORDS = new Set(["true", "false", "null"]);

/**
 * Tokenize query text into colored spans. Single pass with 1-token lookahead
 * (whitespace skipped) so colors depend on the following syntactic token.
 */
export function tokenizeQuery(text: string): ColoredSpan[] {
  if (!text) return [];
  const tokens: Tok[] = Array.from(jsTokens(text)) as Tok[];
  const out: ColoredSpan[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const next = nextMeaningful(tokens, i);
    const nextVal = next >= 0 ? tokens[next]!.value : "";
    let color: Color = T.text;

    switch (tok.type) {
      case "StringLiteral":
      case "NoSubstitutionTemplate":
        color = nextVal === ":" ? T.key : T.str;
        break;
      case "NumericLiteral":
        color = T.num;
        break;
      case "Punctuator":
        color = T.dim;
        break;
      case "IdentifierName":
        if (nextVal === "(") color = T.fn;
        else if (tok.value.startsWith("$")) color = T.op;
        else if (nextVal === ":") color = T.key;
        else if (KEYWORDS.has(tok.value)) color = T.bool;
        else color = T.text;
        break;
      case "RegularExpressionLiteral":
      case "Invalid":
        color = T.red;
        break;
      case "WhiteSpace":
      case "LineTerminatorSequence":
        color = T.text;
        break;
      default:
        color = T.text;
    }
    out.push({ text: tok.value, color });
  }
  return out;
}
