#!/usr/bin/env bash
# Phase 0-server spike: drive spike/scratch/.opencode/plugins/probe headless.
# Captures metadata / session shape / events / skill-reload / install-shape
# evidence as jsonl under spike/out/. Modeled on scripts/live-test.sh
# (`opencode2 run --standalone` + `opencode2 api --standalone`) and
# scripts/tui-probe.sh (timeout + jsonl summary). Does not invent a new
# server-launch mechanism.
#
# Exits nonzero only on infrastructure failure (missing binary, cwd, etc.).
# REFUTED / UNKNOWN findings are still exit 0.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH="$REPO_ROOT/spike/scratch"
OUT_DIR="$REPO_ROOT/spike/out"
OUT="$OUT_DIR/server-probe.jsonl"
INSTALL_CONFIG_OUT="$OUT_DIR/server-probe-install-config.jsonl"
INSTALL_AUTO_OUT="$OUT_DIR/server-probe-install-autoload.jsonl"
PLUGIN_LIST_CONFIG="$OUT_DIR/server-probe-plugins-config.json"
PLUGIN_LIST_AUTO="$OUT_DIR/server-probe-plugins-autoload.json"
RUN_OUT="$OUT_DIR/server-probe-run.txt"
RUN_LOG="$OUT_DIR/server-probe-logs.txt"
OC_JSON="$SCRATCH/.opencode/opencode.json"
CLI_JSON="$SCRATCH/.opencode/cli.json"

mkdir -p "$OUT_DIR"
: > "$OUT"
: > "$INSTALL_CONFIG_OUT"
: > "$INSTALL_AUTO_OUT"

echo "== server probe (opencode2 $(opencode2 --version 2>/dev/null || echo '?')) =="
echo "scratch: $SCRATCH"
echo "log:     $OUT"

if ! command -v opencode2 >/dev/null 2>&1; then
  echo "infrastructure failure: opencode2 not on PATH"
  exit 1
fi
if [[ ! -d "$SCRATCH" ]]; then
  echo "infrastructure failure: scratch dir missing"
  exit 1
fi

plugin_pkg="?"
if [[ -f "$REPO_ROOT/node_modules/@opencode/plugin/package.json" ]]; then
  plugin_pkg="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("version","?"))' \
    "$REPO_ROOT/node_modules/@opencode/plugin/package.json")"
fi
echo "plugin pkg (repo node_modules): $plugin_pkg"

list_plugins() {
  local dest="$1"
  (cd "$SCRATCH" && timeout 120 opencode2 api --standalone post /api/plugin/await-activation >/dev/null 2>&1 || true)
  (cd "$SCRATCH" && timeout 60 opencode2 api --standalone get /api/plugin) > "$dest" 2>/dev/null || true
}

plugin_ids() {
  python3 -c '
import json,sys
raw=open(sys.argv[1]).read().strip()
if not raw:
    print("(empty)")
    raise SystemExit
try:
    d=json.loads(raw)
except Exception as e:
    print("(parse-error %s)" % e)
    raise SystemExit
data=d.get("data", d) if isinstance(d, dict) else d
if not isinstance(data, list):
    keys=list(d) if isinstance(d, dict) else type(d)
    print("(not-list keys=%s)" % keys)
    raise SystemExit
if not data:
    print("(data=[])")
    raise SystemExit
for p in data:
    if not isinstance(p, dict):
        continue
    src=p.get("source") or {}
    ident=p.get("id")
    st=p.get("state")
    path=src.get("path") or src.get("target") or ""
    print("%s|%s|%s|%s" % (ident, src.get("type"), path, st))
' "$1"
}

jsonl_has_setup() {
  python3 -c '
import json,sys
for line in open(sys.argv[1]):
    line=line.strip()
    if not line: continue
    try:
        if json.loads(line).get("kind")=="setup":
            raise SystemExit(0)
    except Exception:
        pass
raise SystemExit(1)
' "$1"
}

# ---- D10 install shape ----
# Scratch currently has BOTH:
#   .opencode/opencode.json  plugins: ["./plugins/probe"]
#   .opencode/cli.json       plugins: ["./plugins/probe"]
#   .opencode/plugins/probe/index.ts  (auto-load dir present)
# Verify config-entry load, then temporarily strip config entries and see
# whether the auto-load dir still loads. Restore configs afterwards.

oc_bak="$(mktemp)"
cli_bak="$(mktemp)"
cp "$OC_JSON" "$oc_bak"
cp "$CLI_JSON" "$cli_bak"
restore_config() {
  cp "$oc_bak" "$OC_JSON"
  cp "$cli_bak" "$CLI_JSON"
  rm -f "$oc_bak" "$cli_bak"
}
trap restore_config EXIT

echo "== D10: config plugins entry (current scratch) =="
export PROBE_OUT="$INSTALL_CONFIG_OUT"
list_plugins "$PLUGIN_LIST_CONFIG"
echo "plugin list (config):"
plugin_ids "$PLUGIN_LIST_CONFIG" || true
if jsonl_has_setup "$INSTALL_CONFIG_OUT"; then
  echo "config-entry: probe setup LOGGED"
else
  echo "config-entry: probe setup NOT logged (see $PLUGIN_LIST_CONFIG)"
fi

echo "== D10: auto-load dir only (plugins keys removed) =="
python3 -c '
import json,sys
p=sys.argv[1]
d=json.load(open(p))
d.pop("plugins", None)
json.dump(d, open(p,"w"), indent=2)
open(p,"a").write("\n")
' "$OC_JSON"
printf '{}\n' > "$CLI_JSON"
export PROBE_OUT="$INSTALL_AUTO_OUT"
list_plugins "$PLUGIN_LIST_AUTO"
echo "plugin list (autoload):"
plugin_ids "$PLUGIN_LIST_AUTO" || true
if jsonl_has_setup "$INSTALL_AUTO_OUT"; then
  echo "auto-load dir: probe setup LOGGED"
else
  echo "auto-load dir: probe setup NOT logged (see $PLUGIN_LIST_AUTO)"
fi

restore_config
trap - EXIT

# ---- main drill (headless run, same as live-test.sh) ----
echo "== main drill: opencode2 run --standalone =="
export PROBE_OUT="$OUT"
: > "$OUT"
(
  cd "$SCRATCH" || exit 1
  timeout 300 opencode2 run --standalone --print-logs --auto \
    "You MUST call the probe_tool tool with x set to the string server. Do not answer until the tool returns. Then reply DONE." \
    > "$RUN_OUT" 2> "$RUN_LOG"
) || true

echo "== log bytes: $(wc -c < "$OUT" | tr -d ' ') =="
if [[ -s "$OUT" ]]; then
  echo "== events =="
  python3 -c '
import json,sys
from collections import Counter
c=Counter()
for line in open(sys.argv[1]):
    if not line.strip(): continue
    try:
        c[json.loads(line)["kind"]] += 1
    except Exception:
        c["(parse-error)"] += 1
print("\n".join(f"{k}: {v}" for k,v in sorted(c.items())))
' "$OUT"
else
  echo "NO server-probe.jsonl events — probe did not load or run (see $RUN_LOG)"
fi

echo "== done (findings are in jsonl; this script does not fail on REFUTED) =="
