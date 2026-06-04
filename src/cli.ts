#!/usr/bin/env node
import { NodeRuntime } from "@effect/platform-node";
import { Console, Data, Effect, Option } from "effect";
import { pathToFileURL } from "node:url";

import {
  getAuthenticatedLogin,
  listPullRequestsWithCi,
  readGitHubToken,
} from "./github.js";
import { formatPullRequests } from "./render.js";
import {
  type InvalidRepositoryError,
  type RepositoryDetectionError,
  type RepositoryRef,
  detectRepositoryFromGit,
  parseRepositoryRef,
} from "./repo.js";
import { watchPullRequests } from "./watch.js";

import type {
  GitHubError,
  PullRequestFilters,
  PullRequestState,
} from "./github.js";

export type CliMode = "once" | "watch";
export type AuthorScope = "all-authors" | "mine";

export interface CliOptions {
  readonly repositoryInput: Option.Option<string>;
  readonly mode: CliMode;
  readonly authorScope: AuthorScope;
  readonly state: PullRequestState;
  readonly base: Option.Option<string>;
  readonly intervalSeconds: number;
}

export type CliParseResult =
  | { readonly _tag: "Help" }
  | { readonly _tag: "Run"; readonly options: CliOptions };

export class CliParseError extends Data.TaggedError("CliParseError")<{
  readonly message: string;
}> {}

type AppError =
  | CliParseError
  | InvalidRepositoryError
  | RepositoryDetectionError
  | GitHubError;

const defaultOptions = (): CliOptions => ({
  repositoryInput: Option.none(),
  mode: "once",
  authorScope: "all-authors",
  state: "open",
  base: Option.none(),
  intervalSeconds: 15,
});

const parsePositiveInteger = (
  input: string,
  optionName: string,
): Effect.Effect<number, CliParseError> => {
  if (!/^\d+$/.test(input)) {
    return Effect.fail(
      new CliParseError({
        message: `${optionName} musi być dodatnią liczbą sekund.`,
      }),
    );
  }

  const value = Number.parseInt(input, 10);
  if (value <= 0) {
    return Effect.fail(
      new CliParseError({ message: `${optionName} musi być większe od 0.` }),
    );
  }

  return Effect.succeed(value);
};

const readOptionValue = (
  argv: ReadonlyArray<string>,
  index: number,
  optionName: string,
): Effect.Effect<string, CliParseError> => {
  const value = argv[index + 1];

  if (value === undefined || value.startsWith("-")) {
    return Effect.fail(
      new CliParseError({ message: `Brakuje wartości dla ${optionName}.` }),
    );
  }

  return Effect.succeed(value);
};

export const parseCliArgs = (
  argv: ReadonlyArray<string>,
): Effect.Effect<CliParseResult, CliParseError> =>
  Effect.gen(function* () {
    let options = defaultOptions();
    let index = 0;

    while (index < argv.length) {
      const arg = argv[index];

      if (arg === undefined) {
        index += 1;
      } else if (arg === "--help" || arg === "-h") {
        return { _tag: "Help" };
      } else if (arg === "--watch" || arg === "-w") {
        options = { ...options, mode: "watch" };
        index += 1;
      } else if (arg === "--mine") {
        options = { ...options, authorScope: "mine" };
        index += 1;
      } else if (arg === "--all") {
        options = { ...options, state: "all" };
        index += 1;
      } else if (arg === "--base") {
        const value = yield* readOptionValue(argv, index, "--base");
        options = { ...options, base: Option.some(value) };
        index += 2;
      } else if (arg.startsWith("--base=")) {
        const value = arg.slice("--base=".length);
        if (value.length === 0) {
          return yield* Effect.fail(
            new CliParseError({ message: "Brakuje wartości dla --base." }),
          );
        }
        options = { ...options, base: Option.some(value) };
        index += 1;
      } else if (arg === "--interval") {
        const value = yield* readOptionValue(argv, index, "--interval");
        options = {
          ...options,
          intervalSeconds: yield* parsePositiveInteger(value, "--interval"),
        };
        index += 2;
      } else if (arg.startsWith("--interval=")) {
        const value = arg.slice("--interval=".length);
        options = {
          ...options,
          intervalSeconds: yield* parsePositiveInteger(value, "--interval"),
        };
        index += 1;
      } else if (arg.startsWith("-")) {
        return yield* Effect.fail(
          new CliParseError({ message: `Nieznana opcja: ${arg}` }),
        );
      } else if (Option.isSome(options.repositoryInput)) {
        return yield* Effect.fail(
          new CliParseError({
            message: "Podaj maksymalnie jedno repozytorium owner/repo.",
          }),
        );
      } else {
        options = { ...options, repositoryInput: Option.some(arg) };
        index += 1;
      }
    }

    return { _tag: "Run", options };
  });

