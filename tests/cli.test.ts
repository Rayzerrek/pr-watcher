import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli.js";
import { formatPullRequests } from "../src/render.js";
import { evaluateCiWait } from "../src/watch.js";

describe("pr-watcher CLI", () => {
  it("parses help", async () => {
    const result = await Effect.runPromise(parseCliArgs(["--help"]));

    expect(result).toEqual({ _tag: "Help" });
  });

  it("parses auth", async () => {
    const result = await Effect.runPromise(parseCliArgs(["auth"]));

    expect(result).toEqual({ _tag: "Auth" });
  });

  it("parses the simplified watch command", async () => {
    const result = await Effect.runPromise(
      parseCliArgs(["vercel/next.js", "--watch", "--interval", "30", "--base=main"]),
    );

    if (result._tag !== "Run") {
      throw new Error("Expected Run parse result");
    }

    expect(result.options.mode).toBe("watch");
    expect(result.options.focus).toBe("repository");
    expect(result.options.intervalSeconds).toBe(30);
    expect(result.options.repositoryInput).toEqual(Option.some("vercel/next.js"));
    expect(result.options.base).toEqual(Option.some("main"));
  });

  it("parses wait mode", async () => {
    const result = await Effect.runPromise(
      parseCliArgs(["current", "vercel/next.js", "--wait", "--interval=10"]),
    );

    if (result._tag !== "Run") {
      throw new Error("Expected Run parse result");
    }

    expect(result.options.mode).toBe("wait");
    expect(result.options.focus).toBe("current-branch");
    expect(result.options.intervalSeconds).toBe(10);
  });

  it("rejects conflicting watch modes", async () => {
    const error = await Effect.runPromise(
      parseCliArgs(["--watch", "--wait"]).pipe(Effect.flip),
    );

    expect(error._tag).toBe("CliParseError");
  });

  it("parses current branch focus", async () => {
    const result = await Effect.runPromise(
      parseCliArgs(["current", "vercel/next.js", "--watch"]),
    );

    if (result._tag !== "Run") {
      throw new Error("Expected Run parse result");
    }

    expect(result.options.mode).toBe("watch");
    expect(result.options.focus).toBe("current-branch");
    expect(result.options.repositoryInput).toEqual(Option.some("vercel/next.js"));
  });

  it("rejects invalid interval values", async () => {
    const error = await Effect.runPromise(parseCliArgs(["--interval", "0"]).pipe(Effect.flip));

    expect(error._tag).toBe("CliParseError");
  });

  it("renders pull requests with CI status", () => {
    const output = formatPullRequests(
      { owner: "owner", repo: "repo" },
      [
        {
          number: 12,
          title: "Add watcher",
          author: Option.some("kacpe"),
          headBranch: "feature/watcher",
          baseBranch: "main",
          url: "https://github.com/owner/repo/pull/12",
          draft: false,
          headSha: "abc123",
          ciStatus: "passing",
        },
      ],
    );

    expect(output).toContain("owner/repo\n1 PR - 1 passing");
    expect(output).toContain("PASS    #12 Add watcher");
    expect(output).toContain("@kacpe  feature/watcher -> main");
  });

  it("renders actionable statuses first", () => {
    const output = formatPullRequests(
      { owner: "owner", repo: "repo" },
      [
        {
          number: 1,
          title: "Passing PR",
          author: Option.some("kacpe"),
          headBranch: "feature/pass",
          baseBranch: "main",
          url: "https://github.com/owner/repo/pull/1",
          draft: false,
          headSha: "abc123",
          ciStatus: "passing",
        },
        {
          number: 2,
          title: "Failing PR",
          author: Option.some("kacpe"),
          headBranch: "feature/fail",
          baseBranch: "main",
          url: "https://github.com/owner/repo/pull/2",
          draft: false,
          headSha: "def456",
          ciStatus: "failing",
        },
      ],
    );

    expect(output.indexOf("FAIL    #2 Failing PR")).toBeLessThan(
      output.indexOf("PASS    #1 Passing PR"),
    );
  });

  it("classifies CI wait outcomes", () => {
    const basePullRequest = {
      number: 1,
      title: "PR",
      author: Option.some("kacpe"),
      headBranch: "feature",
      baseBranch: "main",
      url: "https://github.com/owner/repo/pull/1",
      draft: false,
      headSha: "abc123",
    };

    expect(evaluateCiWait([])).toEqual({ _tag: "NoPullRequests" });
    expect(
      evaluateCiWait([{ ...basePullRequest, ciStatus: "pending" }]),
    ).toEqual({ _tag: "Waiting" });
    expect(
      evaluateCiWait([
        { ...basePullRequest, ciStatus: "passing" },
        { ...basePullRequest, number: 2, ciStatus: "pending" },
      ]),
    ).toEqual({ _tag: "Waiting" });
    expect(
      evaluateCiWait([{ ...basePullRequest, ciStatus: "no-checks" }]),
    ).toEqual({ _tag: "Waiting" });
    expect(
      evaluateCiWait([{ ...basePullRequest, ciStatus: "passing" }]),
    ).toEqual({ _tag: "Succeeded" });
    expect(
      evaluateCiWait([{ ...basePullRequest, ciStatus: "failing" }]),
    ).toEqual({ _tag: "Failed" });
    expect(
      evaluateCiWait([{ ...basePullRequest, ciStatus: "action-required" }]),
    ).toEqual({ _tag: "Failed" });
  });

  it("renders focused current branch context", () => {
    const output = formatPullRequests(
      { owner: "owner", repo: "repo" },
      [],
      Option.some("current branch: feature/watcher"),
    );

    expect(output).toContain("owner/repo (current branch: feature/watcher)\n0 PRs");
  });
});
