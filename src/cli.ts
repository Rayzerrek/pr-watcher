#!/usr/bin/env node
import { Data, Effect, Option } from "effect";
import { fileURLToPath } from "node:url";

import {
  getAuthenticatedLogin,
  listPullRequestsWithCi,
  readGitHubToken,
} from "./github.js";
import { formatPullRequests } from "./render.js";
import {
  type CurrentBranchDetectionError,
  type InvalidRepositoryError,
  type RepositoryDetectionError,
  detectCurrentBranchFromGit,
  detectRepositoryFromGit,
  parseRepositoryRef,
} from "./repo.js";
import {
  type CiWaitFailedError,
  type CiWaitNoPullRequestsError,
  waitForCi,
  watchPullRequests,
} from "./watch.js";

import type { GitHubError } from "./github.js";
import type {
  CliOptions,
  CliParseResult,
  PullRequestFilters,
  RepositoryRef,
} from "./types.js";

/** Error returned when command-line arguments are invalid. */
export class CliParseError extends Data.TaggedError("CliParseError")<{
  readonly message: string;
}> {}

type AppError =
  | CliParseError
  | CurrentBranchDetectionError
  | InvalidRepositoryError
  | RepositoryDetectionError
  | GitHubError
  | CiWaitFailedError
  | CiWaitNoPullRequestsError;

const defaultOptions = (): CliOptions => ({
  repositoryInput: Option.none(),
  mode: "once",
  focus: "auto",
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

const setMode = (
  options: CliOptions,
  mode: CliOptions["mode"],
  optionName: string,
): Effect.Effect<CliOptions, CliParseError> => {
  if (options.mode !== "once" && options.mode !== mode) {
    return Effect.fail(
      new CliParseError({
        message: `Użyj ${optionName} albo ${options.mode === "watch" ? "--watch" : "--wait"}, nie obu naraz.`,
      }),
    );
  }

  return Effect.succeed({ ...options, mode });
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

/**
 * Parses CLI arguments into a typed command description without touching git or GitHub.
 */
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
      } else if (arg === "auth") {
        if (argv.length > 1) {
          return yield* Effect.fail(
            new CliParseError({
              message: "Komenda auth nie przyjmuje dodatkowych argumentów.",
            }),
          );
        }
        return { _tag: "Auth" };
      } else if (arg === "--watch" || arg === "-w") {
        options = yield* setMode(options, "watch", arg);
        index += 1;
      } else if (arg === "--wait") {
        options = yield* setMode(options, "wait", "--wait");
        index += 1;
      } else if (arg === "current" || arg === "--current") {
        options = { ...options, focus: "current-branch" };
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
        options = {
          ...options,
          focus: options.focus === "auto" ? "repository" : options.focus,
          repositoryInput: Option.some(arg),
        };
        index += 1;
      }
    }

    return { _tag: "Run", options };
  });

const helpText = `PR Watcher

Usage:
  pr-watcher [owner/repo] [options]
  pr-watcher current [owner/repo] [options]
  pr-watcher auth

Options:
  current, --current  Pokaż PR dla aktualnego brancha git
  --watch, -w          Odświeżaj cyklicznie i pokazuj zmiany statusów CI
  --wait              Czekaj aż CI zakończy się dla wybranych PR-ów
  --mine              Pokaż tylko moje PR-y (używa tokena env albo gh auth)
  --all               Pokaż open i closed PR-y
  --base <branch>     Filtruj po base branchu
  --interval <sec>    Interwał watch mode w sekundach (domyślnie 15)
  --help, -h          Pokaż pomoc

Auth:
  pr-watcher automatycznie używa GITHUB_TOKEN, GH_TOKEN albo \`gh auth token\`.
  Jeśli nie masz autoryzacji, uruchom: gh auth login

Examples:
  pr-watcher
  pr-watcher current --watch
  pr-watcher vercel/next.js
  pr-watcher vercel/next.js --watch
  pr-watcher current --wait
  pr-watcher --mine --base main
  pr-watcher auth
`;

const resolveRepository = (
  repositoryInput: Option.Option<string>,
): Effect.Effect<
  RepositoryRef,
  InvalidRepositoryError | RepositoryDetectionError
> =>
  Option.match(repositoryInput, {
    onNone: () => detectRepositoryFromGit(),
    onSome: (input) => parseRepositoryRef(input),
  });

const commonTrunkBranches = new Set([
  "main",
  "master",
  "develop",
  "dev",
  "trunk",
]);

