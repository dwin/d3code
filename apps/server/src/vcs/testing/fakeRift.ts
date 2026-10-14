// @effect-diagnostics nodeBuiltinImport:off - the fake CLI is driven synchronously from tests.
import * as NodeChildProcess from "node:child_process";

import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/**
 * Puts a fake `rift` (see rift.fixture.mjs) first on PATH for the scope.
 * `init` registers a folder as a Rift source root, like `rift init`.
 */
export const withFakeRift = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-fake-rift-" });
  const fixturePath = yield* path.fromFileUrl(new URL("./rift.fixture.mjs", import.meta.url));
  const binDir = path.join(dir, "bin");
  const launcher = writeFakeCli({
    directory: binDir,
    name: "rift",
    platform,
    source: yield* fs.readFileString(fixturePath),
    env: { T3_FAKE_RIFT_REGISTRY: path.join(dir, "registry.json") },
  });
  const delimiter = platform === "win32" ? ";" : ":";
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env.PATH;
      process.env.PATH = `${binDir}${delimiter}${previous ?? ""}`;
      return previous;
    }),
    (previous) =>
      Effect.sync(() => {
        process.env.PATH = previous;
      }),
  );
  return {
    init: (at: string) =>
      Effect.sync(() => {
        NodeChildProcess.execFileSync(launcher, ["rpc"], {
          input: encodeJson({ command: "init", at }),
          shell: platform === "win32",
        });
      }),
  };
});
