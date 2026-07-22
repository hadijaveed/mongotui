import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "./config.ts";
import {
  deleteSecret,
  getSecret,
  joinCredentials,
  migrateSecrets,
  secretsBackend,
  splitCredentials,
  storeSecret,
} from "./secrets.ts";

let dir: string;
let prevXdg: string | undefined;
let prevBackend: string | undefined;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mongotui-secrets-"));
  prevXdg = process.env.XDG_CONFIG_HOME;
  prevBackend = process.env.MONGOTUI_SECRETS;
  process.env.XDG_CONFIG_HOME = dir;
  process.env.MONGOTUI_SECRETS = "file"; // force the encrypted-file backend
});

afterAll(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  if (prevBackend === undefined) delete process.env.MONGOTUI_SECRETS;
  else process.env.MONGOTUI_SECRETS = prevBackend;
  rmSync(dir, { recursive: true, force: true });
});

function vaultPath(): string {
  return join(dir, "mongotui", "credentials.enc");
}

describe("splitCredentials / joinCredentials", () => {
  test("no credentials", () => {
    expect(splitCredentials("mongodb://localhost:27017")).toEqual({
      uri: "mongodb://localhost:27017",
      password: null,
    });
  });

  test("user only (no password)", () => {
    expect(splitCredentials("mongodb://user@host:27017/db")).toEqual({
      uri: "mongodb://user@host:27017/db",
      password: null,
    });
  });

  test("user:password", () => {
    expect(splitCredentials("mongodb://user:pass@host:27017/db")).toEqual({
      uri: "mongodb://user@host:27017/db",
      password: "pass",
    });
  });

  test("percent-encoded password with @ / : / /", () => {
    const raw = "mongodb://user:p%40ss%3Aw%2Frd@host:27017/db";
    const { uri, password } = splitCredentials(raw);
    expect(uri).toBe("mongodb://user@host:27017/db");
    expect(password).toBe("p@ss:w/rd");
    // reattaching re-encodes back to the original URI
    expect(joinCredentials(uri, password!)).toBe(raw);
  });

  test("mongodb+srv", () => {
    expect(splitCredentials("mongodb+srv://admin:s3cret@cluster.example.net/db")).toEqual({
      uri: "mongodb+srv://admin@cluster.example.net/db",
      password: "s3cret",
    });
  });

  test("multi-host with replicaSet query", () => {
    const raw = "mongodb://admin:secret@h1:27017,h2:27017/db?replicaSet=rs0";
    const { uri, password } = splitCredentials(raw);
    expect(uri).toBe("mongodb://admin@h1:27017,h2:27017/db?replicaSet=rs0");
    expect(password).toBe("secret");
    expect(joinCredentials(uri, "secret")).toBe(raw);
  });

  test("joinCredentials is a no-op without a user segment", () => {
    expect(joinCredentials("mongodb://localhost:27017", "x")).toBe("mongodb://localhost:27017");
  });
});

describe("encrypted-file backend", () => {
  beforeEach(() => {
    rmSync(vaultPath(), { force: true });
  });

  test("active backend is the encrypted file", () => {
    expect(secretsBackend()).toBe("encrypted file");
  });

  test("store → get roundtrip and delete", () => {
    storeSecret("conn-a", "hunter2");
    storeSecret("conn-b", "correct horse");
    expect(getSecret("conn-a")).toBe("hunter2");
    expect(getSecret("conn-b")).toBe("correct horse");
    expect(getSecret("missing")).toBeNull();

    deleteSecret("conn-a");
    expect(getSecret("conn-a")).toBeNull();
    expect(getSecret("conn-b")).toBe("correct horse"); // unaffected
  });

  test("file is written mode 0600", () => {
    storeSecret("perm", "x");
    const { statSync } = require("node:fs") as typeof import("node:fs");
    expect(statSync(vaultPath()).mode & 0o777).toBe(0o600);
  });

  test("wrong machine (tampered salt) yields null, not garbage", () => {
    storeSecret("tamper", "topsecret");
    expect(getSecret("tamper")).toBe("topsecret");

    const vault = JSON.parse(readFileSync(vaultPath(), "utf8"));
    // Flip the salt → derived key differs → GCM auth fails on decrypt.
    vault.salt = vault.salt === "0".repeat(vault.salt.length)
      ? "1".repeat(vault.salt.length)
      : "0".repeat(vault.salt.length);
    writeFileSync(vaultPath(), JSON.stringify(vault));

    expect(getSecret("tamper")).toBeNull();
  });
});

describe("config migration", () => {
  test("embedded password is moved to the secret store and stripped from config", () => {
    // A legacy config.json with a password baked into a saved connection URI.
    mkdirSync(join(dir, "mongotui"), { recursive: true });
    saveConfig({
      connections: [
        { name: "prod", uri: "mongodb://appuser:s3cr3t@db.example.com:27017/app" },
        { name: "local", uri: "mongodb://localhost:27017" },
      ],
      lastConnection: "prod",
    });

    const result = migrateSecrets();
    expect(result.migrated).toBe(true);
    expect(result.error).toBeUndefined();

    const cfg = loadConfig();
    const prod = cfg.connections!.find((c) => c.name === "prod")!;
    expect(prod.uri).toBe("mongodb://appuser@db.example.com:27017/app");
    // no password anywhere in the serialized config
    const raw = readFileSync(join(dir, "mongotui", "config.json"), "utf8");
    expect(raw).not.toContain("s3cr3t");
    expect(raw).not.toContain(":s3cr3t@");

    // password now resolvable from the secret store under the connection name
    expect(getSecret("prod")).toBe("s3cr3t");

    // untouched passwordless connection stays as-is; lastConnection stays a name
    expect(cfg.connections!.find((c) => c.name === "local")!.uri).toBe("mongodb://localhost:27017");
    expect(cfg.lastConnection).toBe("prod");
  });

  test("a config with no embedded passwords reports nothing migrated", () => {
    saveConfig({ connections: [{ name: "plain", uri: "mongodb://localhost:27017" }], lastConnection: "plain" });
    // clear any secret left by the previous test's connection name reuse
    deleteSecret("plain");
    expect(migrateSecrets()).toEqual({ migrated: false });
  });
});
