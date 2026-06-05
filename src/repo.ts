import { Data, Effect } from "effect";
import { execFileSync } from "node:child_process";
import type { RepositoryRef } from "./types.js";

/** Error returned when a repository reference cannot be parsed as GitHub owner/repo. */
export class InvalidRepositoryError extends Data.TaggedError(
  "InvalidRepositoryError",
)<{
  readonly input: string;
  readonly message: string;
}> {}

/** Error returned when the current git repository cannot be detected. */
export class RepositoryDetectionError extends Data.TaggedError(
  "RepositoryDetectionError",
)<{
  readonly message: string;
}> {}

/** Error returned when the current git branch cannot be detected. */
export class CurrentBranchDetectionError extends Data.TaggedError(
  "CurrentBranchDetectionError",
)<{
  readonly message: string;
}> {}

const repositoryRefPattern = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const httpsGithubRemotePattern =
  /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/;
const sshGithubRemotePattern = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/;

/** Formats a repository reference as `owner/repo`. */
export const formatRepositoryRef = (repository: RepositoryRef): string =>
  `${repository.owner}/${repository.repo}`;

/** Parses a user-provided `owner/repo` repository reference. */
export const parseRepositoryRef = (
  input: string,
): Effect.Effect<RepositoryRef, InvalidRepositoryError> => {
  const trimmedInput = input.trim();
  const match = repositoryRefPattern.exec(trimmedInput);
  const owner = match?.[1];
  const repo = match?.[2];

  if (owner === undefined || repo === undefined) {
    return Effect.fail(
      new InvalidRepositoryError({
        input,
        message: "Podaj repozytorium jako owner/repo, np. vercel/next.js.",
      }),
    );
  }

  return Effect.succeed({ owner, repo });
};

/** Parses supported GitHub remote URLs into an `owner/repo` reference. */
export const parseGitHubRemote = (
  input: string,
): Effect.Effect<RepositoryRef, InvalidRepositoryError> => {
  const trimmedInput = input.trim();
  const httpsMatch = httpsGithubRemotePattern.exec(trimmedInput);
  const sshMatch = sshGithubRemotePattern.exec(trimmedInput);
  const match = httpsMatch ?? sshMatch;
  const owner = match?.[1];
  const repo = match?.[2];

  if (owner === undefined || repo === undefined) {
    return Effect.fail(
      new InvalidRepositoryError({
        input,
        message: "Nie umiem wyczytać owner/repo z remote origin GitHuba.",
      }),
    );
  }

  return Effect.succeed({ owner, repo });
};

/** Detects the current repository from `git remote origin`. */
export const detectRepositoryFromGit = (): Effect.Effect<
  RepositoryRef,
  RepositoryDetectionError | InvalidRepositoryError
> =>
  Effect.gen(function* () {
    const remote = yield* Effect.try({
      try: () =>
        execFileSync("git", ["config", "--get", "remote.origin.url"], {
          encoding: "utf8",
        }).trim(),
      catch: () =>
        new RepositoryDetectionError({
          message:
            "Nie wykryłem repozytorium. Uruchom w git repo albo podaj owner/repo.",
        }),
    });

    return yield* parseGitHubRemote(remote);
  });

/** Detects the currently checked-out git branch. */
export const detectCurrentBranchFromGit = (): Effect.Effect<
  string,
  CurrentBranchDetectionError
> =>
  Effect.gen(function* () {
    const branch = yield* Effect.try({
      try: () =>
        execFileSync("git", ["branch", "--show-current"], {
          encoding: "utf8",
        }).trim(),
      catch: () =>
        new CurrentBranchDetectionError({
          message: "Nie wykryłem aktualnego brancha git.",
        }),
    });

    if (branch.length === 0) {
      return yield* Effect.fail(
        new CurrentBranchDetectionError({
          message: "Nie wykryłem aktualnego brancha git.",
        }),
      );
    }

    return branch;
  });
