import { Data, Effect, Option, Schema } from "effect";
import { execFileSync } from "node:child_process";

import type {
  CiCheck,
  CiStatus,
  PullRequest,
  PullRequestFilters,
  PullRequestWithoutCi,
  RepositoryRef,
} from "./types.js";

/** Error returned when a command needs GitHub auth but no token is available. */
export class GitHubAuthRequiredError extends Data.TaggedError(
  "GitHubAuthRequiredError",
)<{
  readonly message: string;
}> {}

/** Error returned for network-level GitHub API failures. */
export class GitHubNetworkError extends Data.TaggedError("GitHubNetworkError")<{
  readonly message: string;
}> {}

/** Error returned for non-2xx GitHub API responses. */
export class GitHubApiError extends Data.TaggedError("GitHubApiError")<{
  readonly status: number;
  readonly message: string;
}> {}

/** Error returned when GitHub API JSON does not match the expected schema. */
export class GitHubDecodeError extends Data.TaggedError("GitHubDecodeError")<{
  readonly message: string;
}> {}

export type GitHubError =
  | GitHubAuthRequiredError
  | GitHubNetworkError
  | GitHubApiError
  | GitHubDecodeError;

const GitHubUserSchema = Schema.Struct({
  login: Schema.String,
});

const GitHubBranchRefSchema = Schema.Struct({
  ref: Schema.String,
  sha: Schema.String,
});

const GitHubPullRequestSchema = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  user: Schema.NullOr(GitHubUserSchema),
  head: GitHubBranchRefSchema,
  base: GitHubBranchRefSchema,
  html_url: Schema.String,
  draft: Schema.Boolean,
});

const GitHubPullRequestsSchema = Schema.Array(GitHubPullRequestSchema);

const CheckRunConclusionSchema = Schema.Literal(
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
  "stale",
  "startup_failure",
  "success",
  "timed_out",
);

const CheckRunStatusSchema = Schema.Literal(
  "completed",
  "in_progress",
  "pending",
  "queued",
  "requested",
  "waiting",
);

const CheckRunSchema = Schema.Struct({
  name: Schema.String,
  status: CheckRunStatusSchema,
  conclusion: Schema.NullOr(CheckRunConclusionSchema),
  html_url: Schema.NullOr(Schema.String),
});

const CheckRunsResponseSchema = Schema.Struct({
  total_count: Schema.Number,
  check_runs: Schema.Array(CheckRunSchema),
});

type GitHubPullRequest = Schema.Schema.Type<typeof GitHubPullRequestSchema>;
type CheckRun = Schema.Schema.Type<typeof CheckRunSchema>;

type CiSummary = {
  readonly ciStatus: CiStatus;
  readonly ciChecks: ReadonlyArray<CiCheck>;
};

const readTokenFromEnvironment = (): Option.Option<string> => {
  const tokens = [process.env.GITHUB_TOKEN, process.env.GH_TOKEN];

  for (const token of tokens) {
    const trimmedToken = token?.trim();

    if (trimmedToken !== undefined && trimmedToken.length > 0) {
      return Option.some(trimmedToken);
    }
  }

  return Option.none();
};

const readTokenFromGitHubCli = (): Option.Option<string> => {
  try {
    const token = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    return token.length > 0 ? Option.some(token) : Option.none();
  } catch {
    return Option.none();
  }
};

let cachedGitHubCliToken: Option.Option<Option.Option<string>> = Option.none();

/**
 * Reads GitHub auth from env first, then falls back to cached GitHub CLI credentials.
 */
export const readGitHubToken = Effect.sync(() => {
  const environmentToken = readTokenFromEnvironment();

  if (Option.isSome(environmentToken)) {
    return environmentToken;
  }

  if (Option.isSome(cachedGitHubCliToken)) {
    return cachedGitHubCliToken.value;
  }

  const token = readTokenFromGitHubCli();
  cachedGitHubCliToken = Option.some(token);

  return token;
});

const githubHeaders = (token: Option.Option<string>): Headers => {
  const headers = new Headers({
    Accept: "application/vnd.github+json",
    "User-Agent": "pr-watcher",
    "X-GitHub-Api-Version": "2022-11-28",
  });

  if (Option.isSome(token)) {
    headers.set("Authorization", `Bearer ${token.value}`);
  }

  return headers;
};

const githubUrl = (path: string, params: URLSearchParams): string => {
  const query = params.toString();
  return `https://api.github.com${path}${query.length > 0 ? `?${query}` : ""}`;
};

const decodeUnknown = <A, I, R>(
  schema: Schema.Schema<A, I, R>,
  input: unknown,
): Effect.Effect<A, GitHubDecodeError, R> =>
  Schema.decodeUnknown(schema)(input).pipe(
    Effect.mapError(
      (error) =>
        new GitHubDecodeError({
          message: String(error),
        }),
    ),
  );

const fetchJson = <A, I, R>(
  schema: Schema.Schema<A, I, R>,
  url: string,
  token: Option.Option<string>,
): Effect.Effect<A, GitHubError, R> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () => fetch(url, { headers: githubHeaders(token) }),
      catch: (error) =>
        new GitHubNetworkError({
          message:
            error instanceof Error
              ? error.message
              : "Nie udało się połączyć z GitHub API.",
        }),
    });

    if (!response.ok) {
      const message = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: () =>
          new GitHubNetworkError({
            message: response.statusText,
          }),
      }).pipe(Effect.catchAll(() => Effect.succeed(response.statusText)));

      return yield* Effect.fail(
        new GitHubApiError({
          status: response.status,
          message,
        }),
      );
    }

    const json = yield* Effect.tryPromise({
      try: async (): Promise<unknown> => response.json(),
      catch: (error) =>
        new GitHubNetworkError({
          message:
            error instanceof Error
              ? error.message
              : "GitHub API zwróciło niepoprawny JSON.",
        }),
    });

    return yield* decodeUnknown(schema, json);
  });

