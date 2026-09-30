#!/usr/bin/env python3
"""subagent-config: set the model pin for opencode subagents from the live catalog.

Works with both opencode v1 and the opencode2 preview. The shims in
~/.local/bin/<binary> set SC_BIN so this script knows which backend to use
(SC_BIN defaults to "opencode2").

Usage (v2):
  opencode2 subagent-config              interactive: pick subagent; set model + effort variant, enable/disable;
                                            press p to manage providers (online/OFFLINE).
                                            (in the model picker, /term searches model ids across providers)
  opencode2 subagent-config list         show agents, model pins, and disabled state
  opencode2 subagent-config models       list the live model catalog
  opencode2 subagent-config models --vision   catalog filtered to image input
  opencode2 subagent-config set <agent> <provider/model[#variant]>
  opencode2 subagent-config unset <agent>
  opencode2 subagent-config provider list     show providers + online/OFFLINE state
  opencode2 subagent-config provider off <id> take a provider offline (writes disabled_providers)
  opencode2 subagent-config provider on <id>  bring a provider back online

The same commands work for v1 via `opencode subagent-config`. v1 discovers
agents/models from the CLI (`opencode agent list`, `opencode models`).

Pins are written to ~/.config/opencode/agents/<agent>.md, which hot-reloads
into running sessions. Applies on the next spawn of that subagent.

Every write replaces the file atomically. Config edits (provider on/off) also
keep the previous version as <config>.subagent-config.bak and refuse to write
when the file changed since it was read.

Ships with the Ultracode plugin; `opencode2 ultracode-config` is the separate
editor for workflow-only tier routing and never changes these pins.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

AGENTS_DIR = Path.home() / ".config" / "opencode" / "agents"
CONFIG_DIR = Path.home() / ".config" / "opencode"
BIN = os.environ.get("SC_BIN", "opencode2")
API = [BIN, "api", "get"]
ANSI = re.compile(r"\x1b\[[0-9;]*m")

BOLD = "\033[1m"
DIM = "\033[2m"
CYAN = "\033[36m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
RESET = "\033[0m"


def use_color() -> bool:
    return sys.stdout.isatty()


def c(text: str, code: str) -> str:
    return f"{code}{text}{RESET}" if use_color() else text


def is_v1() -> bool:
    return BIN == "opencode"


def run_capture(cmd: list[str]) -> str:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, check=True)
    except subprocess.CalledProcessError as e:
        sys.exit(f"error: {' '.join(cmd)} failed: {(e.stderr or '').strip() or e}")
    return r.stdout


# ---------- v2 backend (opencode2 API) ----------


def v2_agents() -> list[dict]:
    return api("/api/agent").get("data", [])


def v2_models() -> list[dict]:
    return api("/api/model").get("data", [])


def v2_wait_reload(agent_id: str, new_model: str | None, timeout: float) -> bool:
    import time

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for a in get_agents():
            if a.get("id") == agent_id and model_ref(a.get("model")) == new_model:
                return True
        time.sleep(0.3)
    return False


def api(path: str) -> dict:
    # opencode2 api truncates large responses when stdout is a pipe, so
    # redirect to a temp file and read it afterwards.
    fd, tmp = tempfile.mkstemp(prefix="oc-sc-", suffix=".json")
    os.close(fd)
    try:
        with open(tmp, "w") as f:
            subprocess.run(API + [path], stdout=f, check=True)
        with open(tmp) as f:
            return json.load(f)
    except subprocess.CalledProcessError as e:
        sys.exit(f"error: opencode2 api failed: {e.stderr.strip() or e}")
    finally:
        os.unlink(tmp)


# ---------- v1 backend (opencode CLI) ----------


def v1_agents() -> list[dict]:
    out = run_capture([BIN, "agent", "list"])
    agents: list[dict] = []
    for line in out.splitlines():
        m = re.match(r"^(\S+)\s+\((\w+)\)\s*$", ANSI.sub("", line))
        if not m:
            continue
        agents.append(
            {
                "id": m.group(1),
                "mode": m.group(2),
                "model": None,
                "description": None,
                "hidden": False,
            }
        )
    for a in agents:
        fm, _, _ = read_frontmatter(agent_file(a["id"]))
        for ln in fm:
            k, _, v = ln.partition(":")
            k, v = k.strip(), v.strip().strip('"')
            if k == "model" and v:
                a["model"] = v
            elif k == "description" and v:
                a["description"] = v
    return agents


def v1_vision_map() -> dict[str, bool]:
    out = run_capture([BIN, "models", "--verbose"])
    vision: dict[str, bool] = {}
    buf: list[str] | None = None
    for raw in out.splitlines():
        line = ANSI.sub("", raw).strip()
        if line == "{":
            buf = ["{"]
        elif buf is not None:
            buf.append(line)
            if raw.rstrip() == "}":
                try:
                    obj = json.loads("\n".join(buf))
                except json.JSONDecodeError:
                    obj = None
                if obj:
                    prov = obj.get("providerID")
                    api_id = (obj.get("api") or {}).get("id")
                    if prov and api_id:
                        cap = obj.get("capabilities") or {}
                        vision[f"{prov}/{api_id}"] = bool(
                            (cap.get("input") or {}).get("image")
                        )
                buf = None
    return vision


def v1_models() -> list[dict]:
    out = run_capture([BIN, "models"])
    vision = v1_vision_map()
    models: list[dict] = []
    for raw in out.splitlines():
        line = ANSI.sub("", raw).strip()
        if "/" not in line:
            continue
        provider, _, mid = line.partition("/")
        caps = ["image"] if vision.get(line) else []
        models.append({"providerID": provider, "id": mid, "capabilities": {"input": caps}})
    return models


def v1_wait_reload(agent_id: str, new_model: str | None, timeout: float) -> bool:
    import time

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            out = run_capture([BIN, "debug", "agent", agent_id])
            d = json.loads(ANSI.sub("", out))
        except (SystemExit, json.JSONDecodeError):
            return False
        m = d.get("model") or {}
        cur = f"{m.get('providerID')}/{m.get('modelID')}" if m.get("providerID") else None
        if cur == new_model:
            return True
        time.sleep(0.5)
    return False


# ---------- dispatch ----------


def get_agents() -> list[dict]:
    return v1_agents() if is_v1() else v2_agents()


def get_models() -> list[dict]:
    return v1_models() if is_v1() else v2_models()


def wait_reload(agent_id: str, new_model: str | None, timeout: float = 4.0) -> bool:
    if is_v1():
        return v1_wait_reload(agent_id, new_model, 6.0)
    return v2_wait_reload(agent_id, new_model, timeout)


# ---------- shared ----------


def atomic_write(path: Path, content: str) -> None:
    """Replace `path` in one step so a crash or a concurrent reader never sees half a file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o644
    fd, tmp = tempfile.mkstemp(prefix=".subagent-config-", dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "w") as out:
            out.write(content)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def project_agent_file(agent_id: str) -> Path:
    return Path.cwd() / ".opencode" / "agents" / f"{agent_id}.md"


