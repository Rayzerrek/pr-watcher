import { Console, Duration, Effect } from "effect";
import type { GitHubError, PullRequest, PullRequestFilters } from "./github.js";
import { listPullRequestsWithCi } from "./github.js";
import { formatPullRequests, formatStatusChanges } from "./render.js";
import { formatRepositoryRef, type RepositoryRef } from "./repo.js";

const toStatusMap = (
  pullRequests: ReadonlyArray<PullRequest>,
): ReadonlyMap<number, PullRequest["ciStatus"]> =>
  new Map(pullRequests.map((pullRequest) => [pullRequest.number, pullRequest.ciStatus]));

export const watchPullRequests = (
  repository: RepositoryRef,
  filters: PullRequestFilters,
  intervalSeconds: number,
): Effect.Effect<void, GitHubError> =>
  Effect.gen(function* () {
    let previous = new Map<number, PullRequest["ciStatus"]>();
    let isFirstRun = true;

    yield* Console.log(
      `Watching ${formatRepositoryRef(repository)} every ${intervalSeconds}s. Ctrl+C kończy.`,
    );

    while (true) {
      const pullRequests = yield* listPullRequestsWithCi(repository, filters);

      if (isFirstRun) {
        yield* Console.log(formatPullRequests(repository, pullRequests));
        isFirstRun = false;
      } else {
        const changes = formatStatusChanges(previous, pullRequests);
        if (changes.length > 0) {
          yield* Console.log(changes.join("\n"));
        }
      }

      previous = new Map(toStatusMap(pullRequests));
      yield* Effect.sleep(Duration.seconds(intervalSeconds));
    }
  });
