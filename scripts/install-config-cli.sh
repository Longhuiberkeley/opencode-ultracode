#!/usr/bin/env bash
# Add `opencode2 ultracode-config` and `opencode2 subagent-config` to a user-owned
# opencode2 shim, creating the shim when there is none. Both editors live in the
# self-contained global Ultracode plugin installation.
set -euo pipefail
SHIM="${1:-$HOME/.local/bin/opencode2}"
PLUGIN="${2:-$HOME/.config/opencode/plugins/ultracode}"
[[ -f "$PLUGIN/src/ultracode-config-cli.mjs" ]] || {
  echo "install the global Ultracode plugin first (bash scripts/install.sh --global --tui)" >&2; exit 1;
}
if [[ ! -e "$SHIM" ]]; then
  # No shim yet: write one that delegates to the real binary, found on PATH
  # with the shim's own directory removed so the shim never calls itself.
  SHIM_DIR="$(cd "$(dirname "$SHIM")" 2>/dev/null && pwd || dirname "$SHIM")"
  SEARCH_PATH="$(printf '%s' "$PATH" | tr ':' '\n' | { grep -vxF "$SHIM_DIR" || true; } | paste -sd ':' -)"
  REAL="$(PATH="$SEARCH_PATH" command -v "$(basename "$SHIM")" || true)"
  [[ -n "$REAL" ]] || { echo "cannot find the real $(basename "$SHIM") on PATH; install opencode first" >&2; exit 1; }
  mkdir -p "$SHIM_DIR"
  printf '%s\n' '#!/bin/bash' \
    "# $(basename "$SHIM") shim (created by opencode-ultracode): adds config subcommands; delegates the rest." \
    "exec \"$REAL\" \"\$@\"" >"$SHIM"
  chmod 755 "$SHIM"
  echo "created shim $SHIM -> $REAL"
  case ":$PATH:" in
    *":$SHIM_DIR:"*) ;;
    *) echo "note: add $SHIM_DIR to the front of PATH so the shim is found before $REAL" ;;
  esac
fi
[[ -f "$SHIM" ]] || { echo "not a regular file: $SHIM" >&2; exit 1; }
SHIM="$SHIM" PLUGIN="$PLUGIN" python3 - <<'PY'
import os
from pathlib import Path
import shutil
import tempfile

shim = Path(os.environ['SHIM'])
plugin = Path(os.environ['PLUGIN'])
original = source = shim.read_text()

# Dispatch blocks go before the shim's `update` dispatch when it has one (the
# maintainer's layout), otherwise before its final delegating `exec`.
update = 'if [[ "${1:-}" == "update" ]]; then'
if source.count(update) == 1:
    anchor = update
else:
    execs = [line for line in source.splitlines() if line.startswith('exec ')]
    if not execs or source.count(execs[-1]) != 1:
        raise SystemExit('refusing to edit an unrecognized opencode2 shim (no unique update dispatch or final exec)')
    anchor = execs[-1]

def dispatch(name, command):
    return (f'# {name} dispatch (installed by opencode-ultracode)\n'
            f'if [[ "${{1:-}}" == "{name}" ]]; then\n'
            '  shift\n'
            f'  exec {command} "$@"\n'
            'fi\n')

added = []
if '# ultracode-config dispatch (installed by opencode-ultracode)' not in source:
    block = dispatch('ultracode-config',
                     f'node --disable-warning=ExperimentalWarning --experimental-strip-types "{plugin}/src/ultracode-config-cli.mjs"')
    source = source.replace(anchor, block + anchor)
    help_line = '  echo "  check-rate        check provider rate limits"'
    if source.count(help_line) == 1:
        source = source.replace(help_line, help_line + '\n  echo "  ultracode-config  inspect/edit Ultracode workflow policy"')
    added.append('ultracode-config')
# A shim that already dispatches subagent-config (a user's own copy) keeps it.
if (plugin / 'src/subagent-config.py').is_file():
    if '"subagent-config"' in source:
        print('subagent-config dispatch already present; left as is')
    else:
        block = dispatch('subagent-config', f'env SC_BIN="{shim.name}" python3 "{plugin}/src/subagent-config.py"')
        source = source.replace(anchor, block + anchor)
        added.append('subagent-config')

if source == original:
    print('ultracode-config dispatch already installed')
    raise SystemExit(0)
backup = shim.with_name(shim.name + '.ultracode-config.bak')
shutil.copy2(shim, backup)
fd, tmp = tempfile.mkstemp(prefix='.ultracode-config-', dir=shim.parent)
try:
    os.fchmod(fd, shim.stat().st_mode & 0o777)
    with os.fdopen(fd, 'w') as out:
        out.write(source)
    os.replace(tmp, shim)
except BaseException:
    Path(tmp).unlink(missing_ok=True)
    raise
print(f'added opencode2 {" and ".join(added)}; backup: {backup}')
PY