def model_ref(m: dict | str | None) -> str | None:
    if not m:
        return None
    if isinstance(m, dict):
        ref = f"{m.get('providerID')}/{m.get('id') or m.get('model')}"
        v = m.get("variant")
        if v:
            ref += f"#{v}"
        return ref
    return m


def is_vision(m: dict) -> bool:
    caps = m.get("capabilities") or {}
    return "image" in set(caps.get("input") or [])


def visible_subagents(agents: list[dict]) -> list[dict]:
    return [
        a
        for a in agents
        if a.get("mode") in ("subagent", "all") and not a.get("hidden")
    ]


def agent_file(agent_id: str) -> Path:
    return AGENTS_DIR / f"{agent_id}.md"


def read_frontmatter(path: Path) -> tuple[list[str], list[str], str]:
    """Returns (frontmatter_lines, body_lines). frontmatter excludes the --- fences."""
    if not path.exists():
        return [], [], ""
    lines = path.read_text().splitlines()
    if lines and lines[0].strip() == "---":
        end = next(
            (i for i in range(1, len(lines)) if lines[i].strip() == "---"), None
        )
        if end is not None:
            return lines[1:end], lines[end + 1 :], ""
    return [], lines, ""


def write_agent(agent_id: str, new_model: str, agents: list[dict]) -> None:
    path = agent_file(agent_id)
    fm, body, _ = read_frontmatter(path)
    if not fm and not path.exists():
        reg = next((a for a in agents if a.get("id") == agent_id), None)
        if reg:
            desc = (reg.get("description") or "").replace('"', '\\"')
            if desc:
                fm.append(f'description: "{desc}"')
            if reg.get("mode"):
                fm.append(f"mode: {reg.get('mode')}")
    out_fm = [ln for ln in fm if not ln.lstrip().startswith("model:")]
    out_fm.append(f"model: {new_model}")
    content = "---\n" + "\n".join(out_fm) + "\n---\n"
    if body:
        content += "\n".join(body).rstrip() + "\n"
    atomic_write(path, content)
    print(c(f"set {agent_id} -> {new_model}", GREEN), end=" ")
    if wait_reload(agent_id, new_model):
        print(c("(reloaded; applies on next spawn)", GREEN))
    elif is_v1():
        print("(applies on next spawn)")
    else:
        print(
            f"(applies on next spawn; live registry did not reload — "
            f"run `{BIN} service restart` to load it now)"
        )


