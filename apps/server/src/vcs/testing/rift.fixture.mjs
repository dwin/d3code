// A stand-in for `rift rpc`: same request and response shapes, but plain
// copies and a JSON registry instead of copy-on-write clones and SQLite.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const registryPath = process.env.T3_FAKE_RIFT_REGISTRY;
const readRegistry = () =>
  NodeFS.existsSync(registryPath) ? JSON.parse(NodeFS.readFileSync(registryPath, "utf8")) : {};
const writeRegistry = (registry) => NodeFS.writeFileSync(registryPath, JSON.stringify(registry));
const respond = (response) => process.stdout.write(JSON.stringify(response));
const fail = (code, message) => respond({ status: "error", error: { code, message } });
const isGit = (dir) => NodeFS.existsSync(NodePath.join(dir, ".git"));
const hideMarker = (dir) =>
  NodeFS.appendFileSync(NodePath.join(dir, ".git", "info", "exclude"), "\n/.rift\n");
const mark = (dir) =>
  NodeFS.writeFileSync(NodePath.join(dir, ".rift"), `${NodePath.basename(dir)}\n`);

const request = JSON.parse(NodeFS.readFileSync(0, "utf8"));
const registry = readRegistry();

switch (request.command) {
  case "init": {
    registry[request.at] = null;
    mark(request.at);
    if (isGit(request.at)) hideMarker(request.at);
    writeRegistry(registry);
    respond({ status: "ok", value: null });
    break;
  }
  case "create": {
    if (!(request.from in registry)) {
      fail("workspace_not_initialized", `${request.from} is not initialized`);
      break;
    }
    const destination = NodePath.join(request.into, request.name);
    if (NodeFS.existsSync(destination)) {
      fail("already_exists", `${destination} already exists`);
      break;
    }
    NodeFS.mkdirSync(request.into, { recursive: true });
    NodeFS.cpSync(request.from, destination, { recursive: true, verbatimSymlinks: true });
    mark(destination);
    if (isGit(destination)) {
      NodeChildProcess.execFileSync("git", ["checkout", "--quiet", "--detach"], {
        cwd: destination,
      });
    }
    registry[destination] = request.from;
    writeRegistry(registry);
    respond({ status: "ok", value: destination });
    break;
  }
  case "ancestors": {
    const ancestors = [];
    for (let parent = registry[request.of]; parent; parent = registry[parent]) {
      ancestors.push(parent);
    }
    respond({ status: "ok", value: ancestors });
    break;
  }
  case "list": {
    const children = Object.keys(registry).filter((child) => registry[child] === request.of);
    respond({ status: "ok", value: children });
    break;
  }
  case "remove": {
    const trash = NodePath.join(NodePath.dirname(request.at), ".trash");
    NodeFS.mkdirSync(trash, { recursive: true });
    NodeFS.renameSync(request.at, NodePath.join(trash, NodePath.basename(request.at)));
    delete registry[request.at];
    writeRegistry(registry);
    respond({ status: "ok", value: null });
    break;
  }
  default:
    fail("invalid_request", `unsupported command ${request.command}`);
}
