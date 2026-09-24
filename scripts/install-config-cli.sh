#!/usr/bin/env bash
# Add `opencode2 ultracode-config` to an existing user-owned opencode2 shim.
# The editor lives in the self-contained global Ultracode plugin installation.
set -euo pipefail
SHIM="${1:-$HOME/.local/bin/opencode2}"
PLUGIN="${2:-$HOME/.config/opencode/plugins/ultracode}"
[[ -f "$SHIM" ]] || { echo "missing shim: $SHIM" >&2; exit 1; }
[[ -f "$PLUGIN/src/ultracode-config-cli.mjs" ]] || {
  echo "install the global Ultracode plugin first (bash scripts/install.sh --global --tui)" >&2; exit 1;
}
SHIM="$SHIM" PLUGIN="$PLUGIN" python3 - <<'PY'
import os
from pathlib import Path
import shutil
import tempfile

shim = Path(os.environ['SHIM'])
plugin = Path(os.environ['PLUGIN'])
source = shim.read_text()
marker = '# ultracode-config dispatch (installed by opencode-ultracode)'
if marker in source:
    print('ultracode-config dispatch already installed')
    raise SystemExit(0)
anchor = 'if [[ "${1:-}" == "update" ]]; then'
if source.count(anchor) != 1:
    raise SystemExit('refusing to edit an unrecognized opencode2 shim (missing unique update dispatch)')
block = (f'{marker}\n'
         'if [[ "${1:-}" == "ultracode-config" ]]; then\n'
         '  shift\n'
         f'  exec node --disable-warning=ExperimentalWarning --experimental-strip-types "{plugin}/src/ultracode-config-cli.mjs" "$@"\n'
         'fi\n')
source = source.replace(anchor, block + anchor)
help_line = '  echo "  check-rate        check provider rate limits"'
if source.count(help_line) == 1:
    source = source.replace(help_line, help_line + '\n  echo "  ultracode-config  inspect/edit Ultracode workflow policy"')
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
print(f'added opencode2 ultracode-config; backup: {backup}')
PY