def remove_pin(agent_id: str) -> None:
    path = agent_file(agent_id)
    if not path.exists():
        print(c(f"{agent_id} has no pin file", YELLOW))
        return
    fm, body, _ = read_frontmatter(path)
    out_fm = [ln for ln in fm if not ln.lstrip().startswith("model:")]
    trivial = all(
        not ln.strip() or ln.lstrip().startswith(("#", "description:", "mode:"))
        for ln in out_fm
    ) and not any(ln.strip() for ln in body)
    if trivial:
        path.unlink()
    else:
        content = "---\n" + "\n".join(out_fm) + "\n---\n"
        if body:
            content += "\n".join(body).rstrip() + "\n"
        atomic_write(path, content)
    print(c(f"unset {agent_id} (inherits session model)", GREEN), end=" ")
    if wait_reload(agent_id, None):
        print(c("(reloaded)", GREEN))
    elif is_v1():
        print("(applies on next spawn)")
    else:
        print(
            f"(applies on next spawn; live registry did not reload — "
            f"run `{BIN} service restart` to load it now)"
        )


def fm_field(fm: list[str], key: str) -> str | None:
    for ln in fm:
        k, _, v = ln.partition(":")
        if k.strip() == key:
            return v.strip().strip('"')
    return None


def file_pin(agent_id: str) -> str | None:
    fm, _, _ = read_frontmatter(agent_file(agent_id))
    return fm_field(fm, "model")


def agent_disabled(agent_id: str) -> bool:
    fm, _, _ = read_frontmatter(agent_file(agent_id))
    return (fm_field(fm, "disabled") or "").lower() == "true"


def toggle_agent(agent_id: str, agents: list[dict]) -> None:
    path = agent_file(agent_id)
    fm, body, _ = read_frontmatter(path)
    if agent_disabled(agent_id):
        out_fm = [ln for ln in fm if not ln.lstrip().startswith("disabled:")]
        verb = "enabled"
    else:
        out_fm = [ln for ln in fm if not ln.lstrip().startswith("disabled:")]
        if not fm and not path.exists():
            reg = next((a for a in agents if a.get("id") == agent_id), None)
            if reg:
                desc = (reg.get("description") or "").replace('"', '\\"')
                if desc:
                    out_fm.append(f'description: "{desc}"')
                if reg.get("mode"):
                    out_fm.append(f"mode: {reg.get('mode')}")
        out_fm.append("disabled: true")
        verb = "disabled"
    content = "---\n" + "\n".join(out_fm) + "\n---\n"
    if body:
        content += "\n".join(body).rstrip() + "\n"
    atomic_write(path, content)
    print(c(f"{agent_id} -> {verb} (applies on next spawn)", GREEN))


