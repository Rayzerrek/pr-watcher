import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("pr-watcher CLI", () => {
  it("prints the scaffold message", async () => {
    const { stdout } = await execFileAsync(process.execPath, ["dist/cli.js"]);

    expect(stdout).toContain("working");
  });
});
