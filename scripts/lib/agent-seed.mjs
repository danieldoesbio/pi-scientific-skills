// The seed agent dir for a live run (scripts/test-find-live.mjs).
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * An agent dir holding nothing but this package, its skills filter set to
 * `promptSkills`: empty (the configuration `/sci search` writes since 1.7.0,
 * so the run tests the shipped default; sci_find the only way in), the Core
 * profile (what `/sci search` wrote before 1.7.0), or `null` for no filter
 * (every skill listed). `extension: false` loads no extension (`extensions:
 * []`, pi's "none of this type"), so sci_find, /sci and the input hook are
 * absent — a plain skills install.
 *
 * `codemode` is null (pi's default: no codemode tool), "on" or "only"
 * (pi 0.99+): `defaultTools: ["+codemode"]` adds the tool next to pi's
 * defaults, and `codemode.mode` says how it presents the others. With "only",
 * requests declare codemode alone and the model reaches read, bash and
 * sci_find through scripts (pi's docs/settings.md, "Tools").
 *
 * `models` is written as models.json: it declares custom providers (a local
 * Ollama or MLX server, or the key proxy for a cloud one), and without it the
 * model is not found at all. `catalogue`, if given, is copied in as
 * models-store.json, pi's cache of a cloud provider's model list; it holds no
 * credentials.
 *
 * No credentials are ever copied in. The model can read anything in its own
 * agent dir, so a cloud key stays in the harness (scripts/lib/key-proxy.mjs).
 *
 * This is the SEED: each attempt gets its own copy, so nothing a run writes
 * there — pi's own state, or a model editing settings.json — reaches the next
 * one. The seed itself is outside every sandbox.
 */
export function seedAgentDir(agentDir, { packageDir, promptSkills, extension, models, catalogue, codemode = null }) {
  mkdirSync(agentDir, { recursive: true });
  const entry = {
    source: packageDir,
    ...(promptSkills !== null && { skills: promptSkills }),
    ...(!extension && { extensions: [] }),
  };
  const settings = {
    packages: [entry],
    ...(codemode && { defaultTools: ["+codemode"], codemode: { mode: codemode } }),
  };
  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
  if (models) writeFileSync(join(agentDir, "models.json"), `${JSON.stringify(models, null, 2)}\n`, { mode: 0o600 });
  if (catalogue && existsSync(catalogue)) {
    copyFileSync(catalogue, join(agentDir, "models-store.json"));
    chmodSync(join(agentDir, "models-store.json"), 0o600);
  }
  return agentDir;
}
