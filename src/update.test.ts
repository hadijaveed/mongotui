import { describe, expect, it } from "bun:test";
import { assetBaseName, compareVersions, parseSha256, parseTagFromLocation } from "./update.ts";

describe("update: parseTagFromLocation", () => {
  it("pulls the tag from a /releases/tag/ redirect", () => {
    expect(parseTagFromLocation("https://github.com/o/r/releases/tag/v0.1.4")).toBe("v0.1.4");
  });
  it("handles a query string / fragment after the tag", () => {
    expect(parseTagFromLocation("https://github.com/o/r/releases/tag/v1.2.3?foo=bar")).toBe("v1.2.3");
  });
  it("returns null when there is no tag (e.g. redirected to /releases)", () => {
    expect(parseTagFromLocation("https://github.com/o/r/releases")).toBeNull();
  });
});

describe("update: assetBaseName", () => {
  it("names the four supported targets", () => {
    expect(assetBaseName("linux", "x64")).toBe("mongotui-linux-x64");
    expect(assetBaseName("linux", "arm64")).toBe("mongotui-linux-arm64");
    expect(assetBaseName("darwin", "x64")).toBe("mongotui-darwin-x64");
    expect(assetBaseName("darwin", "arm64")).toBe("mongotui-darwin-arm64");
  });
  it("rejects unsupported OS and CPU", () => {
    expect(() => assetBaseName("win32", "x64")).toThrow(/unsupported OS/);
    expect(() => assetBaseName("linux", "ia32")).toThrow(/unsupported CPU/);
  });
});

describe("update: compareVersions", () => {
  it("orders core versions numerically (not lexically)", () => {
    expect(compareVersions("0.1.9", "0.1.10")).toBeLessThan(0);
    expect(compareVersions("v0.2.0", "v0.1.99")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });
  it("tolerates a leading v on either side", () => {
    expect(compareVersions("v0.1.3", "0.1.3")).toBe(0);
  });
  it("treats a prerelease as older than the matching release", () => {
    expect(compareVersions("1.0.0-rc1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0.0-rc1")).toBeGreaterThan(0);
  });
});

describe("update: parseSha256", () => {
  const sums = [
    "aa" + "0".repeat(62) + "  mongotui-linux-x64.gz",
    "bb" + "0".repeat(62) + "  mongotui-linux-x64.xz",
  ].join("\n");
  it("finds the digest for a named asset", () => {
    expect(parseSha256(sums, "mongotui-linux-x64.gz")).toBe("aa" + "0".repeat(62));
    expect(parseSha256(sums, "mongotui-linux-x64.xz")).toBe("bb" + "0".repeat(62));
  });
  it("supports binary-mode `*name` lines", () => {
    expect(parseSha256("cc" + "0".repeat(62) + " *mongotui-darwin-arm64.gz", "mongotui-darwin-arm64.gz"))
      .toBe("cc" + "0".repeat(62));
  });
  it("returns null when the asset is absent", () => {
    expect(parseSha256(sums, "mongotui-darwin-x64.gz")).toBeNull();
  });
});
