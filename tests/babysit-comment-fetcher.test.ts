/**
 * Tests for the PR-comment fetcher used by the babysit loop.
 *
 * Pure functions (`classifyAuthor`, `hashCommentBody`) are exercised
 * directly. The `fetchPrComments` shell-out gets a fake `gh` binary on
 * PATH — same pattern as the existing daemon-discovery tests, just
 * inlined here since we only need two scripts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  classifyAuthor,
  fetchPrComments,
  hashCommentBody,
} from "../src/daemon/babysit/comment-fetcher.js";

describe("classifyAuthor", () => {
  it("recognises CodeRabbit bot", () => {
    expect(classifyAuthor("coderabbitai[bot]")).toEqual({
      isBot: true,
      bot: "coderabbit",
    });
  });

  it("recognises Sourcery bot", () => {
    expect(classifyAuthor("sourcery-ai[bot]")).toEqual({
      isBot: true,
      bot: "sourcery",
    });
  });

  it("recognises Greptile (variant spellings)", () => {
    expect(classifyAuthor("greptile[bot]").bot).toBe("greptile");
    expect(classifyAuthor("greptile-apps[bot]").bot).toBe("greptile");
  });

  it("recognises ChatGPT Codex (both naming variants)", () => {
    expect(classifyAuthor("chatgpt-codex[bot]").bot).toBe("chatgpt-codex");
    expect(classifyAuthor("codex[bot]").bot).toBe("chatgpt-codex");
  });

  it("flags GitHub user.type=Bot as a bot even when login is unknown", () => {
    expect(classifyAuthor("some-ci-bot", "Bot")).toEqual({
      isBot: true,
      bot: null,
    });
  });

  it("flags any login with a [bot] suffix even when type is missing", () => {
    expect(classifyAuthor("randomthing[bot]").isBot).toBe(true);
  });

  it("treats unmapped human logins as non-bots", () => {
    expect(classifyAuthor("aboveearthproductions", "User")).toEqual({
      isBot: false,
      bot: null,
    });
  });
});

describe("hashCommentBody", () => {
  it("produces a 64-char hex string", () => {
    const h = hashCommentBody("hello world");
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is deterministic", () => {
    expect(hashCommentBody("x")).toBe(hashCommentBody("x"));
  });

  it("differs for whitespace differences (no normalization)", () => {
    expect(hashCommentBody("a b")).not.toBe(hashCommentBody("a  b"));
  });
});

// --- fetchPrComments with a fake `gh` on PATH ---

interface FakeGhCall {
  /** Substring to match in the args to decide which response to return. */
  argMatch: string;
  /** stdout to print. */
  stdout: string;
  /** Exit code (default 0). */
  exit?: number;
  /** stderr to print (default ""). */
  stderr?: string;
}

let tmpBin: string;
let prevPath: string | undefined;

function writeFakeGh(calls: FakeGhCall[]): void {
  // Bash script that inspects $@ and dispatches to the first matching call.
  // Each call is rendered as a heredoc to keep quoting sane.
  const branches = calls
    .map(
      (c, i) => `
if printf '%s' "$@" | grep -q ${shquote(c.argMatch)}; then
  cat <<'__CHORUS_FAKE_GH_${i}__'
${c.stdout}
__CHORUS_FAKE_GH_${i}__
  ${c.stderr ? `>&2 cat <<'__CHORUS_FAKE_GH_ERR_${i}__'\n${c.stderr}\n__CHORUS_FAKE_GH_ERR_${i}__` : ""}
  exit ${c.exit ?? 0}
fi`,
    )
    .join("\n");

  const script = `#!/usr/bin/env bash\nset -u\n${branches}\necho "fake-gh: no match" >&2\nexit 99\n`;
  fs.writeFileSync(path.join(tmpBin, "gh"), script, { mode: 0o755 });
}

function shquote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

beforeEach(() => {
  tmpBin = fs.mkdtempSync(path.join(os.tmpdir(), "chorus-fake-gh-"));
  prevPath = process.env.PATH;
  process.env.PATH = `${tmpBin}:${process.env.PATH ?? ""}`;
});

afterEach(() => {
  if (prevPath !== undefined) process.env.PATH = prevPath;
  fs.rmSync(tmpBin, { recursive: true, force: true });
});

