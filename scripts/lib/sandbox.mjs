// A macOS sandbox-exec profile for one live pi run.
//
// The live tests give the model pi's default tools, bash included, and the
// probe tasks read like real requests ("review my recent screen activity"). A
// model that acts on one will search the real home directory. The profile
// keeps every read and write inside the run's own directories, and keeps the
// network on one loopback port: the model's own endpoint when it is local, or
// the harness's key proxy for a cloud provider (scripts/lib/key-proxy.mjs).
//
// SBPL matches real paths, so every path is resolved first: /var and /tmp are
// symlinks into /private, and a rule on the symlink matches nothing.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** Trees no probe needs: the real home, other volumes, and the shared temp dirs. */
const PRIVATE_ROOTS = ["/Users", "/Volumes", "/private/var/folders", "/private/tmp"];

/**
 * Programs that act through another process, outside this sandbox: launchd
 * starts a loaded job unsandboxed, `open` asks LaunchServices to start an app
 * or a URL, and Apple events drive running apps. A model asked for "a
 * recurring check" tried `launchctl load` (parallel-web, 2026-09-23).
 */
const HOST_CONTROL = ["/bin/launchctl", "/usr/bin/open", "/usr/bin/osascript", "/usr/bin/automator", "/usr/bin/shortcuts"];

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function sandboxAvailable() {
  return existsSync(SANDBOX_EXEC);
}

/**
 * pi's environment: an allowlist, not a copy of ours. The model can run
 * `printenv`, and the parent environment carries API keys, session tokens, an
 * SSH agent socket and paths into the real home. No run needs a key here: a
 * local model takes none, and a cloud model's key stays in the harness
 * (scripts/lib/key-proxy.mjs).
 */
export function piEnvironment(env) {
  const names = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "SHELL"];
  return Object.fromEntries(Object.entries(env).filter(([name]) => names.includes(name)));
}

/**
 * The network the model needs, read from models.json. A provider declared
 * there with a loopback baseUrl (Ollama, an MLX server) needs only that port.
 * Any other provider is a cloud API whose addresses SBPL cannot name: `open`.
 * The live harness answers that with its key proxy, and fences the network to
 * the proxy's port.
 */
export function networkFor(model, agentDir, file = join(agentDir, "models.json")) {
  const provider = model.split("/")[0];
  if (!existsSync(file)) return { kind: "open" };
  const baseUrl = JSON.parse(readFileSync(file, "utf8")).providers?.[provider]?.baseUrl;
  if (!baseUrl) return { kind: "open" };
  const url = new URL(baseUrl);
  if (!LOOPBACK.has(url.hostname)) return { kind: "open" };
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return { kind: "loopback", port };
}

/** Every directory above `path`, root excluded. */
function ancestors(path) {
  const parts = path.split("/").filter(Boolean);
  return parts.slice(0, -1).map((_, i) => `/${parts.slice(0, i + 1).join("/")}`);
}

/**
 * @param {{ readWrite: string[], readOnly: string[], network: {kind: string, port?: string} }} spec
 *   Paths must exist. Later SBPL rules win, so the allows follow the denies.
 */
export function sandboxProfile({ readWrite, readOnly, network }) {
  const rw = readWrite.map((path) => realpathSync(path));
  const ro = readOnly.map((path) => realpathSync(path));
  // Node's module resolver lstat()s every component of a path, so a denied
  // parent directory makes an allowed file unloadable ("Cannot find module").
  // Metadata only, and only on the exact parents: no listing, no contents.
  const parents = [...new Set([...rw, ...ro].flatMap(ancestors))];
  const lines = [
    "(version 1)",
    "(allow default)",
    ...PRIVATE_ROOTS.map((path) => `(deny file-read* file-write* (subpath "${path}"))`),
    '(deny file-write* (subpath "/"))',
    '(allow file-write* (subpath "/dev"))',
    `(deny process-exec ${HOST_CONTROL.map((path) => `(literal "${path}")`).join(" ")})`,
    "(deny appleevent-send)",
    ...parents.map((path) => `(allow file-read-metadata (literal ${JSON.stringify(path)}))`),
    ...ro.map((path) => `(allow file-read* (subpath ${JSON.stringify(path)}))`),
    ...rw.map((path) => `(allow file-read* file-write* (subpath ${JSON.stringify(path)}))`),
  ];
  if (network.kind === "loopback") {
    lines.push("(deny network*)", `(allow network-outbound (remote ip "localhost:${network.port}"))`);
  }
  return `${lines.join("\n")}\n`;
}
