import { Data, Duration, Effect, Option } from "effect";
import type { GitHubError } from "./github.js";
import { listPullRequestsWithCi } from "./github.js";
import { formatPullRequests, formatStatusChanges } from "./render.js";
import { formatRepositoryRef } from "./repo.js";
import type { PullRequest, PullRequestFilters, RepositoryRef } from "./types.js";

/** Error returned by `--wait` when any selected PR reaches a failing CI state. */
export class CiWaitFailedError extends Data.TaggedError("CiWaitFailedError")<{
  readonly message: string;
}> {}

/** Error returned by `--wait` when filters do not match any pull request. */
export class CiWaitNoPullRequestsError extends Data.TaggedError(
  "CiWaitNoPullRequestsError",
)<{
  readonly message: string;
}> {}

/** Terminal or in-progress classification for a `--wait` polling snapshot. */
export type CiWaitOutcome =
  | { readonly _tag: "NoPullRequests" }
  | { readonly _tag: "Succeeded" }
  | { readonly _tag: "Failed" }
  | { readonly _tag: "Waiting" };

const toStatusMap = (
  pullRequests: ReadonlyArray<PullRequest>,
): ReadonlyMap<number, PullRequest["ciStatus"]> =>
  new Map(
    pullRequests.map((pullRequest) => [
      pullRequest.number,
      pullRequest.ciStatus,
    ]),
  );

const contextLabel = (context: Option.Option<string>): string =>
  Option.match(context, {
    onNone: () => "",
    onSome: (label) => ` (${label})`,
  });

const hasFailedCi = (pullRequests: ReadonlyArray<PullRequest>): boolean =>
  pullRequests.some(
    (pullRequest) =>
      pullRequest.ciStatus === "failing" ||
      pullRequest.ciStatus === "action-required",
  );

/**
 * Classifies a CI snapshot for `--wait`.
 *
 * `no-checks` intentionally remains a waiting state because GitHub can create
 * check runs shortly after a push; ending immediately would be surprising for
 * the common `git push && pr-watcher current --wait` flow.
 */
export const evaluateCiWait = (
  pullRequests: ReadonlyArray<PullRequest>,
): CiWaitOutcome => {
  if (pullRequests.length === 0) {
    return { _tag: "NoPullRequests" };
  }

  if (hasFailedCi(pullRequests)) {
    return { _tag: "Failed" };
  }

  if (pullRequests.every((pullRequest) => pullRequest.ciStatus === "passing")) {
    return { _tag: "Succeeded" };
  }

  return { _tag: "Waiting" };
};

/**
 * Polls PRs forever and prints status transitions until the process is stopped.
 */
export const watchPullRequests = (
  repository: RepositoryRef,
  filters: PullRequestFilters,
  intervalSeconds: number,
  context: Option.Option<string> = Option.none(),
): Effect.Effect<void, GitHubError> =>
  Effect.gen(function* () {
    let previous: ReadonlyMap<number, PullRequest["ciStatus"]> = new Map();
    let isFirstRun = true;

    yield* Effect.sync(() =>
      console.log(
        `Watching ${formatRepositoryRef(repository)}${contextLabel(context)} every ${intervalSeconds}s. Ctrl+C kończy.`,
      ),
    );

    while (true) {
      const pullRequests = yield* listPullRequestsWithCi(repository, filters);

      if (isFirstRun) {
        yield* Effect.sync(() =>
          console.log(formatPullRequests(repository, pullRequests, context)),
        );
        isFirstRun = false;
      } else {
        const changes = formatStatusChanges(previous, pullRequests);
        if (changes.length > 0) {
          yield* Effect.sync(() => console.log(changes.join("\n")));
        }
      }

      previous = toStatusMap(pullRequests);
      yield* Effect.sleep(Duration.seconds(intervalSeconds));
    }
  });

/**
 * Waits until selected PRs reach a terminal CI state.
 *
 * The effect succeeds only when every selected PR is `passing`. It fails when
 * any selected PR is `failing` or `action-required`, which lets the CLI return
 * a non-zero exit code for shell workflows.
 */
export const waitForCi = (
  repository: RepositoryRef,
  filters: PullRequestFilters,
  intervalSeconds: number,
  context: Option.Option<string> = Option.none(),
): Effect.Effect<
  void,
  GitHubError | CiWaitFailedError | CiWaitNoPullRequestsError
> =>
  Effect.gen(function* () {
    let previous: ReadonlyMap<number, PullRequest["ciStatus"]> = new Map();
    let isFirstRun = true;

    yield* Effect.sync(() =>
      console.log(
        `Waiting for CI on ${formatRepositoryRef(repository)}${contextLabel(context)} every ${intervalSeconds}s. Ctrl+C kończy.`,
      ),
    );

    while (true) {
      const pullRequests = yield* listPullRequestsWithCi(repository, filters);
      const outcome = evaluateCiWait(pullRequests);
      const shouldPrintSnapshot = isFirstRun || outcome._tag !== "Waiting";

      if (shouldPrintSnapshot) {
        yield* Effect.sync(() =>
          console.log(formatPullRequests(repository, pullRequests, context)),
        );
      } else {
        const changes = formatStatusChanges(previous, pullRequests);
        if (changes.length > 0) {
          yield* Effect.sync(() => console.log(changes.join("\n")));
        }
      }

      switch (outcome._tag) {
        case "NoPullRequests":
          return yield* Effect.fail(
            new CiWaitNoPullRequestsError({
              message: "Nie znaleziono PR-ów dla wybranych filtrów.",
            }),
          );
        case "Succeeded":
          return yield* Effect.sync(() => console.log("CI zakończone: passing."));
        case "Failed":
          return yield* Effect.fail(
            new CiWaitFailedError({
              message: "CI zakończone niepowodzeniem.",
            }),
          );
        case "Waiting":
          previous = toStatusMap(pullRequests);
          isFirstRun = false;
          yield* Effect.sleep(Duration.seconds(intervalSeconds));
      }
    }
  });