describe("fetchPrComments", () => {
  it("merges review + issue comments, hashes bodies, sorts oldest-first", async () => {
    const reviewJson = JSON.stringify([
      {
        id: 101,
        user: { login: "coderabbitai[bot]" },
        body: "Consider extracting this helper.",
        created_at: "2026-05-15T10:00:00Z",
        path: "src/foo.ts",
        line: 42,
        html_url: "https://github.com/x/y/pull/1#discussion_r101",
      },
    ]);
    const issueJson = JSON.stringify([
      {
        id: 200,
        user: { login: "alice", type: "User" },
        body: "LGTM 👀",
        created_at: "2026-05-14T08:00:00Z",
        html_url: "https://github.com/x/y/pull/1#issuecomment-200",
      },
      {
        id: 201,
        user: { login: "sourcery-ai[bot]" },
        body: "Suggested refactor: rename `foo` to `bar`.",
        created_at: "2026-05-16T09:00:00Z",
        html_url: "https://github.com/x/y/pull/1#issuecomment-201",
      },
    ]);

    writeFakeGh([
      { argMatch: "/pulls/", stdout: reviewJson },
      { argMatch: "/issues/", stdout: issueJson },
    ]);

    const res = await fetchPrComments({
      owner: "x",
      repo: "y",
      prNumber: 1,
      cwd: tmpBin,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.comments).toHaveLength(3);
    // Oldest first
    expect(res.comments.map((c) => c.id)).toEqual([200, 101, 201]);

    const review = res.comments.find((c) => c.id === 101)!;
    expect(review.kind).toBe("review");
    expect(review.bot).toBe("coderabbit");
    expect(review.path).toBe("src/foo.ts");
    expect(review.line).toBe(42);
    expect(review.bodyHash).toBe(
      hashCommentBody("Consider extracting this helper."),
    );

    const human = res.comments.find((c) => c.id === 200)!;
    expect(human.isBot).toBe(false);
    expect(human.bot).toBeNull();
    expect(human.path).toBeNull();
  });

  it("returns partial data when one endpoint fails", async () => {
    writeFakeGh([
      {
        argMatch: "/pulls/",
        stdout: "",
        exit: 1,
        stderr: "HTTP 500",
      },
      {
        argMatch: "/issues/",
        stdout: JSON.stringify([
          {
            id: 1,
            user: { login: "u" },
            body: "ok",
            created_at: "2026-05-01T00:00:00Z",
          },
        ]),
      },
    ]);
    const res = await fetchPrComments({
      owner: "x",
      repo: "y",
      prNumber: 1,
      cwd: tmpBin,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.comments).toHaveLength(1);
    expect(res.comments[0].kind).toBe("issue");
  });

  it("surfaces gh_not_authed when both endpoints fail with auth error", async () => {
    writeFakeGh([
      {
        argMatch: "/pulls/",
        stdout: "",
        exit: 1,
        stderr: "gh auth login required",
      },
      {
        argMatch: "/issues/",
        stdout: "",
        exit: 1,
        stderr: "gh auth login required",
      },
    ]);
    const res = await fetchPrComments({
      owner: "x",
      repo: "y",
      prNumber: 1,
      cwd: tmpBin,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("gh_not_authed");
  });

  it("surfaces pr_not_found on 404", async () => {
    writeFakeGh([
      { argMatch: "/pulls/", stdout: "", exit: 1, stderr: "404 Not Found" },
      { argMatch: "/issues/", stdout: "", exit: 1, stderr: "404 Not Found" },
    ]);
    const res = await fetchPrComments({
      owner: "x",
      repo: "y",
      prNumber: 999,
      cwd: tmpBin,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("pr_not_found");
  });

  it("forwards `since` to both gh calls", async () => {
    let observedArgs = "";
    fs.writeFileSync(
      path.join(tmpBin, "gh"),
      `#!/usr/bin/env bash\necho "$@" >> ${tmpBin}/args\necho '[]'\n`,
      { mode: 0o755 },
    );
    await fetchPrComments({
      owner: "x",
      repo: "y",
      prNumber: 1,
      cwd: tmpBin,
      since: "2026-05-10T00:00:00Z",
    });
    observedArgs = fs.readFileSync(path.join(tmpBin, "args"), "utf-8");
    // `since=…` must be forwarded on BOTH the review-comment and
    // issue-comment fetches — asserting a single occurrence let a
    // one-sided regression slip through silently.
    const needle = "since=2026-05-10T00%3A00%3A00Z";
    const hits = observedArgs.split(needle).length - 1;
    expect(hits).toBe(2);
  });

  it("returns ok with empty list when gh returns empty arrays", async () => {
    writeFakeGh([
      { argMatch: "/pulls/", stdout: "[]" },
      { argMatch: "/issues/", stdout: "[]" },
    ]);
    const res = await fetchPrComments({
      owner: "x",
      repo: "y",
      prNumber: 1,
      cwd: tmpBin,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.comments).toEqual([]);
  });
});
