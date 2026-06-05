import type { Option } from "effect";

export interface RepositoryRef {
  readonly owner: string;
  readonly repo: string;
}

export type PullRequestState = "open" | "all";

export type CiStatus =
  | "passing"
  | "failing"
  | "pending"
  | "action-required"
  | "no-checks";

export type CiCheckStatus = Exclude<CiStatus, "no-checks">;

export interface CiCheck {
  readonly name: string;
  readonly status: CiCheckStatus;
  readonly url: Option.Option<string>;
}

export interface PullRequestFilters {
  readonly state: PullRequestState;
  readonly base: Option.Option<string>;
  readonly head: Option.Option<string>;
  readonly author: Option.Option<string>;
}

export interface PullRequest {
  readonly number: number;
  readonly title: string;
  readonly author: Option.Option<string>;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly url: string;
  readonly draft: boolean;
  readonly headSha: string;
  readonly ciStatus: CiStatus;
  readonly ciChecks: ReadonlyArray<CiCheck>;
}

export type PullRequestWithoutCi = Omit<PullRequest, "ciStatus" | "ciChecks">;

export type CliMode = "once" | "watch" | "wait";
export type AuthorScope = "all-authors" | "mine";
export type PullRequestFocus = "auto" | "repository" | "current-branch";

export interface CliOptions {
  readonly repositoryInput: Option.Option<string>;
  readonly mode: CliMode;
  readonly focus: PullRequestFocus;
  readonly authorScope: AuthorScope;
  readonly state: PullRequestState;
  readonly base: Option.Option<string>;
  readonly intervalSeconds: number;
}

export type CliParseResult =
  | { readonly _tag: "Help" }
  | { readonly _tag: "Auth" }
  | { readonly _tag: "Run"; readonly options: CliOptions };
