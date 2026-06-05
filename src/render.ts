import { Option } from "effect";
import { formatRepositoryRef } from "./repo.js";
import type { CiStatus, PullRequest, RepositoryRef } from "./types.js";

const statusOrder: ReadonlyMap<CiStatus, number> = new Map([
  ["failing", 0],
  ["action-required", 1],
  ["pending", 2],
  ["no-checks", 3],
  ["passing", 4],
]);

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

const ciBadge = (status: CiStatus): string => {
  switch (status) {
    case "passing":
      return "PASS";
    case "failing":
      return "FAIL";
    case "pending":
      return "PENDING";
    case "action-required":
      return "ACTION";
    case "no-checks":
      return "NO CI";
  }
};

const shouldUseColor = (): boolean =>
  process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

const colorize = (code: string, text: string): string =>
  shouldUseColor() ? `\u001B[${code}m${text}\u001B[0m` : text;

const statusColor = (status: CiStatus, text: string): string => {
  switch (status) {
    case "passing":
      return colorize("32", text);
    case "failing":
      return colorize("31", text);
    case "pending":
      return colorize("33", text);
    case "action-required":
      return colorize("35", text);
    case "no-checks":
      return colorize("90", text);
  }
};

const muted = (text: string): string => colorize("90", text);

const authorLabel = (author: Option.Option<string>): string =>
  Option.match(author, {
    onNone: () => "unknown",
    onSome: (login) => login,
  });

const pluralPullRequests = (count: number): string =>
  `${count} PR${count === 1 ? "" : "s"}`;

const statusRank = (status: CiStatus): number => statusOrder.get(status) ?? 99;

const sortByActionability = (
  pullRequests: ReadonlyArray<PullRequest>,
): ReadonlyArray<PullRequest> =>
  pullRequests
    .map((pullRequest, index) => ({ pullRequest, index }))
    .sort((left, right) => {
      const rankDiff =
        statusRank(left.pullRequest.ciStatus) -
        statusRank(right.pullRequest.ciStatus);

      return rankDiff === 0 ? left.index - right.index : rankDiff;
    })
    .map(({ pullRequest }) => pullRequest);

const statusSummary = (pullRequests: ReadonlyArray<PullRequest>): string => {
  const counts = new Map<CiStatus, number>();

  for (const pullRequest of pullRequests) {
    counts.set(
      pullRequest.ciStatus,
      (counts.get(pullRequest.ciStatus) ?? 0) + 1,
    );
  }

  return Array.from(statusOrder.keys())
    .flatMap((status) => {
      const count = counts.get(status) ?? 0;
      return count > 0 ? [`${count} ${ciLabel(status)}`] : [];
    })
    .join(", ");
};

/**
 * Formats a PR snapshot for terminal output, prioritizing actionable CI states first.
 */
export const formatPullRequests = (
  repository: RepositoryRef,
  pullRequests: ReadonlyArray<PullRequest>,
  context: Option.Option<string> = Option.none(),
): string => {
  const contextLabel = Option.match(context, {
    onNone: () => "",
    onSome: (label) => ` (${label})`,
  });
  const heading = `${formatRepositoryRef(repository)}${contextLabel}`;
  const summary = statusSummary(pullRequests);
  const countLine = `${pluralPullRequests(pullRequests.length)}${summary.length > 0 ? ` - ${summary}` : ""}`;

  if (pullRequests.length === 0) {
    return `${heading}\n${countLine}\n\nBrak PR-ów dla wybranych filtrów.`;
  }

  const rows = sortByActionability(pullRequests).map((pullRequest) => {
    const badge = statusColor(
      pullRequest.ciStatus,
      ciBadge(pullRequest.ciStatus).padEnd(7, " "),
    );
    const draftLabel = pullRequest.draft ? muted(" [draft]") : "";

    return (
      `${badge} #${pullRequest.number} ${pullRequest.title}${draftLabel}\n` +
      `  @${authorLabel(pullRequest.author)}  ${pullRequest.headBranch} -> ${pullRequest.baseBranch}\n` +
      `  ${muted(pullRequest.url)}`
    );
  });

  return [heading, countLine, "", ...rows].join("\n");
};

/**
 * Formats only PRs whose CI status changed between polling iterations.
 */
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
      `CHANGE #${pullRequest.number} ${pullRequest.title}: ${ciLabel(previousStatus)} -> ${ciLabel(
        pullRequest.ciStatus,
      )}`,
    ];
  });