const helpText = `PR Watcher

Usage:
  pr-watcher [owner/repo] [options]

Options:
  --watch, -w          Odświeżaj cyklicznie i pokazuj zmiany statusów CI
  --mine              Pokaż tylko moje PR-y (wymaga GITHUB_TOKEN albo GH_TOKEN)
  --all               Pokaż open i closed PR-y
  --base <branch>     Filtruj po base branchu
  --interval <sec>    Interwał watch mode w sekundach (domyślnie 15)
  --help, -h          Pokaż pomoc

Examples:
  pr-watcher
  pr-watcher vercel/next.js
  pr-watcher vercel/next.js --watch
  pr-watcher --mine --base main
`;

const resolveRepository = (
  repositoryInput: Option.Option<string>,
): Effect.Effect<RepositoryRef, InvalidRepositoryError | RepositoryDetectionError> =>
  Option.match(repositoryInput, {
    onNone: () => detectRepositoryFromGit(),
    onSome: (input) => parseRepositoryRef(input),
  });

const resolveFilters = (
  options: CliOptions,
): Effect.Effect<PullRequestFilters, GitHubError> =>
  Effect.gen(function* () {
    if (options.authorScope === "all-authors") {
      return {
        state: options.state,
        base: options.base,
        author: Option.none(),
      };
    }

    const token = yield* readGitHubToken;
    const login = yield* getAuthenticatedLogin(token);

    return {
      state: options.state,
      base: options.base,
      author: Option.some(login),
    };
  });

export const runCli = (
  argv: ReadonlyArray<string>,
): Effect.Effect<void, AppError> =>
  Effect.gen(function* () {
    const parsed = yield* parseCliArgs(argv);

    if (parsed._tag === "Help") {
      return yield* Console.log(helpText);
    }

    const repository = yield* resolveRepository(parsed.options.repositoryInput);
    const filters = yield* resolveFilters(parsed.options);

    if (parsed.options.mode === "watch") {
      return yield* watchPullRequests(
        repository,
        filters,
        parsed.options.intervalSeconds,
      );
    }

    const pullRequests = yield* listPullRequestsWithCi(repository, filters);
    return yield* Console.log(formatPullRequests(repository, pullRequests));
  });

const formatError = (error: AppError): string => {
  switch (error._tag) {
    case "CliParseError":
    case "InvalidRepositoryError":
    case "RepositoryDetectionError":
    case "GitHubAuthRequiredError":
      return error.message;
    case "GitHubNetworkError":
      return `Błąd sieci GitHuba: ${error.message}`;
    case "GitHubApiError":
      return `GitHub API zwróciło ${error.status}: ${error.message}`;
    case "GitHubDecodeError":
      return `Nie rozumiem odpowiedzi GitHuba: ${error.message}`;
  }
};

const isMainModule = (): boolean => {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
};

if (isMainModule()) {
  runCli(process.argv.slice(2)).pipe(
    Effect.catchAll((error) =>
      Console.error(formatError(error)).pipe(
        Effect.zipRight(
          Effect.sync(() => {
            process.exitCode = 1;
          }),
        ),
      ),
    ),
    NodeRuntime.runMain,
  );
}
