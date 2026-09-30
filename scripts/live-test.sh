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
    echo "== plugin list (after activation) =="
    (cd "$LIVE_DIR" && timeout 120 opencode2 api --standalone post /api/plugin/await-activation > /dev/null 2>&1; \
      opencode2 api --standalone get /api/plugin | python3 -c 'import json,sys; d=json.load(sys.stdin); data=d.get("data",d) if isinstance(d,dict) else d; print([p.get("id") for p in (data or [])])')
    ;;
  run)
    echo "== headless ultracode run =="
    (cd "$LIVE_DIR" && timeout 300 opencode2 run --standalone --print-logs \
      "ultracode: Run a tiny workflow: two agents (use the explore agent) each list three files in the current directory and name the most interesting one; return a small JSON object with both answers." \
      > "$REPO_ROOT/spike/out/live-run.txt" 2> "$REPO_ROOT/spike/out/live-server.txt")
    echo "exit: $? (see spike/out/live-run.txt)"
    ;;
  command)
    echo "== /ultracode via API on the most recent session =="
    SID=$(api get /api/session | python3 -c 'import json,sys; d=json.load(sys.stdin); items=d.get("data",[]); print(max(items,key=lambda s:s.get("time",{}).get("created",0))["id"] if items else "")')
    echo "session: $SID"
    api post "/api/session/$SID/command" --data "{\"command\":\"ultracode\"}"
    ;;
  stop|skill|nested)
    echo "step '$1' — driven manually per docs/INTEGRATION-TEST.md"
    ;;
  restart)
    # §7 SIGKILL leg: boot a server with a run, kill -9 the process tree
    # mid-run, then load a replacement process and assert the persisted run
    # reads interrupted (with a warm-rerun hint) — never a running zombie.
    echo "== SIGKILL restart leg (docs/INTEGRATION-TEST.md §7) =="
    OUT="$REPO_ROOT/spike/out/live-kill"
    (cd "$LIVE_DIR" && opencode2 run --standalone --print-logs \
      "ultracode: Run three agents sequentially with the explore agent; each lists files in this directory and summarizes one in a sentence; checkpoint after each; return a JSON object with the three summaries." \
      > "$OUT-run.txt" 2> "$OUT-server.txt") &
    RUN_PID=$!
    echo "server pid: $RUN_PID — waiting for the run to start..."
    RUN_ID=""
    for _ in $(seq 1 90); do
      RUN_ID=$(grep -oE 'run_[a-z0-9]{12}' "$OUT-run.txt" "$OUT-server.txt" 2>/dev/null | head -1 | cut -d: -f2)
      [ -n "$RUN_ID" ] && break
      sleep 1
    done
    if [ -z "$RUN_ID" ]; then
      echo "NO-GO: no run started within 90s (see $OUT-run.txt / $OUT-server.txt)"
      kill "$RUN_PID" 2>/dev/null; exit 1
    fi
    echo "run: $RUN_ID — letting at least one child spawn..."
    sleep 8
    echo "kill -9 (process tree of $RUN_PID)"
    pkill -9 -P "$RUN_PID" 2>/dev/null
    kill -9 "$RUN_PID" 2>/dev/null
    wait "$RUN_PID" 2>/dev/null
    echo "replacement process loads (plugin init runs startup reconcile)..."
    SID=$(api get /api/session | python3 -c 'import json,sys; d=json.load(sys.stdin); items=d.get("data",[]); print(max(items,key=lambda s:s.get("time",{}).get("created",0))["id"] if items else "")')
    api post "/api/session/$SID/command" --data "{\"command\":\"ultracode show $RUN_ID\"}" | tee "$OUT-after.txt"
    echo ""
    echo "EXPECT in the output above: run $RUN_ID status interrupted; stopReason names the dead owner"
    echo "(server restart ... gone) and carries 'rerun $RUN_ID --warm'; no row keeps status running."
    echo "Deterministic twin of this leg: node --experimental-strip-types --test test/restart-sim.test.ts"
    ;;
  *)
    echo "usage: $0 load|run|command|stop|skill|nested|restart" && exit 2
    ;;
esac
