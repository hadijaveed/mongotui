import type { DocDiff } from "../shared/types.ts";
import { toShellString } from "./format.ts";

function tag(value: unknown): string | undefined {
  return value && typeof value === "object"
    ? (value as { _bsontype?: string })._bsontype?.toLowerCase()
    : undefined;
}

function bytes(value: unknown): Uint8Array | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as { buffer?: Uint8Array }).buffer;
  return candidate instanceof Uint8Array ? candidate : undefined;
}

function byteEqual(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof RegExp && b instanceof RegExp) return a.source === b.source && a.flags === b.flags;

  const aTag = tag(a);
  const bTag = tag(b);
  if (aTag || bTag) {
    if (aTag !== bTag) return false;
    if (aTag === "objectid") {
      return Boolean((a as { equals?: (other: unknown) => boolean }).equals?.(b));
    }
    if (aTag === "binary") return byteEqual(bytes(a), bytes(b));
    if (aTag === "bsonregexp") {
      const left = a as { pattern?: string; options?: string };
      const right = b as { pattern?: string; options?: string };
      return left.pattern === right.pattern && left.options === right.options;
    }
    return String(a) === String(b);
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length
      && a.every((value, index) => deepEqual(value, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return aKeys.length === bKeys.length
      && aKeys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Date || value instanceof RegExp || tag(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function computeDiff(original: Record<string, unknown>, edited: Record<string, unknown>): DocDiff {
  const diff: DocDiff = { set: {}, unset: [] };

  const walk = (path: string, before: unknown, after: unknown): void => {
    if (deepEqual(before, after)) return;
    if (Array.isArray(before) || Array.isArray(after)) {
      diff.set[path] = after;
      return;
    }
    if (isRecord(before) && isRecord(after)) {
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const childPath = path ? `${path}.${key}` : key;
        if (!Object.hasOwn(after, key)) diff.unset.push(childPath);
        else if (!Object.hasOwn(before, key)) diff.set[childPath] = after[key];
        else walk(childPath, before[key], after[key]);
      }
      return;
    }
    diff.set[path] = after;
  };

  for (const key of new Set([...Object.keys(original), ...Object.keys(edited)])) {
    if (key === "_id") continue;
    if (!Object.hasOwn(edited, key)) diff.unset.push(key);
    else if (!Object.hasOwn(original, key)) diff.set[key] = edited[key];
    else walk(key, original[key], edited[key]);
  }
  diff.unset.sort();
  return diff;
}

export function describeDiff(diff: DocDiff): string[] {
  const lines = Object.entries(diff.set).map(([path, value]) => {
    const rendered = toShellString(value, 0).replace(/\s+/g, " ");
    return `set  ${path} = ${rendered}`;
  });
  lines.push(...diff.unset.map((path) => `unset ${path}`));
  return lines;
}