def all_subagents(agents: list[dict]) -> list[dict]:
    subs = visible_subagents(agents)
    seen = {a["id"] for a in subs}
    for path in sorted(AGENTS_DIR.glob("*.md")):
        aid = path.stem
        if aid in seen:
            continue
        fm, _, _ = read_frontmatter(path)
        d: dict = {"id": aid, "mode": "subagent", "model": None}
        for ln in fm:
            k, _, v = ln.partition(":")
            k, v = k.strip(), v.strip().strip('"')
            if k == "model":
                d["model"] = v
            elif k == "description":
                d["description"] = v
        subs.append(d)
    return subs


# ---------- provider on/off (global config `disabled_providers`) ----------


def config_path() -> Path:
    for name in ("opencode.json", "opencode.jsonc"):
        candidate = CONFIG_DIR / name
        if candidate.exists():
            return candidate
    return CONFIG_DIR / "opencode.json"


def read_config(path: Path) -> tuple[dict, str | None]:
    """Returns (config, raw text as read); raw is None when the file does not exist."""
    if not path.exists():
        return {}, None
    raw = path.read_text()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        sys.exit(
            f"error: {path} is not plain JSON ({exc.msg} at line {exc.lineno}); "
            "edit 'disabled_providers' manually"
        )
    return (data if isinstance(data, dict) else {}), raw


def load_config(path: Path) -> dict:
    return read_config(path)[0]


def save_config(path: Path, cfg: dict, before: str | None) -> None:
    """Write the config; `before` is the raw text read_config returned for this edit."""
    current = path.read_text() if path.exists() else None
    # Refuse a concurrent editor (ultracode-config, the user) instead of losing its work.
    if current != before:
        sys.exit(f"error: {path} changed while editing; retry")
    if current is not None:
        shutil.copy2(path, path.with_name(path.name + ".subagent-config.bak"))
    atomic_write(path, json.dumps(cfg, indent=2) + "\n")


def disabled_providers(cfg: dict) -> list[str]:
    value = cfg.get("disabled_providers")
    if value is None:
        return []
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        return list(value)
    sys.exit(f"error: 'disabled_providers' in {config_path()} is not a list of strings")


def provider_snapshot(models: list[dict]) -> tuple[list[str], dict[str, int], set[str]]:
    counts: dict[str, int] = {}
    for m in models:
        pid = m.get("providerID") or "?"
        counts[pid] = counts.get(pid, 0) + 1
    off = set(disabled_providers(load_config(config_path())))
    ids = sorted(set(counts) | off)
    return ids, counts, off


def print_provider_table(ids: list[str], counts: dict[str, int], off: set[str]) -> None:
    print(c("providers:", BOLD))
    width = len(str(len(ids)))
    for i, pid in enumerate(ids):
        n = counts.get(pid, 0)
        count = f"{n} model{'s' if n != 1 else ''}" if n else "not in live catalog"
        tag = c("[OFFLINE]", YELLOW) if pid in off else c("[online]", GREEN)
        print(f"  {i + 1:>{width}}. {pid:<24}{tag}  ({count})")


def wait_provider_reload(pid: str, want_online: bool, timeout: float = 5.0) -> bool:
    import time

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        online = any(m.get("providerID") == pid for m in get_models())
        if online == want_online:
            return True
        time.sleep(0.4)
    return False


