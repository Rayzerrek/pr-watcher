import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli.js";
import { formatPullRequests } from "../src/render.js";

const execFileAsync = promisify(execFile);

describe("pr-watcher CLI", () => {
  it("prints help", async () => {
    const { stdout } = await execFileAsync(process.execPath, ["dist/cli.js", "--help"]);

    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("pr-watcher [owner/repo] [options]");
  });

  it("parses the simplified watch command", async () => {
    const result = await Effect.runPromise(
      parseCliArgs(["vercel/next.js", "--watch", "--interval", "30", "--base=main"]),
    );

    if (result._tag !== "Run") {
      throw new Error("Expected Run parse result");
    }

    expect(result.options.mode).toBe("watch");
    expect(result.options.intervalSeconds).toBe(30);
    expect(result.options.repositoryInput).toEqual(Option.some("vercel/next.js"));
    expect(result.options.base).toEqual(Option.some("main"));
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

    expect(output).toContain("owner/repo — 1 PR");
    expect(output).toContain("#12 ✅ passing Add watcher");
    expect(output).toContain("@kacpe feature/watcher → main");
  });
});
