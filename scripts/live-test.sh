#!/usr/bin/env bash
# Live integration driver for opencode-ultracode (lead-owned; see docs/INTEGRATION-TEST.md)
# Usage: scripts/live-test.sh load|run|command|stop|skill|nested|restart
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIVE_DIR="$REPO_ROOT/spike/live"
PROBE_LOG="$REPO_ROOT/spike/out/live-log.jsonl"

mkdir -p "$LIVE_DIR/.opencode" "$REPO_ROOT/spike/out"

# Scratch location config: loads the plugin by absolute path with small caps.
cat > "$LIVE_DIR/.opencode/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "$REPO_ROOT", "options": { "concurrency": 2, "maxAgents": 4, "timeoutMs": 300000 } }
  ]
}
EOF

api() { (cd "$LIVE_DIR" && opencode2 api --standalone "$@"); }

case "${1:-}" in
  load)
    echo "== plugin list =="
    api get /api/plugin | python3 -c 'import json,sys; d=json.load(sys.stdin); print([p.get("id") for p in d.get("data",[])])'
    ;;
  run)
    echo "== headless ultracode run =="
    (cd "$LIVE_DIR" && timeout 300 opencode2 run --standalone --print-logs \
      "ultracode: Run a tiny workflow: two agents (use the explore agent) each list three files in the current directory and name the most interesting one; return a small JSON object with both answers." \
      > "$REPO_ROOT/spike/out/live-run.txt" 2> "$REPO_ROOT/spike/out/live-server.txt")
    echo "exit: $? (see spike/out/live-run.txt)"
    ;;
  command)
    echo "== /workflow via API on the most recent session =="
    SID=$(api get /api/session | python3 -c 'import json,sys; d=json.load(sys.stdin); items=d.get("data",[]); print(max(items,key=lambda s:s.get("time",{}).get("created",0))["id"] if items else "")')
    echo "session: $SID"
    api post "/api/session/$SID/command" --data "{\"command\":\"workflow\"}"
    ;;
  stop|skill|nested|restart)
    echo "step '$1' — driven manually per docs/INTEGRATION-TEST.md"
    ;;
  *)
    echo "usage: $0 load|run|command|stop|skill|nested|restart" && exit 2
    ;;
esac