def toggle_provider(pid: str) -> None:
    path = config_path()
    cfg, before = read_config(path)
    off = disabled_providers(cfg)
    turning_off = pid not in off
    if turning_off:
        off.append(pid)
    else:
        off = [item for item in off if item != pid]
    cfg["disabled_providers"] = off
    save_config(path, cfg, before)
    state = c("OFFLINE", YELLOW) if turning_off else c("online", GREEN)
    print(c(f"{pid} -> {state}", GREEN), end=" ")
    if wait_provider_reload(pid, want_online=not turning_off):
        print(c("(catalog reloaded)", GREEN))
    else:
        print(f"(no catalog change yet — run `{BIN} service restart`)")


def interactive_providers() -> None:
    while True:
        ids, counts, off = provider_snapshot(get_models())
        if not ids:
            print(c("no providers found", YELLOW))
            return
        print()
        print_provider_table(ids, counts, off)
        raw = input("provider (number or id to toggle, b=back): ").strip()
        if raw.lower() in ("b", "back", "q", "quit"):
            return
        pid = None
        if raw.isdigit() and 1 <= int(raw) <= len(ids):
            pid = ids[int(raw) - 1]
        elif raw in ids:
            pid = raw
        else:
            print(c("unknown provider", YELLOW))
            continue
        toggle_provider(pid)


def cmd_provider(args: list[str], models: list[dict]) -> None:
    sub = args[0] if args else "list"
    if sub == "list":
        print_provider_table(*provider_snapshot(models))
        return
    if sub in ("on", "off"):
        if len(args) < 2:
            sys.exit(f"usage: subagent-config provider {sub} <provider-id>")
        toggle_provider(args[1])
        return
    sys.exit("usage: subagent-config provider [list | on <id> | off <id>]")


def pick(options: list[str], prompt: str) -> str | None:
    while True:
        try:
            raw = input(prompt).strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return None
        if raw.lower() in ("q", "quit"):
            return None
        if raw.isdigit() and 1 <= int(raw) <= len(options):
            return options[int(raw) - 1]
        if raw in options:
            return raw
        print(c("invalid choice", YELLOW))


def _with_variant(m: dict | None, variant: str | None) -> dict | None:
    if m is None or variant is None:
        return m
    allowed = [v.get("id") for v in (m.get("variants") or [])]
    if variant not in allowed:
        return None
    m = dict(m)
    m["_variant"] = variant
    return m


def find_model(ref: str, models: list[dict]) -> dict | None:
    variant = None
    if "#" in ref:
        ref, _, variant = ref.partition("#")
    if "/" in ref:
        provider, _, mid = ref.partition("/")
        for m in models:
            if m.get("providerID") == provider and m.get("id") == mid:
                return _with_variant(m, variant)
        return None
    hits = [m for m in models if m.get("id") == ref]
    if len(hits) != 1:
        return None
    return _with_variant(hits[0], variant)


def ref_of(m: dict) -> str:
    ref = f"{m['providerID']}/{m['id']}"
    if "_variant" in m:
        ref += f"#{m['_variant']}"
    return ref


def fail_model_lookup(ref: str, models: list[dict]) -> None:
    hits = [m for m in models if m.get("id") == ref] if "/" not in ref else []
    if len(hits) > 1:
        print(c(f"'{ref}' exists under multiple providers:", YELLOW))
        for m in hits:
            print(f"  {m['providerID']}/{m['id']}")
    else:
        print(c(f"model '{ref}' not in catalog (try: models)", YELLOW))
    sys.exit(1)


def resolve_agent(agent_id: str, agents: list[dict]) -> dict | None:
    return next((a for a in agents if a.get("id") == agent_id), None)


def group_models(pool: list[dict]) -> dict[str, list[dict]]:
    groups: dict[str, list[dict]] = {}
    for m in pool:
        groups.setdefault(m.get("providerID", "?"), []).append(m)
    return groups


def ref_label(m: dict) -> str:
    return f"{m['providerID']}/{m['id']}" if "/" in m.get("id", "") else m["id"]