const resolveCurrentBranchFocus = (
  options: CliOptions,
): Effect.Effect<Option.Option<string>, CurrentBranchDetectionError> => {
  if (options.focus === "repository") {
    return Effect.succeed(Option.none());
  }

  if (options.focus === "current-branch") {
    return detectCurrentBranchFromGit().pipe(Effect.map(Option.some));
  }

  if (Option.isSome(options.repositoryInput)) {
    return Effect.succeed(Option.none());
  }

  return detectCurrentBranchFromGit().pipe(
    Effect.map((branch) =>
      commonTrunkBranches.has(branch) ? Option.none() : Option.some(branch),
    ),
    Effect.catchAll(() => Effect.succeed(Option.none())),
  );
};

const resolveFilters = (
  repository: RepositoryRef,
  options: CliOptions,
  currentBranch: Option.Option<string>,
): Effect.Effect<PullRequestFilters, GitHubError> =>
  Effect.gen(function* () {
    const head = Option.map(
      currentBranch,
      (branch) => `${repository.owner}:${branch}`,
    );
    let author: Option.Option<string> = Option.none();

    if (options.authorScope === "mine") {
      const token = yield* readGitHubToken;
      author = Option.some(yield* getAuthenticatedLogin(token));
    }

    return {
      state: options.state,
      base: options.base,
      head,
      author,
    };
  });

/**
 * Runs the CLI command, including repository detection, GitHub filtering and rendering.
 */
export const runCli = (
  argv: ReadonlyArray<string>,
): Effect.Effect<void, AppError> =>
  Effect.gen(function* () {
    const parsed = yield* parseCliArgs(argv);

    if (parsed._tag === "Help") {
      return yield* Effect.sync(() => console.log(helpText));
    }

    if (parsed._tag === "Auth") {
      const token = yield* readGitHubToken;

      if (Option.isNone(token)) {
        return yield* Effect.sync(() =>
          console.log(
            [
              "Nie znaleziono autoryzacji GitHuba.",
              "",
              "Najprościej uruchom:",
              "  gh auth login",
              "",
              "pr-watcher automatycznie użyje potem `gh auth token`.",
              "Alternatywnie ustaw GITHUB_TOKEN albo GH_TOKEN.",
            ].join("\n"),
          ),
        );
      }

      const login = yield* getAuthenticatedLogin(token);
      return yield* Effect.sync(() =>
        console.log(`Autoryzacja działa. Zalogowano jako @${login}.`),
      );
    }

    const repository = yield* resolveRepository(parsed.options.repositoryInput);
    const currentBranch = yield* resolveCurrentBranchFocus(parsed.options);
    const filters = yield* resolveFilters(
      repository,
      parsed.options,
      currentBranch,
    );

    const context = Option.map(
      currentBranch,
      (branch) => `current branch: ${branch}`,
    );

    if (parsed.options.mode === "watch") {
      return yield* watchPullRequests(
        repository,
        filters,
        parsed.options.intervalSeconds,
        context,
      );
    }

    if (parsed.options.mode === "wait") {
      return yield* waitForCi(
        repository,
        filters,
        parsed.options.intervalSeconds,
        context,
      );
    }

    const pullRequests = yield* listPullRequestsWithCi(repository, filters);
    return yield* Effect.sync(() =>
      console.log(formatPullRequests(repository, pullRequests, context)),
    );
  });

const formatError = (error: AppError): string => {
  switch (error._tag) {
    case "CliParseError":
    case "InvalidRepositoryError":
    case "RepositoryDetectionError":
    case "CurrentBranchDetectionError":
    case "GitHubAuthRequiredError":
      return error.message;
    case "GitHubNetworkError":
      return `Błąd sieci GitHuba: ${error.message}`;
    case "GitHubApiError":
      return `GitHub API zwróciło ${error.status}: ${error.message}`;
    case "GitHubDecodeError":
      return `Nie rozumiem odpowiedzi GitHuba: ${error.message}`;
    case "CiWaitFailedError":
    case "CiWaitNoPullRequestsError":
      return error.message;
  }
};

const isMainModule = (): boolean => {
  const entrypoint = process.argv[1]?.replaceAll("\\", "/");
  const modulePath = fileURLToPath(import.meta.url).replaceAll("\\", "/");

  return (
    entrypoint !== undefined &&
    ((modulePath.endsWith("/cli.js") && entrypoint.endsWith("/cli.js")) ||
      (modulePath.endsWith("/cli.ts") && entrypoint.endsWith("/cli.ts")))
  );
};

if (isMainModule()) {
  void Effect.runPromise(
    runCli(process.argv.slice(2)).pipe(
      Effect.catchAll((error) =>
        Effect.sync(() => {
          console.error(formatError(error));
          process.exitCode = 1;
        }),
      ),
    ),
  ).then(() => {
    const exitCode = typeof process.exitCode === "number" ? process.exitCode : 0;
    process.exit(exitCode);
  });
}
