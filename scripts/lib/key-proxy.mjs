// A loopback proxy that holds a cloud provider's API key, so pi runs without it.
//
// The model under test has bash, and anything pi can read the model can read:
// the sandbox profile wraps pi, so pi's bash tool inherits it, and the tool's
// environment is a copy of pi's (getShellEnv spreads process.env). A key in
// the agent dir's auth.json, in an environment variable or on pi's command
// line is one `cat`, `printenv` or `ps` away. Gemma 4 26B-A4B listed
// `../agent/auth.json` with `ls -R ..` on 2026-09-29.
//
// So the key stays in the harness process. pi gets a models.json that points
// the provider at this proxy on 127.0.0.1 with PROXY_TOKEN as its key; the
// proxy swaps the token for the real key and forwards the request upstream.
// This is the gateway pattern pi's own docs describe (docs/containerization.md,
// OpenShell). The model can still send requests through the proxy, which bills
// the key, but it cannot read the key.
//
// The swap is in the auth header only, and only on an exact match. The model
// can read the token in models.json; were it swapped in the path, the query or
// any header, a request could place the key where the upstream echoes it back
// (a 404 body, an app-name header). So a provider that takes its key in the
// query string (`?key=`) is not supported.
import { existsSync, readFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/** The API key pi sees. Not a secret: the proxy replaces it. */
export const PROXY_TOKEN = "sandboxed-key-held-by-harness";

/** Headers that describe one connection, not the request: never forwarded. */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "host"]);

/** Where each API sends its key: openai-completions, anthropic-messages, google-generative-ai. */
const AUTH_VALUES = { authorization: (key) => `Bearer ${key}`, "x-api-key": (key) => key, "x-goog-api-key": (key) => key };

const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});

/**
 * The provider's API key, the way pi resolves it for a plain API-key
 * credential: auth.json first, then `<PROVIDER>_API_KEY`. An OAuth credential
 * is refused: its token expires, and refreshing it would write to the real
 * auth.json.
 */
export function providerKey(provider, authFile, env) {
  let auth;
  try {
    auth = readJson(authFile);
  } catch {
    // Not the parser's message: it quotes the text around the fault.
    throw new Error(`${authFile} is not valid JSON`);
  }
  const entry = auth[provider];
  if (entry?.type === "api_key" && typeof entry.key === "string" && entry.key) return entry.key;
  if (entry) throw new Error(`${authFile}: the ${provider} credential is ${entry.type ?? "of unknown type"}, not an API key`);
  const name = `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
  if (env[name]) return env[name];
  throw new Error(`no ${provider} key in ${authFile} or $${name} — run \`pi\` and /login first`);
}

/**
 * Where the provider's requests go: its baseUrl in models.json, else the one
 * the model carries in pi's catalogue cache (models-store.json).
 */
export function upstreamBaseUrl(model, models, storeFile) {
  const [provider, ...rest] = model.split("/");
  const declared = models.providers?.[provider]?.baseUrl;
  if (declared) return declared;
  const cached = readJson(storeFile)[provider]?.models ?? [];
  const entry = cached.find((m) => m.id === rest.join("/")) ?? cached.find((m) => m.baseUrl);
  if (entry?.baseUrl) return entry.baseUrl;
  throw new Error(`no baseUrl for ${provider} in models.json or ${storeFile} — declare providers.${provider}.baseUrl in --models-json`);
}

/**
 * models.json for a proxied run: the provider under test only, pointed at the
 * proxy with PROXY_TOKEN as its key. Every other provider is dropped, since a
 * provider entry can carry a literal key. Custom headers are refused: they can
 * carry a secret too, and the proxy would pass it through unchanged.
 */
export function proxiedModels(models, provider, baseUrl) {
  const entry = models.providers?.[provider] ?? {};
  if (entry.headers) throw new Error(`models.json: providers.${provider}.headers is not supported through the key proxy`);
  return { ...models, providers: { [provider]: { ...entry, baseUrl, apiKey: PROXY_TOKEN } } };
}

/**
 * Start the proxy on 127.0.0.1. Requests keep their path and go to the
 * upstream's origin. An auth header whose value is exactly the token's
 * (`Bearer <PROXY_TOKEN>`, or PROXY_TOKEN for x-api-key and x-goog-api-key)
 * gets the key instead; nothing else is changed. Bodies are piped both ways,
 * never buffered, so a streamed (SSE) response arrives as it is produced.
 *
 * @returns {Promise<{ port: number, baseUrl: string, close: () => Promise<void> }>}
 *   `baseUrl` is the upstream's baseUrl with the proxy's origin.
 */
export function startKeyProxy({ upstream, key }) {
  const target = new URL(upstream);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  const swap = (name, value) => (AUTH_VALUES[name]?.(PROXY_TOKEN) === value ? AUTH_VALUES[name](key) : value);
  const endToEnd = (headers) => Object.entries(headers).filter(([name, value]) => !HOP_BY_HOP.has(name) && value !== undefined);
  const server = createServer((req, res) => {
    const headers = Object.fromEntries(endToEnd(req.headers).map(([name, value]) => [name, swap(name, value)]));
    const out = send(new URL(req.url, target.origin), { method: req.method, headers }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, Object.fromEntries(endToEnd(upstreamRes.headers)));
      upstreamRes.pipe(res);
    });
    // The error names the failure (ECONNREFUSED, ENOTFOUND), never the request.
    out.on("error", (error) => {
      if (res.headersSent) res.destroy();
      else res.writeHead(502, { "content-type": "text/plain" }).end(`key proxy: upstream ${target.host} failed (${error.code ?? "error"})\n`);
    });
    req.pipe(out);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const baseUrl = `http://127.0.0.1:${port}${target.pathname.replace(/\/$/, "")}`;
      const close = () =>
        new Promise((done) => {
          server.closeAllConnections();
          server.close(() => done());
        });
      resolve({ port, baseUrl, close });
    });
  });
}
