import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as RiftWorktrees from "./RiftWorktrees.ts";
import { withFakeRift } from "./testing/fakeRift.ts";
import * as VcsProcess from "./VcsProcess.ts";

const layerTest = RiftWorktrees.layer.pipe(
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-rift-worktrees-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({ operation: "RiftWorktrees.test", cwd, args });
    return result.stdout.trim();
  });

/** A repository with a commit, an ignored `.env`, an untracked file and an uncommitted edit. */
const makeSource = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-rift-" });
  const source = path.join(root, "app");
  yield* fs.makeDirectory(source);
  yield* git(source, ["init", "--initial-branch=main"]);
  yield* git(source, ["config", "user.email", "test@example.com"]);
  yield* git(source, ["config", "user.name", "Test User"]);
  yield* fs.writeFileString(path.join(source, ".gitignore"), ".env\n");
  yield* fs.writeFileString(path.join(source, "README.md"), "committed\n");
  yield* git(source, ["add", "."]);
  yield* git(source, ["commit", "-m", "initial"]);
  yield* fs.writeFileString(path.join(source, ".env"), "SECRET=1\n");
  yield* fs.writeFileString(path.join(source, "scratch.txt"), "untracked\n");
  yield* fs.writeFileString(path.join(source, "README.md"), "uncommitted edit\n");
  return { source, worktreesDirectory: path.join(root, "worktrees") };
});

it.layer(layerTest)("RiftWorktrees", (it) => {
  it.effect("starts the snapshot on the thread branch and keeps only ignored files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rift = yield* withFakeRift;
      const worktrees = yield* RiftWorktrees.RiftWorktrees;
      const { source, worktreesDirectory } = yield* makeSource;
      yield* rift.init(source);

      const created = yield* worktrees.createWorktree(
        { cwd: source, refName: "main", newRefName: "t3code/abc", baseRefName: "main", path: null },
        { worktreesDirectory },
      );
      const workspace = created.worktree.path;

      assert.equal(workspace, path.join(worktreesDirectory, "app", "t3code-abc"));
      assert.equal(created.worktree.refName, "t3code/abc");
      assert.equal(yield* git(workspace, ["branch", "--show-current"]), "t3code/abc");
      assert.equal(yield* fs.readFileString(path.join(workspace, ".env")), "SECRET=1\n");
      assert.equal(yield* fs.readFileString(path.join(workspace, "README.md")), "committed\n");
      assert.isFalse(yield* fs.exists(path.join(workspace, "scratch.txt")));
      assert.equal(yield* git(workspace, ["config", "branch.t3code/abc.gh-merge-base"]), "main");
      assert.isTrue(yield* worktrees.ownsWorktree(workspace));
      // The source root is registered with Rift too, but never ours to remove.
      assert.isFalse(yield* worktrees.ownsWorktree(source));
    }).pipe(Effect.scoped),
  );

  it.effect("copies the branch back to the main checkout before removing the workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rift = yield* withFakeRift;
      const worktrees = yield* RiftWorktrees.RiftWorktrees;
      const { source, worktreesDirectory } = yield* makeSource;
      yield* rift.init(source);
      const created = yield* worktrees.createWorktree(
        { cwd: source, refName: "main", newRefName: "feature/x", path: null },
        { worktreesDirectory },
      );
      const workspace = created.worktree.path;
      yield* fs.writeFileString(path.join(workspace, "feature.txt"), "work\n");
      yield* git(workspace, ["add", "feature.txt"]);
      yield* git(workspace, ["commit", "-m", "thread work"]);
      const head = yield* git(workspace, ["rev-parse", "HEAD"]);

      yield* worktrees.removeWorktree({ cwd: source, path: workspace, force: true });

      assert.isFalse(yield* fs.exists(workspace));
      assert.equal(yield* git(source, ["rev-parse", "refs/heads/feature/x"]), head);

      // A resumed thread recreates the workspace from the kept branch.
      const recreated = yield* worktrees.createWorktree(
        { cwd: source, refName: "feature/x", path: workspace },
        { worktreesDirectory },
      );
      assert.equal(recreated.worktree.path, workspace);
      assert.equal(yield* git(workspace, ["rev-parse", "HEAD"]), head);
      assert.equal(yield* git(workspace, ["branch", "--show-current"]), "feature/x");
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a workspace whose branch diverged from the main checkout", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rift = yield* withFakeRift;
      const worktrees = yield* RiftWorktrees.RiftWorktrees;
      const { source, worktreesDirectory } = yield* makeSource;
      yield* rift.init(source);
      const created = yield* worktrees.createWorktree(
        { cwd: source, refName: "main", newRefName: "feature/y", path: null },
        { worktreesDirectory },
      );
      const workspace = created.worktree.path;
      yield* git(workspace, ["commit", "--allow-empty", "-m", "in workspace"]);
      yield* git(source, ["branch", "feature/y", "main"]);
      yield* git(source, ["commit", "--allow-empty", "-m", "elsewhere"]);
      yield* git(source, ["branch", "--force", "feature/y", "HEAD"]);

      const result = yield* worktrees
        .removeWorktree({ cwd: source, path: workspace, force: true })
        .pipe(Effect.flip);

      assert.include(result.detail, 'Couldn\'t copy branch "feature/y"');
      assert.isTrue(yield* fs.exists(path.join(workspace, ".rift")));
    }).pipe(Effect.scoped),
  );

  it.effect("refuses to remove a workspace with its own child workspaces", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const rift = yield* withFakeRift;
      const worktrees = yield* RiftWorktrees.RiftWorktrees;
      const { source, worktreesDirectory } = yield* makeSource;
      yield* rift.init(source);
      const parent = yield* worktrees.createWorktree(
        { cwd: source, refName: "main", newRefName: "parent", path: null },
        { worktreesDirectory },
      );
      yield* worktrees.createWorktree(
        { cwd: parent.worktree.path, refName: "main", newRefName: "child", path: null },
        { worktreesDirectory },
      );

      const result = yield* worktrees
        .removeWorktree({ cwd: source, path: parent.worktree.path, force: true })
        .pipe(Effect.flip);

      assert.include(result.detail, "child workspaces");
      assert.isTrue(yield* fs.exists(parent.worktree.path));
    }).pipe(Effect.scoped),
  );

  it.effect("tells the user to run rift init in an uninitialized project", () =>
    Effect.gen(function* () {
      yield* withFakeRift;
      const worktrees = yield* RiftWorktrees.RiftWorktrees;
      const { source, worktreesDirectory } = yield* makeSource;

      const result = yield* worktrees
        .createWorktree(
          { cwd: source, refName: "main", newRefName: "t3code/abc", path: null },
          { worktreesDirectory },
        )
        .pipe(Effect.flip);

      assert.include(result.detail, "rift init");
    }).pipe(Effect.scoped),
  );
});
