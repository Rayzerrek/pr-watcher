import { Duration, Effect, Option } from "effect";
import type { GitHubError } from "./github.js";
import { listPullRequestsWithCi } from "./github.js";
import { formatPullRequests, formatStatusChanges } from "./render.js";
import { formatRepositoryRef } from "./repo.js";
import type { PullRequest, PullRequestFilters, RepositoryRef } from "./types.js";

const toStatusMap = (
  pullRequests: ReadonlyArray<PullRequest>,
): ReadonlyMap<number, PullRequest["ciStatus"]> =>
  new Map(
    pullRequests.map((pullRequest) => [
      pullRequest.number,
      pullRequest.ciStatus,
    ]),
  );

export const watchPullRequests = (
  repository: RepositoryRef,
  filters: PullRequestFilters,
  intervalSeconds: number,
  context: Option.Option<string> = Option.none(),
): Effect.Effect<void, GitHubError> =>
  Effect.gen(function* () {
    let previous: ReadonlyMap<number, PullRequest["ciStatus"]> = new Map();
    let isFirstRun = true;

    const contextLabel = Option.match(context, {
      onNone: () => "",
      onSome: (label) => ` (${label})`,
    });

    yield* Effect.sync(() =>
      console.log(
        `Watching ${formatRepositoryRef(repository)}${contextLabel} every ${intervalSeconds}s. Ctrl+C kończy.`,
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