def expand_provider(provider: str, pool: list[dict]) -> str | None:
    entries = [m for m in pool if m.get("providerID") == provider]
    while True:
        print(f"\n{c(provider + '/', BOLD)} ({len(entries)} models)")
        for i, m in enumerate(entries):
            tag = c(" [img]", CYAN) if is_vision(m) else ""
            print(f"  {i + 1:>3}. {ref_label(m)}{tag}")
        raw = input("model (number, id, provider/model, b=back): ").strip()
        if raw.lower() in ("b", "back", "q", "quit"):
            return None
        if raw.isdigit() and 1 <= int(raw) <= len(entries):
            m = entries[int(raw) - 1]
            return f"{m['providerID']}/{m['id']}"
        if "/" in raw:
            m = find_model(raw, pool)
            if m:
                return f"{m['providerID']}/{m['id']}"
            print(c(f"model '{raw}' not in catalog", YELLOW))
            continue
        hits = [m for m in entries if m.get("id") == raw]
        if len(hits) == 1:
            return f"{hits[0]['providerID']}/{hits[0]['id']}"
        print(c(f"no model '{raw}' under {provider}/", YELLOW))


def norm_id(s: str) -> str:
    """Lowercase and strip separators, so 'glm5.2' matches 'glm-5.2'."""
    return re.sub(r"[^a-z0-9]", "", s.lower())


def search_models(pool: list[dict], term: str) -> str | None:
    """Search model ids across all providers; returns 'provider/id' once picked.

    Results keep the catalog's default order (no re-sorting).
    """
    q = norm_id(term)
    hits = [m for m in pool if q in norm_id(m.get("id", ""))]
    if not hits:
        print(c(f"no models matching '{term}'", YELLOW))
        return None
    while True:
        print(f"\n{c('search results:', BOLD)} '{term}' ({len(hits)} models)")
        for i, m in enumerate(hits):
            tag = c(" [img]", CYAN) if is_vision(m) else ""
            print(f"  {i + 1:>3}. {m['providerID']}/{m['id']}{tag}")
        raw = input("model (number, b=back): ").strip()
        if raw.lower() in ("b", "back", "q", "quit"):
            return None
        if raw.isdigit() and 1 <= int(raw) <= len(hits):
            m = hits[int(raw) - 1]
            return f"{m['providerID']}/{m['id']}"
        print(c("invalid choice", YELLOW))


def choose_model(models: list[dict]) -> str | None:
    vision = input("vision models only? [y/N]: ").strip().lower() == "y"
    pool = [m for m in models if not vision or is_vision(m)]
    groups = group_models(pool)
    width = len(str(len(groups)))
    while True:
        print(f"\n{c('providers:', BOLD)} (a = show all models, /term = search)")
        ordered = sorted(groups)
        for i, provider in enumerate(ordered):
            print(f"  {i + 1:>{width}}. {provider}/  ({len(groups[provider])} models)")
        raw = input(
            "provider (number, name, provider/model, /search, a, q=back): "
        ).strip()
        if raw.lower() in ("q", "quit", "b", "back"):
            return None
        if raw.startswith("/") and len(raw) > 1:
            ref = search_models(pool, raw[1:])
            if ref:
                return ref
            continue
        if raw.lower() == "a":
            flat = [m for p in ordered for m in groups[p]]
            while True:
                print(f"\n{c('all models:', BOLD)}")
                for i, m in enumerate(flat):
                    tag = c(" [img]", CYAN) if is_vision(m) else ""
                    print(f"  {i + 1:>3}. {m['providerID']}/{m['id']}{tag}")
                raw2 = input("model (number, provider/model, b=back): ").strip()
                if raw2.lower() in ("b", "back", "q", "quit"):
                    break
                if raw2.isdigit() and 1 <= int(raw2) <= len(flat):
                    m = flat[int(raw2) - 1]
                    return f"{m['providerID']}/{m['id']}"
                m = find_model(raw2, pool)
                if m:
                    return f"{m['providerID']}/{m['id']}"
                print(c(f"model '{raw2}' not in catalog", YELLOW))
            continue
        if "/" in raw:
            m = find_model(raw, pool)
            if m:
                return f"{m['providerID']}/{m['id']}"
            print(c(f"model '{raw}' not in catalog", YELLOW))
            continue
        provider = raw if raw in groups else None
        if provider is None and raw.isdigit() and 1 <= int(raw) <= len(ordered):
            provider = ordered[int(raw) - 1]
        if provider is None:
            print(c("unknown provider (use number, name, or provider/model)", YELLOW))
            continue
        ref = expand_provider(provider, pool)
        if ref:
            return ref


