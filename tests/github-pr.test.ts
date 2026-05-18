import { describe, expect, it } from "vitest";
import { parsePrUrl } from "../src/daemon/github-pr.js";

describe("parsePrUrl", () => {
  it("parses canonical PR URL", () => {
    expect(parsePrUrl("https://github.com/owner/repo/pull/42")).toEqual({
      owner: "owner",
      repo: "repo",
      number: 42,
    });
  });

  it("accepts http and trailing /files", () => {
    expect(parsePrUrl("http://github.com/owner/repo/pull/7/files")).toEqual({
      owner: "owner",
      repo: "repo",
      number: 7,
    });
  });

  it("accepts query strings", () => {
    expect(
      parsePrUrl("https://github.com/owner/repo/pull/7?diff=split"),
    ).toEqual({
      owner: "owner",
      repo: "repo",
      number: 7,
    });
  });

  it("trims whitespace", () => {
    expect(parsePrUrl("  https://github.com/o/r/pull/1  ")).toEqual({
      owner: "o",
      repo: "r",
      number: 1,
    });
  });

  it("rejects non-PR URLs", () => {
    expect(parsePrUrl("https://github.com/owner/repo/issues/42")).toBeNull();
    expect(parsePrUrl("https://github.com/owner/repo")).toBeNull();
    expect(parsePrUrl("https://example.com/owner/repo/pull/1")).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(parsePrUrl("")).toBeNull();
    expect(parsePrUrl("not-a-url")).toBeNull();
    expect(parsePrUrl("https://github.com//repo/pull/1")).toBeNull();
    expect(parsePrUrl("https://github.com/owner//pull/1")).toBeNull();
  });

  it("rejects non-numeric or zero PR numbers", () => {
    expect(parsePrUrl("https://github.com/o/r/pull/abc")).toBeNull();
    expect(parsePrUrl("https://github.com/o/r/pull/0")).toBeNull();
  });
});