const apiPullRequestToDomain = (
  pullRequest: GitHubPullRequest,
): PullRequestWithoutCi => ({
  number: pullRequest.number,
  title: pullRequest.title,
  author: Option.fromNullable(pullRequest.user?.login),
  headBranch: pullRequest.head.ref,
  baseBranch: pullRequest.base.ref,
  url: pullRequest.html_url,
  draft: pullRequest.draft,
  headSha: pullRequest.head.sha,
});

const hasFailingConclusion = (checkRun: CheckRun): boolean =>
  checkRun.conclusion === "cancelled" ||
  checkRun.conclusion === "failure" ||
  checkRun.conclusion === "startup_failure" ||
  checkRun.conclusion === "timed_out";

const checkRunToCiCheckStatus = (checkRun: CheckRun): CiCheck["status"] => {
  if (checkRun.status !== "completed") {
    return "pending";
  }

  if (checkRun.conclusion === "action_required") {
    return "action-required";
  }

  if (hasFailingConclusion(checkRun)) {
    return "failing";
  }

  return "passing";
};

const summarizeCheckRuns = (checkRuns: ReadonlyArray<CheckRun>): CiStatus => {
  if (checkRuns.length === 0) {
    return "no-checks";
  }

  if (checkRuns.some((checkRun) => checkRun.status !== "completed")) {
    return "pending";
  }

  if (checkRuns.some((checkRun) => checkRun.conclusion === "action_required")) {
    return "action-required";
  }

  if (checkRuns.some(hasFailingConclusion)) {
    return "failing";
  }

  return "passing";
};

const summarizeCi = (checkRuns: ReadonlyArray<CheckRun>): CiSummary => ({
  ciStatus: summarizeCheckRuns(checkRuns),
  ciChecks: checkRuns.map((checkRun) => ({
    name: checkRun.name,
    status: checkRunToCiCheckStatus(checkRun),
    url: Option.fromNullable(checkRun.html_url),
  })),
});

const listPullRequests = (
  repository: RepositoryRef,
  filters: PullRequestFilters,
  token: Option.Option<string>,
): Effect.Effect<ReadonlyArray<PullRequestWithoutCi>, GitHubError> => {
  const params = new URLSearchParams({
    per_page: "50",
    state: filters.state,
  });

  if (Option.isSome(filters.base)) {
    params.set("base", filters.base.value);
  }

  if (Option.isSome(filters.head)) {
    params.set("head", filters.head.value);
  }

  const url = githubUrl(
    `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/pulls`,
    params,
  );

  return fetchJson(GitHubPullRequestsSchema, url, token).pipe(
    Effect.map((pullRequests) => pullRequests.map(apiPullRequestToDomain)),
  );
};

const listCheckRuns = (
  repository: RepositoryRef,
  headSha: string,
  token: Option.Option<string>,
): Effect.Effect<CiSummary, GitHubError> => {
  const params = new URLSearchParams({
    per_page: "50",
  });
  const url = githubUrl(
    `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/commits/${encodeURIComponent(headSha)}/check-runs`,
    params,
  );

  return fetchJson(CheckRunsResponseSchema, url, token).pipe(
    Effect.map((response) => summarizeCi(response.check_runs)),
  );
};

const matchesAuthor = (
  pullRequest: PullRequestWithoutCi,
  author: Option.Option<string>,
): boolean => {
  if (Option.isNone(author)) {
    return true;
  }

  return (
    Option.isSome(pullRequest.author) &&
    pullRequest.author.value === author.value
  );
};

/**
 * Resolves the login for the token used by filters such as `--mine`.
 */
export const getAuthenticatedLogin = (
  token: Option.Option<string>,
): Effect.Effect<string, GitHubError> => {
  if (Option.isNone(token)) {
    return Effect.fail(
      new GitHubAuthRequiredError({
        message:
          "Opcja --mine wymaga autoryzacji GitHuba. Najprościej uruchom `gh auth login`; pr-watcher automatycznie użyje potem `gh auth token`. Alternatywnie ustaw GITHUB_TOKEN albo GH_TOKEN.",
      }),
    );
  }

  return fetchJson(
    GitHubUserSchema,
    githubUrl("/user", new URLSearchParams()),
    token,
  ).pipe(Effect.map((user) => user.login));
};

/**
 * Lists PRs and enriches each one with a summarized GitHub Checks status.
 */
export const listPullRequestsWithCi = (
  repository: RepositoryRef,
  filters: PullRequestFilters,
): Effect.Effect<ReadonlyArray<PullRequest>, GitHubError> =>
  Effect.gen(function* () {
    const token = yield* readGitHubToken;
    const pullRequests = yield* listPullRequests(repository, filters, token);
    const filteredPullRequests = pullRequests.filter((pullRequest) =>
      matchesAuthor(pullRequest, filters.author),
    );

    return yield* Effect.forEach(
      filteredPullRequests,
      (pullRequest) =>
        listCheckRuns(repository, pullRequest.headSha, token).pipe(
          Effect.map((ciSummary) => ({ ...pullRequest, ...ciSummary })),
        ),
      { concurrency: 4 },
    );
  });