def choose_effort(ref: str, models: list[dict]) -> str:
    """Prompt for a model variant (reasoning effort) after model selection."""
    if "#" in ref:
        return ref
    m = find_model(ref, models)
    if m is None:
        return ref
    variants = m.get("variants") or []
    if not variants:
        return ref
    print(f"\n{c('effort (model variant):', BOLD)} (enter = default)")
    print("  0. (default)")
    for i, v in enumerate(variants, 1):
        print(f"  {i}. {v['id']}")
    raw = input("effort (number or id, enter = default): ").strip().lower()
    if raw in ("", "0", "q", "quit", "b", "back"):
        return ref
    if raw.isdigit() and 1 <= int(raw) <= len(variants):
        return f"{ref}#{variants[int(raw) - 1]['id']}"
    if any(v["id"] == raw for v in variants):
        return f"{ref}#{raw}"
    print(c("invalid effort; using default", YELLOW))
    return ref


def interactive() -> None:
    while True:
        agents = get_agents()
        models = get_models()
        subs = all_subagents(agents)
        if not subs:
            sys.exit("no subagents found (enabled or disabled)")
        print(c("subagents:", BOLD))
        opts = []
        for a in subs:
            ref = model_ref(a.get("model"))
            if not ref:
                pin = file_pin(a["id"])
                ref = f"{pin} (pending reload)" if pin else "inherits"
            desc = a.get("description") or ""
            desc = f" — {desc[:70]}" if desc else ""
            tag = c(" [disabled]", YELLOW) if agent_disabled(a["id"]) else ""
            print(f"  {len(opts) + 1:>2}. {a['id']:<20} {c(ref, DIM)}{tag}{desc}")
            opts.append(a["id"])
        choice = None
        while choice is None:
            raw = input("subagent (number, id, p=providers, q=quit): ").strip()
            if raw.lower() in ("q", "quit"):
                return
            if raw.lower() == "p":
                interactive_providers()
                break
            if raw.isdigit() and 1 <= int(raw) <= len(opts):
                choice = opts[int(raw) - 1]
                break
            if raw in opts:
                choice = raw
                break
            print(c("invalid choice", YELLOW))
        if choice is None:
            continue
        while True:
            reg = resolve_agent(choice, get_agents())
            if reg:
                current = model_ref(reg.get("model"))
                if current is None:
                    pin = file_pin(choice)
                    if pin:
                        current = f"{pin} (file pin; registry not reloaded)"
            else:
                fm, _, _ = read_frontmatter(agent_file(choice))
                current = fm_field(fm, "model")
            status = c("disabled", YELLOW) if agent_disabled(choice) else c("enabled", GREEN)
            print(f"\n{c(f'[{choice}]', BOLD)} ({status}) current model: {current or c('inherits', DIM)}")
            toggle_label = "enable" if agent_disabled(choice) else "disable"
            actions = [
                "choose a model",
                f"unset {choice} (inherit session model)",
                f"{toggle_label} {choice}",
                "back to subagent list",
            ]
            for i, a in enumerate(actions):
                print(f"  {i + 1}. {a}")
            act = pick(actions, "action (number, q=back): ")
            if act is None or act.startswith("back"):
                break
            if act.startswith("unset"):
                remove_pin(choice)
                break
            if act.startswith(toggle_label):
                toggle_agent(choice, agents)
                break
            ref = choose_model(models)
            if ref is None:
                break
            ref = choose_effort(ref, models)
            write_agent(choice, ref, agents)
            break


