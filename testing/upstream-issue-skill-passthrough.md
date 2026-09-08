# Draft upstream issue — not yet filed

Target: https://github.com/earendil-works/pi/issues (packages/coding-agent).
File it from your own account; this file is the text, so the link in
DOCUMENTATION.md can point at the real issue afterwards.

---

**Title:** `/skill:<unknown-name>` is forwarded to the model as literal text instead of erroring

**Version:** pi-coding-agent 0.84.3 (also present in 0.85.1 per source reading)

**What happens**

`AgentSession._expandSkillCommand` (`dist/core/agent-session.js`, 0.84.3 lines
956–978) looks the name up in `resourceLoader.getSkills().skills` and, on a
miss, returns the input unchanged:

```js
const skill = this.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
if (!skill)
    return text; // Unknown skill, pass through
```

So `/skill:typo` or `/skill:<a skill disabled through a package filter>` goes
to the model as the user message `"/skill:typo"`. Nothing is shown to the user.
The model usually replies as if the skill loaded, so the failure is invisible
until the output is wrong.

The same method already has an error path for a *read* failure on a skill that
was found (`emitError` with `event: "skill_expansion"`). The miss branch is the
only silent one.

**Two ways to reach it**

1. A per-package `skills` filter in `settings.json` (or `pi config`) removes the
   skill from the registry entirely (`package-manager.js applyPackageFilter`
   marks it `enabled: false`; `resource-loader.js` keeps only survivors), so any
   filtered-out name misses. Users reasonably expect "disabled from the prompt"
   to still allow an explicit `/skill:` — which is exactly what the documented
   `disable-model-invocation: true` frontmatter flag does — but the filter is a
   different mechanism and removes it from `/skill:` too, silently.
2. `text.indexOf(" ")` splits on the first *space*, not the first whitespace, so
   `/skill:foo\nrest` yields the name `"foo\nrest"` and misses even for a loaded
   skill. Multi-line input pasted after a `/skill:` command therefore also passes
   through as prose.

**Suggested fix**

Treat the miss like the read failure:

```js
if (!skill) {
    this._extensionRunner.emitError({
        extensionPath: "<skill>",
        event: "skill_expansion",
        error: `Unknown skill: ${skillName}`,
    });
    return text;
}
```

and split on `/\s/` rather than `" "`. Both are a few lines and would close the
issue for every package at once; a downstream extension can only patch the
`prompt()` path through the `input` event, and `steer()` / `followUp()` (used by
the compaction queue and RPC `steer`/`follow_up`) call `_expandSkillCommand`
directly with no hook.

**Context**

Found while maintaining `pi-scientific-skills`, which ships 159 skills and
writes a package filter so small models are not charged ~18k tokens of skill
index. An `input`-event stopgap for that package's own skills is in its 1.4.0
release; the limits of that stopgap are documented there.
