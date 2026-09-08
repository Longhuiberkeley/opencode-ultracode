#!/usr/bin/env bash
# Load the TUI half of spike/scratch/.opencode/plugins/probe and dump the live
# CLI plugin API to spike/out/tui-probe.jsonl.
#
# The TUI plugin does not load under `opencode2 run` (headless). This starts
# `opencode2 mini --standalone` under a pseudo-TTY for a few seconds.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH="$REPO_ROOT/spike/scratch"
OUT="$REPO_ROOT/spike/out/tui-probe.jsonl"

mkdir -p "$REPO_ROOT/spike/out"
: > "$OUT"
export PROBE_TUI_OUT="$OUT"

echo "== tui probe (opencode2 $(opencode2 --version 2>/dev/null || echo '?')) =="
echo "scratch: $SCRATCH"
echo "log:     $OUT"

cd "$SCRATCH" || exit 1

# Full TUI (not mini) — mini may skip CLI plugins. Needs a PTY.
if command -v script >/dev/null 2>&1; then
  timeout 12 script -q /dev/null opencode2 --standalone --print-logs \
    > "$REPO_ROOT/spike/out/tui-probe-tty.txt" 2>&1 || true
else
  timeout 12 opencode2 --standalone --print-logs \
    > "$REPO_ROOT/spike/out/tui-probe-tty.txt" 2>&1 || true
fi

echo "== log bytes: $(wc -c < "$OUT" | tr -d ' ') =="
if [[ -s "$OUT" ]]; then
  echo "== events =="
  python3 -c 'import json,sys
from collections import Counter
c=Counter()
for line in open(sys.argv[1]):
    if not line.strip(): continue
    c[json.loads(line)["kind"]] += 1
print("\n".join(f"{k}: {v}" for k,v in sorted(c.items())))' "$OUT"
else
  echo "NO tui-probe.jsonl events — TUI plugin did not load (see spike/out/tui-probe-tty.txt)"
  echo "Fallback: open a TUI in $SCRATCH (opencode2 --standalone) then Ctrl-C; the probe writes on setup."
fi
