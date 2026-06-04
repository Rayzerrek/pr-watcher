#!/usr/bin/env node
import { Command } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Console, Effect } from "effect";

const command = Command.make("pr-watcher", {}, () => Console.log("working"));

const cli = Command.run(command, {
  name: "PR Watcher",
  version: "0.1.0",
});

cli(process.argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain);
