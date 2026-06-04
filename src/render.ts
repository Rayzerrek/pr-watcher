import { Option } from "effect";
import { formatRepositoryRef } from "./repo.js";
import type { CiStatus, PullRequest, RepositoryRef } from "./types.js";

const ciLabel = (status: CiStatus): string => {
  switch (status) {
    case "passing":
      return "passing";
    case "failing":
      return "failing";
    case "pending":
      return "pending";
    case "action-required":
      return "action required";
    case "no-checks":
      return "no checks";
  }
};

const authorLabel = (author: Option.Option<string>): string =>
  Option.match(author, {
    onNone: () => "unknown",
    onSome: (login) => login,
  });

export const formatPullRequests = (
  repository: RepositoryRef,
  pullRequests: ReadonlyArray<PullRequest>,
  context: Option.Option<string> = Option.none(),
): string => {
  const contextLabel = Option.match(context, {
    onNone: () => "",
    onSome: (label) => ` (${label})`,
  });
  const heading = `${formatRepositoryRef(repository)}${contextLabel} - ${pullRequests.length} PR${pullRequests.length === 1 ? "" : "s"}`;

  if (pullRequests.length === 0) {
    return `${heading}\n\nBrak PR-ów dla wybranych filtrów.`;
  }

  const rows = pullRequests.map(
    (pullRequest) =>
      `#${pullRequest.number} ${ciLabel(pullRequest.ciStatus)} ${pullRequest.title}\n` +
      `  @${authorLabel(pullRequest.author)} ${pullRequest.headBranch} -> ${pullRequest.baseBranch}${pullRequest.draft ? " - draft" : ""}\n` +
      `  ${pullRequest.url}`,
  );

  return [heading, "", ...rows].join("\n");
};

export const formatStatusChanges = (
  previous: ReadonlyMap<number, CiStatus>,
  current: ReadonlyArray<PullRequest>,
): ReadonlyArray<string> =>
  current.flatMap((pullRequest) => {
    const previousStatus = previous.get(pullRequest.number);

    if (
      previousStatus === undefined ||
      previousStatus === pullRequest.ciStatus
    ) {
      return [];
    }

    return [
      `#${pullRequest.number} ${pullRequest.title}: ${ciLabel(previousStatus)} -> ${ciLabel(
        pullRequest.ciStatus,
      )}`,
    ];
  });