def cmd_list(agents: list[dict]) -> None:
    print(f"{'agent':<18} {'mode':<10} model")
    print("-" * 60)
    rows = list(agents)
    seen = {a["id"] for a in rows}
    for path in sorted(AGENTS_DIR.glob("*.md")):
        aid = path.stem
        if aid in seen:
            continue
        fm, _, _ = read_frontmatter(path)
        rows.append(
            {
                "id": aid,
                "mode": fm_field(fm, "mode") or "subagent",
                "model": fm_field(fm, "model"),
            }
        )
    for a in rows:
        if a.get("hidden"):
            continue
        ref = model_ref(a.get("model"))
        if not ref:
            pin = file_pin(a["id"])
            ref = f"{pin} (pending reload)" if pin else c("inherits", DIM)
        else:
            ref = c(ref, DIM)
        dis = c(" [disabled]", YELLOW) if agent_disabled(a["id"]) else ""
        print(f"{a['id']:<18} {a.get('mode', ''):<10} {ref}{dis}")
        # Ultracode workflow children read the project file first; this tool edits the global one.
        override = project_agent_file(a["id"])
        if override.exists():
            fm, _, _ = read_frontmatter(override)
            if (fm_field(fm, "disabled") or "").lower() == "true":
                state = "disabled"
            else:
                state = fm_field(fm, "model") or "no pin"
            print(c(f"{'':<18} {'':<10} project file .opencode/agents/{a['id']}.md wins here: {state}", YELLOW))


def cmd_models(models: list[dict], vision_only: bool) -> None:
    pool = [m for m in models if not vision_only or is_vision(m)]
    by_provider: dict[str, list[dict]] = {}
    for m in pool:
        by_provider.setdefault(m.get("providerID", "?"), []).append(m)
    for provider in sorted(by_provider):
        print(f"{provider}/")
        for m in by_provider[provider]:
            tag = " [img]" if is_vision(m) else ""
            print(f"  {ref_label(m)}{tag}")


def main() -> None:
    args = sys.argv[1:]
    if args and args[0] in ("-h", "--help"):
        print(__doc__.strip())
        return

    agents = get_agents()
    models = get_models()

    if not args:
        interactive()
        return

    cmd = args[0]
    if cmd == "list":
        cmd_list(agents)
    elif cmd == "models":
        cmd_models(models, "--vision" in args[1:])
    elif cmd == "provider":
        cmd_provider(args[1:], models)
    elif cmd == "set":
        if len(args) < 3:
            sys.exit("usage: subagent-config set <agent> <provider/model[#variant]>")
        agent_id, ref = args[1], args[2]
        if resolve_agent(agent_id, agents) is None and not agent_file(agent_id).exists():
            sys.exit(c(f"no agent '{agent_id}' (try: list)", YELLOW))
        m = find_model(ref, models)
        if m is None:
            if "#" in ref:
                base, _, variant = ref.partition("#")
                base_m = find_model(base, models)
                if base_m is not None:
                    allowed = [v.get("id") for v in (base_m.get("variants") or [])]
                    sys.exit(
                        c(
                            f"variant '#{variant}' not valid for {base_m['providerID']}/{base_m['id']} "
                            f"(available: {', '.join(allowed) or 'none'})",
                            YELLOW,
                        )
                    )
            fail_model_lookup(ref, models)
        write_agent(agent_id, ref_of(m), agents)
    elif cmd == "unset":
        if len(args) < 2:
            sys.exit("usage: subagent-config unset <agent>")
        remove_pin(args[1])
    else:
        sys.exit(f"unknown command '{cmd}' (try: --help)")


if __name__ == "__main__":
    main()