import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadConfig, normalizeUri, saveConfig } from "./config.ts";

let dir: string;
let prevXdg: string | undefined;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mongotui-cfg-"));
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
});

afterAll(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  rmSync(dir, { recursive: true, force: true });
});

describe("config load/save", () => {
  test("missing config loads as {}", () => {
    expect(loadConfig()).toEqual({});
  });

  test("save + load roundtrips and merges patches", () => {
    saveConfig({ theme: "nord" });
    expect(loadConfig().theme).toBe("nord");

    saveConfig({ connections: [{ name: "local", uri: "mongodb://localhost:27017" }] });
    const merged = loadConfig();
    expect(merged.theme).toBe("nord"); // earlier key preserved
    expect(merged.connections).toEqual([{ name: "local", uri: "mongodb://localhost:27017" }]);

    saveConfig({ lastConnection: "local" });
    expect(loadConfig().lastConnection).toBe("local");
  });

  test("corrupt config loads as {} without throwing", () => {
    mkdirSync(join(dir, "mongotui"), { recursive: true });
    writeFileSync(join(dir, "mongotui", "config.json"), "{ this is not json", "utf8");
    expect(loadConfig()).toEqual({});
  });
});

describe("normalizeUri", () => {
  test("bare host gets mongodb:// prepended", () => {
    expect(normalizeUri("localhost")).toBe("mongodb://localhost");
  });
  test("host:port gets mongodb:// prepended", () => {
    expect(normalizeUri("localhost:27017")).toBe("mongodb://localhost:27017");
    expect(normalizeUri("10.0.0.5:27018")).toBe("mongodb://10.0.0.5:27018");
  });
  test("creds@host gets mongodb:// prepended", () => {
    expect(normalizeUri("user:pass@host:27017/db")).toBe("mongodb://user:pass@host:27017/db");
  });
  test("explicit mongodb:// is kept as-is", () => {
    expect(normalizeUri("mongodb://host:27017")).toBe("mongodb://host:27017");
  });
  test("explicit mongodb+srv:// is kept as-is", () => {
    expect(normalizeUri("mongodb+srv://user:pass@cluster.example.net/db")).toBe(
      "mongodb+srv://user:pass@cluster.example.net/db",
    );
  });
  test("surrounding whitespace is trimmed; empty stays empty", () => {
    expect(normalizeUri("  localhost:27017  ")).toBe("mongodb://localhost:27017");
    expect(normalizeUri("   ")).toBe("");
  });
});
