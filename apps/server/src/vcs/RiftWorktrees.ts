/**
 * Thread worktrees backed by Rift (https://github.com/anomalyco/rift), the
 * `worktreeProvider: "rift"` alternative to `git worktree add`.
 *
 * A Rift workspace is a copy-on-write snapshot of the whole project folder,
 * `.git` included, so it carries ignored files (`.env`, caches) but is an
 * independent repository rather than a linked worktree. Two rules follow:
 * after creating one we put it on the thread's branch at the requested ref,
 * like a fresh worktree; and before removing one we fetch that branch back
 * into the main checkout, because otherwise its commits leave with it. That
 * fetch is also what lets a resumed thread recreate the workspace from its
 * branch, exactly as it does for a removed git worktree.
 *
 * We talk to Rift through `rift rpc`, its JSON request/response interface,
 * and leave `rift init` to the user: on btrfs it converts the folder in place.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  GitCommandError,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type VcsError,
  type VcsRemoveWorktreeInput,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerConfig from "../config.ts";
import { resolveWorktreesDirectory } from "../worktreesDirectory.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

/** Hooks in `.rift.toml` (for example `pnpm install`) run inside the call. */
const RIFT_TIMEOUT_MS = 10 * 60_000;
const RIFT_MARKER_FILE = ".rift";

const RiftFailure = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  hook: Schema.optional(Schema.String),
  committed: Schema.optional(Schema.Boolean),
});

const RiftResponse = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ok"), value: Schema.Unknown }),
  Schema.Struct({ status: Schema.Literal("error"), error: RiftFailure }),
]);
const encodeRiftRequest = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeRiftResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(RiftResponse));
const decodePath = Schema.decodeUnknownEffect(Schema.String);
const decodePaths = Schema.decodeUnknownEffect(Schema.Array(Schema.String));

const RIFT_HINTS: Partial<Record<string, string>> = {
  workspace_not_initialized:
    "This project is not a Rift workspace yet. Run `rift init` in the project folder, or switch the worktree provider back to Git.",
  initialization_required:
    "Rift needs this folder initialized first. Run `rift init` in the project folder.",
  missing_marker:
    "This Rift workspace is missing its `.rift` marker. Run `rift init` in the project folder to restore it.",
  unsafe_git:
    "Rift won't snapshot this repository right now (a merge, rebase or lock is in progress, or it is a linked git worktree).",
  cow_unavailable:
    "Rift can't make a copy-on-write snapshot here. The worktrees folder must be on the same filesystem as the project; change it in Settings → Storage.",
};

export interface RiftCreateOptions {
  readonly worktreesDirectory?: string;
  readonly onWorktreeClaimed?: (path: string) => Effect.Effect<void, never>;
}

