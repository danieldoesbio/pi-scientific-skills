#!/usr/bin/env python3
"""Drive pi's real TUI through a pty and check the first-run offer.

Plan item 6 called this "manual", but the load-bearing half is mechanical and
so is checked here instead of trusted: does *accepting* actually write the Core
filter, and do *declining* and *timing out* really write nothing?

That path was silently broken until `expandPromptTemplates: true` landed —
`pi.sendUserMessage` defaults it to false, so the accepted offer was delivered
to the model as the literal text "/sci search" instead of being dispatched as a
command. Nothing short of running the real TUI catches that, because every
cheaper harness stubs the thing that was wrong.

Python, in a JS package, because `pty` is the tool for the job and `scripts/`
ships to nobody (see `files` in package.json).

Credentials: pi will not start without a model, and isolating
PI_CODING_AGENT_DIR also isolates auth. `auth.json`/`models-store.json` are
copied in at 0600 and the whole agent dir is deleted at exit. No model is ever
called — dispatching an extension command returns before any LLM turn — so this
spends no tokens.

Usage:
  python3 scripts/test-tui-offer.py            # all three paths
  python3 scripts/test-tui-offer.py accept     # one path

Exit codes: 0 = every path behaved, 1 = at least one did not.
"""
import json, os, pty, re, select, shutil, subprocess, sys, tempfile, time
from pathlib import Path

# Rows the offer writes, and what each must leave behind.
EXPECT = {
    "accept": {"filtered": True, "profiles": ["core"]},
    "decline": {"filtered": False, "profiles": None},
    "timeout": {"filtered": False, "profiles": None},
}


def run(mode: str, root: Path) -> list[str]:
    """Run one path end to end. Returns a list of problems (empty = fine)."""
    scratch = Path(tempfile.mkdtemp(prefix="sci-tui-"))

    # Stage what ships, renamed so /sci recognises its own settings entry.
    stage = scratch / "pkg"; stage.mkdir()
    tgz = subprocess.run(["npm", "pack", "--silent", "--pack-destination", str(stage)],
                         cwd=root, capture_output=True, text=True).stdout.strip().split("\n")[-1]
    subprocess.run(["tar", "xzf", str(stage / tgz), "-C", str(stage)], check=True)
    pkg = stage / "pi-scientific-skills"
    (stage / "package").rename(pkg)

    agent = scratch / "agent"; agent.mkdir()
    (agent / "settings.json").write_text(json.dumps({"packages": [{"source": str(pkg)}]}, indent=2) + "\n")
    real = Path(os.environ.get("PI_CODING_AGENT_DIR", Path.home() / ".pi" / "agent"))
    for name in ("auth.json", "models-store.json"):
        if (real / name).exists():
            shutil.copy(real / name, agent / name)
            os.chmod(agent / name, 0o600)

    env = {**os.environ, "PI_CODING_AGENT_DIR": str(agent), "TERM": "xterm-256color"}
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(scratch)
        os.execvpe("pi", ["pi", "--no-session"], env)

    out = bytearray()
    sent = False
    deadline = time.time() + (40 if mode == "timeout" else 30)
    try:
        while time.time() < deadline:
            r, _, _ = select.select([fd], [], [], 0.4)
            if r:
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                out += chunk
            text = out.decode("utf8", "replace")
            if not sent and "load Core" in text:
                time.sleep(1.2)                       # let the list finish painting
                if mode == "accept":
                    os.write(fd, b"\r")               # first row is the recommended one
                elif mode == "decline":
                    os.write(fd, b"\x1b[B\r")         # down, then enter
                else:
                    pass                              # let it time out
                sent = True
                if mode == "timeout":
                    deadline = time.time() + 32
    finally:
        time.sleep(4)
        try:
            os.write(fd, b"\x03")                     # ctrl-c
            time.sleep(0.5)
            os.write(fd, b"\x03")
        except OSError:
            pass
        time.sleep(1)
        os.kill(pid, 9)
        os.waitpid(pid, 0)

    clean = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][AB0]", "", out.decode("utf8", "replace"))
    settings = json.loads((agent / "settings.json").read_text())
    cfgp = agent / "pi-scientific-skills.json"
    cfg = json.loads(cfgp.read_text()) if cfgp.exists() else None
    entry = settings["packages"][0]
    skills = entry.get("skills") if isinstance(entry, dict) else None

    problems = []
    want = EXPECT[mode]
    if "load Core" not in clean:
        problems.append(f"{mode}: the offer never rendered — nothing was tested")
    elif want["filtered"]:
        if skills is None:
            problems.append(f"{mode}: accepted, but no skills filter was written")
        elif len(skills) != 10:
            problems.append(f"{mode}: expected Core's 10 skills, got {len(skills)}")
    elif skills is not None:
        problems.append(f"{mode}: wrote a {len(skills)}-skill filter for someone who did not consent")

    got_profiles = (cfg or {}).get("profiles")
    if got_profiles != want["profiles"]:
        problems.append(f"{mode}: profiles is {got_profiles!r}, expected {want['profiles']!r}")
    # Asked exactly once, whatever the answer — silence is an answer.
    if not (cfg or {}).get("onboardingSeen") or (cfg or {}).get("lastSeenVersion") is None:
        problems.append(f"{mode}: did not record that the question was asked: {cfg!r}")

    state = "none (unchanged)" if skills is None else f"{len(skills)} skills"
    print(f"  {'ok  ' if not problems else 'FAIL'}  {mode:<8} filter: {state:<18} profiles: {got_profiles}")
    for problem in problems:
        print(f"          {problem}")

    shutil.rmtree(agent, ignore_errors=True)
    shutil.rmtree(scratch, ignore_errors=True)
    return problems


if __name__ == "__main__":
    modes = sys.argv[1:] or list(EXPECT)
    for mode in modes:
        if mode not in EXPECT:
            print(f"error: unknown path {mode!r}; expected one of {', '.join(EXPECT)}")
            raise SystemExit(2)
    if not shutil.which("pi"):
        print("FAIL: pi is not on PATH — its TUI cannot be driven.")
        raise SystemExit(1)

    print("-- pi's real TUI, driven through a pty --")
    failures = [problem for mode in modes for problem in run(mode, Path.cwd())]
    print(f"\n{'PASS' if not failures else 'FAIL'} — {len(failures)} problem(s)")
    raise SystemExit(1 if failures else 0)