export class RiftWorktrees extends Context.Service<
  RiftWorktrees,
  {
    /** Snapshots the project with Rift and checks out the thread's branch in the copy. */
    readonly createWorktree: (
      input: VcsCreateWorktreeInput,
      options?: RiftCreateOptions,
    ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
    /**
     * True when `path` is a workspace Rift created. A registered source root
     * (a project folder after `rift init`) is not one, so it is never removed.
     */
    readonly ownsWorktree: (path: string) => Effect.Effect<boolean, GitCommandError>;
    /** Keeps the checked-out branch in the main checkout, then moves the workspace to Rift's trash. */
    readonly removeWorktree: (
      input: VcsRemoveWorktreeInput,
    ) => Effect.Effect<void, GitCommandError>;
  }
>()("t3/vcs/RiftWorktrees") {}

export const make = Effect.gen(function* () {
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { worktreesDir } = yield* ServerConfig.ServerConfig;

  const failure = (operation: string, cwd: string, detail: string) =>
    new GitCommandError({ operation, command: "rift rpc", cwd, detail });

  const fromProcessError = (operation: string, cwd: string) => (error: VcsError) =>
    failure(
      operation,
      cwd,
      error._tag === "VcsProcessSpawnError"
        ? "Rift is not installed or not on PATH. Install it with `npm install -g rift-snapshot`."
        : error.message,
    );

  /** One `rift rpc` request. A failed post-hook still returns: the work it followed is done. */
  const rpc = Effect.fn("RiftWorktrees.rpc")(function* (
    operation: string,
    cwd: string,
    request: Record<string, unknown>,
  ) {
    const output = yield* vcsProcess
      .run({
        operation,
        command: "rift",
        args: ["rpc"],
        cwd,
        stdin: encodeRiftRequest(request),
        timeoutMs: RIFT_TIMEOUT_MS,
      })
      .pipe(Effect.mapError(fromProcessError(operation, cwd)));
    const response = yield* decodeRiftResponse(output.stdout).pipe(
      Effect.mapError(() => failure(operation, cwd, "Rift returned an invalid response.")),
    );
    if (response.status === "ok") return response.value;
    const error = response.error;
    if (error.committed === true) {
      yield* Effect.logWarning("Rift hook failed after the operation completed", {
        operation,
        hook: error.hook,
        message: error.message,
      });
      return null;
    }
    return yield* failure(operation, cwd, RIFT_HINTS[error.code] ?? error.message);
  });

  const runGit = (operation: string, cwd: string, args: ReadonlyArray<string>) =>
    git.execute({ operation, cwd, args });

  const createWorktree: RiftWorktrees["Service"]["createWorktree"] = Effect.fn(
    "RiftWorktrees.createWorktree",
  )(function* (input, options) {
    const targetBranch = input.newRefName ?? input.refName;
    let destination = input.path;
    if (destination === null) {
      // Same layout as git worktrees, so review and storage code that expects
      // thread checkouts under the worktrees folder keeps working.
      const parentDir = resolveWorktreesDirectory(
        options?.worktreesDirectory ?? "",
        worktreesDir,
        path,
        yield* HostProcess.HomeDirectory,
      );
      if (parentDir === null) {
        return yield* failure(
          "RiftWorktrees.createWorktree",
          input.cwd,
          `The worktree location "${options?.worktreesDirectory}" must be an absolute folder on this machine, not a drive root. Change it in Settings → Storage.`,
        );
      }
      destination = path.join(
        parentDir,
        path.basename(input.cwd),
        targetBranch.replace(/\//g, "-"),
      );
    }

    const created = yield* rpc("RiftWorktrees.createWorktree", input.cwd, {
      command: "create",
      from: input.cwd,
      into: path.dirname(destination),
      name: path.basename(destination),
    });
    // A failed postcreate hook leaves the workspace registered at the requested path.
    const worktreePath =
      created === null
        ? destination
        : yield* decodePath(created).pipe(
            Effect.mapError(() =>
              failure("RiftWorktrees.createWorktree", input.cwd, "Rift returned an invalid path."),
            ),
          );
    if (options?.onWorktreeClaimed) yield* options.onWorktreeClaimed(worktreePath);

    // The snapshot holds the main checkout's HEAD and edits. Start the thread
    // from the requested ref like a fresh worktree; `clean -fd` drops
    // untracked files but keeps ignored ones, which are the point of Rift.
    yield* runGit(
      "RiftWorktrees.createWorktree.switch",
      worktreePath,
      input.newRefName
        ? ["switch", "--discard-changes", "--create", input.newRefName, input.refName]
        : ["switch", "--discard-changes", input.refName],
    );
    yield* runGit("RiftWorktrees.createWorktree.clean", worktreePath, ["clean", "-fd", "--quiet"]);

    if (input.newRefName && input.baseRefName) {
      // A checkout can start at a commit or tag, but a PR must target a branch.
      const baseBranch = yield* git.resolveBranchName(worktreePath, input.baseRefName);
      if (baseBranch) {
        yield* runGit("RiftWorktrees.createWorktree.configureBaseRef", worktreePath, [
          "config",
          `branch.${input.newRefName}.gh-merge-base`,
          baseBranch,
        ]);
      }
    }

    return { worktree: { path: worktreePath, refName: targetBranch } };
  });

  const ownsWorktree: RiftWorktrees["Service"]["ownsWorktree"] = Effect.fn(
    "RiftWorktrees.ownsWorktree",
  )(function* (worktreePath) {
    const marked = yield* fileSystem
      .exists(path.join(worktreePath, RIFT_MARKER_FILE))
      .pipe(Effect.orElseSucceed(() => false));
    if (!marked) return false;
    const ancestors = yield* rpc("RiftWorktrees.ownsWorktree", worktreePath, {
      command: "ancestors",
      of: worktreePath,
    }).pipe(Effect.flatMap((value) => decodePaths(value).pipe(Effect.orElseSucceed(() => []))));
    return ancestors.length > 0;
  });

  const removeWorktree: RiftWorktrees["Service"]["removeWorktree"] = Effect.fn(
    "RiftWorktrees.removeWorktree",
  )(function* (input) {
    // `rift remove` trashes the whole subtree; never take a user's own rifts with it.
    const children = yield* rpc("RiftWorktrees.removeWorktree", input.cwd, {
      command: "list",
      of: input.path,
    }).pipe(Effect.flatMap((value) => decodePaths(value).pipe(Effect.orElseSucceed(() => []))));
    if (children.length > 0) {
      return yield* failure(
        "RiftWorktrees.removeWorktree",
        input.cwd,
        "This Rift workspace has its own child workspaces. Remove them first.",
      );
    }

    const head = yield* git.execute({
      operation: "RiftWorktrees.removeWorktree.branch",
      cwd: input.path,
      args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
      allowNonZeroExit: true,
    });
    const branch = head.exitCode === 0 ? head.stdout.trim() : "";
    if (branch !== "") {
      // Not forced: a diverged branch in the main checkout keeps the workspace.
      yield* runGit("RiftWorktrees.removeWorktree.keepBranch", input.cwd, [
        "fetch",
        "--quiet",
        "--no-tags",
        input.path,
        `refs/heads/${branch}:refs/heads/${branch}`,
      ]).pipe(
        Effect.mapError(() =>
          failure(
            "RiftWorktrees.removeWorktree",
            input.cwd,
            `Couldn't copy branch "${branch}" back to the main checkout (it may have diverged or be checked out there), so the Rift workspace was kept.`,
          ),
        ),
      );
    }

    yield* rpc("RiftWorktrees.removeWorktree", input.cwd, { command: "remove", at: input.path });
  });

  return RiftWorktrees.of({ createWorktree, ownsWorktree, removeWorktree });
});

export const layer = Layer.effect(RiftWorktrees, make);
