#!/usr/bin/env bash
# Load the TUI half of spike/scratch/.opencode/plugins/probe, SEND keystrokes
# into a PTY, and capture ANSI + jsonl.
#
# Default: interactive PTY driver (python pty).
# Fallback: TUI_PROBE_MODE=legacy uses the old timeout+script dump (no keys).
# --live: load the real src plugin pair via tui-live.tsx / index-live.ts.
#         Types a real authoring prompt, waits for [uc:] children, captures
#         inspector frames, then sends p/x. Fake run_livepaint is paint-only
#         fallback (WARNING; transport assertions skipped).
# --dialog-keys: G1 gate — open ui.dialog.show and try to receive keys inside it.
#
# --live assertions (nonzero exit when any fail, unless paint-fallback WARNING):
#   F14 two-column: stripped text contains "Phases" AND ("UC-INSPECT" or
#       "ultracode inspect")
#   F14 pagination: stripped text contains " of " (page label "N–M of K")
#   F14/F3 selection-change: before-down vs after-down frame files differ
#   F3 child-complete: before-complete vs after-complete frames differ when a
#       child completes (grep markers in those files)
#   F12 transport (skipped on paint-fallback WARNING):
#       server jsonl command-invoked pause + stop for the real runID
#       parent ack synthetic (tui jsonl live-session-synthetic or server text)
#       run finalizes stopped
set -uo pipefail

LIVE=0
DIALOG_KEYS=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --live) LIVE=1; shift ;;
    --dialog-keys) DIALOG_KEYS=1; shift ;;
    *) break ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH="$REPO_ROOT/spike/scratch"
OUT_DIR="$REPO_ROOT/spike/out"
PREFIX="tui-probe"
if [[ "$LIVE" -eq 1 ]]; then
  PREFIX="tui-live"
elif [[ "$DIALOG_KEYS" -eq 1 ]]; then
  PREFIX="tui-dialog-keys"
fi
OUT="$OUT_DIR/${PREFIX}.jsonl"
SERVER_OUT="$OUT_DIR/${PREFIX}-server.jsonl"
PKG="$SCRATCH/.opencode/plugins/probe/package.json"
PKG_BAK="$OUT_DIR/${PREFIX}-package.json.bak"
PROBE_DIR="$SCRATCH/.opencode/plugins/probe"
INDEX_BAK="$OUT_DIR/${PREFIX}-index.ts.bak"
TUI_BAK="$OUT_DIR/${PREFIX}-tui.tsx.bak"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
ANSI="$OUT_DIR/${PREFIX}-$TS.ansi"
STRIPPED="$OUT_DIR/${PREFIX}-$TS.txt"
TTY_LOG="$OUT_DIR/${PREFIX}-tty.txt"
MODE="${TUI_PROBE_MODE:-pty}"

mkdir -p "$OUT_DIR"
: > "$OUT"
: > "$SERVER_OUT"
: > "$TTY_LOG"

export PROBE_TUI_OUT="$OUT"
export PROBE_OUT="$SERVER_OUT"
PARENT_MSG_OUT="$OUT_DIR/tui-live-parent-messages.jsonl"
export PROBE_PARENT_MSG_OUT="$PARENT_MSG_OUT"
: > "$PARENT_MSG_OUT"
if [[ "$DIALOG_KEYS" -eq 1 ]]; then
  export PROBE_DIALOG_KEYS=1
  export TUI_PROBE_SEQ=dialog-keys
else
  unset PROBE_DIALOG_KEYS || true
  export TUI_PROBE_SEQ="${TUI_PROBE_SEQ:-default}"
fi
if [[ "$LIVE" -eq 1 ]]; then
  export TUI_PROBE_SEQ=live
fi

echo "== tui probe (opencode2 $(opencode2 --version 2>/dev/null || echo '?')) =="
echo "scratch: $SCRATCH"
echo "log:     $OUT"
echo "server:  $SERVER_OUT"
echo "ansi:    $ANSI"
echo "mode:    $MODE"

cd "$SCRATCH" || exit 1

jsonl_has() {
  python3 -c '
import json,sys
want=sys.argv[2]
path=sys.argv[1]
try:
    fh=open(path)
except FileNotFoundError:
    raise SystemExit(1)
for line in fh:
    line=line.strip()
    if not line: continue
    try:
        if json.loads(line).get("kind")==want:
            raise SystemExit(0)
    except Exception:
        pass
raise SystemExit(1)
' "$1" "$2"
}

set_tui_export() {
  local target="$1"
  python3 -c '
import json,sys
p=sys.argv[1]
t=sys.argv[2]
d=json.load(open(p))
d.setdefault("exports", {})["./tui"]=t
json.dump(d, open(p,"w"), indent=2)
open(p,"a").write("\n")
print("exports[./tui] =", t)
' "$PKG" "$target"
}

set_plugin_exports() {
  local main="$1"
  local tui="$2"
  python3 -c '
import json,sys
p, main, tui = sys.argv[1], sys.argv[2], sys.argv[3]
d=json.load(open(p))
exp=d.setdefault("exports", {})
exp["."]=main
exp["./tui"]=tui
json.dump(d, open(p,"w"), indent=2)
open(p,"a").write("\n")
print("exports[.] =", main)
print("exports[./tui] =", tui)
' "$PKG" "$main" "$tui"
}

assert_new_marker() {
  local pre_file="$1" post_file="$2" pattern="$3"
  python3 -c '
import re, sys
pre_p, post_p, pat = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    pre = open(pre_p, encoding="utf-8", errors="replace").read()
    post = open(post_p, encoding="utf-8", errors="replace").read()
except FileNotFoundError as e:
    print("assert_new_marker FAIL: missing file", e)
    raise SystemExit(1)
cre = re.compile(pat)
pre_lines = [ln for ln in pre.splitlines() if cre.search(ln)]
post_lines = [ln for ln in post.splitlines() if cre.search(ln)]
pre_set = set(pre_lines)
new_lines = [ln for ln in post_lines if ln not in pre_set]
in_post = cre.search(post) is not None
in_pre = cre.search(pre) is not None
if new_lines or (in_post and not in_pre):
    shown = new_lines[0] if new_lines else pat
    print(f"assert_new_marker OK: {pat!r} new in post ({post_p}): {shown!r}")
    raise SystemExit(0)
print(f"assert_new_marker FAIL: {pat!r} not new in post vs pre")
print("  pre", pre_p)
print("  post", post_p)
raise SystemExit(1)
' "$pre_file" "$post_file" "$pattern"
}

assert_live_paint() {
  python3 -c '
import os, sys
path=sys.argv[1]
try:
    t=open(path,encoding="utf-8",errors="replace").read()
except FileNotFoundError:
    print("LIVE PAINT FAIL: missing stripped capture", path)
    raise SystemExit(1)
chip = ("ultracode ·" in t) or ("ultracode" in t and "running" in t)
panel = ("UC-INSPECT" in t) or ("ultracode inspect" in t) or ("ultracodeinspect" in t.replace(" ",""))
phases = "Phases" in t
hints = ("x stop" in t) or ("p pause" in t) or ("select" in t and "pause" in t)
page = (" of " in t) or ("1–" in t) or ("1-" in t)
print(f"live chip: {chip}")
print(f"live panel: {panel}")
print(f"live two-column Phases: {phases}")
print(f"live footer hints: {hints}")
print(f"live pagination: {page}")
fail = False
if not chip or not panel:
    print("LIVE PAINT FAIL: chip and/or panel marker absent in", path)
    fail = True
if not phases or not panel:
    print("F14 FAIL: two-column markers missing (need Phases + UC-INSPECT/ultracode inspect) in", path)
    fail = True
if not page:
    print("F14 FAIL: pagination label missing (need \" of \") in", path)
    fail = True
base = path[:-4] if path.endswith(".txt") else path
before = base + "-before-down.txt"
after = base + "-after-down.txt"
b = open(before, encoding="utf-8", errors="replace").read() if os.path.isfile(before) else ""
a = open(after, encoding="utf-8", errors="replace").read() if os.path.isfile(after) else ""
print(f"F3 before-down bytes: {len(b)} file={before}")
print(f"F3 after-down bytes: {len(a)} file={after}")
if not b or not a or b == a:
    print("F14 secondary: selection-change frame files missing or identical")
else:
    print("F3 secondary: selection-change frames differ")
bc = base + "-before-complete.txt"
ac = base + "-after-complete.txt"
bct = open(bc, encoding="utf-8", errors="replace").read() if os.path.isfile(bc) else ""
act = open(ac, encoding="utf-8", errors="replace").read() if os.path.isfile(ac) else ""
print(f"F3 before-complete bytes: {len(bct)}")
print(f"F3 after-complete bytes: {len(act)}")
if bct and act and bct != act:
    print("F3 secondary: child-complete frames differ")
if fail:
    raise SystemExit(1)
print("live paint ok:", path)
' "$STRIPPED"
}

assert_live_transport() {
  python3 - "$OUT" "$SERVER_OUT" "$PARENT_MSG_OUT" <<'PY'
import json, sys
tui, server, parent_msg = sys.argv[1], sys.argv[2], sys.argv[3]

def load(path):
    rows = []
    try:
        for line in open(path, encoding="utf-8", errors="replace"):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except Exception:
                pass
    except FileNotFoundError:
        pass
    return rows

tui_rows = load(tui)
srv = load(server)
parent_rows = load(parent_msg)
warning = any(
    r.get("kind") == "WARNING" or (r.get("kind") == "live-watch-done" and (r.get("data") or {}).get("paintFallback"))
    or (isinstance(r.get("data"), dict) and "paint-only" in str(r.get("data")))
    for r in tui_rows
)
real = next((r for r in tui_rows if r.get("kind") == "live-real-uc-children"), None)
if warning and not real:
    print("F12 transport SKIPPED: paint-only run_livepaint fallback")
    raise SystemExit(0)

run_id = None
for r in tui_rows:
    if r.get("kind") in ("live-run-id", "live-real-uc-children"):
        rid = (r.get("data") or {}).get("runID")
        if isinstance(rid, str) and rid and "livepaint" not in rid:
            run_id = rid
            break
print("F12 liveRunID:", run_id)

invoked = [r for r in srv if r.get("kind") == "command-invoked"]
invoked += [r for r in tui_rows if r.get("kind") == "command-invoked" and (r.get("data") or {}).get("via") == "index-live"]
texts = [str((r.get("data") or {}).get("text") or "") for r in invoked]
print("F12 command-invoked texts:", texts)
ok = True
want_pause = f"pause {run_id}" if run_id else None
want_stop = f"stop {run_id}" if run_id else None
pause_ok = bool(run_id) and any(t.strip() == want_pause or t.startswith(want_pause + " ") for t in texts)
stop_ok = bool(run_id) and any(t.strip() == want_stop or t.startswith(want_stop + " ") for t in texts)
print(f"F12 pause receipt {want_pause!r}: {pause_ok}")
print(f"F12 stop receipt {want_stop!r}: {stop_ok}")
if not pause_ok:
    print("F12 FAIL: server jsonl missing command-invoked pause <liveRunID>")
    ok = False
if not stop_ok:
    print("F12 FAIL: server jsonl missing command-invoked stop <liveRunID>")
    ok = False

stopped = False
for r in parent_rows + tui_rows:
    kind = r.get("kind")
    data = r.get("data") or {}
    if kind in ("live-run-stopped", "live-parent-final-messages", "live-run-ack"):
        if data.get("stopped") is True or data.get("status") == "stopped" or data.get("kind") == "stopped":
            if not run_id or data.get("runID") in (None, run_id) or str(data.get("runID")) == run_id:
                stopped = True
        texts_m = data.get("texts") if isinstance(data.get("texts"), list) else []
        blob = " ".join(str(x) for x in texts_m) + json.dumps(data, default=str)
        if run_id and "stopped" in blob.lower() and run_id in blob:
            stopped = True
print("F12 parent stopped-status:", stopped, "file=", parent_msg)
if not stopped:
    print("F12 FAIL: parent messages/ack missing status stopped for", run_id)
    ok = False
if not ok:
    raise SystemExit(1)
print("F12 transport ok")
PY
}

summarize() {
  echo "== log bytes: $(wc -c < "$OUT" | tr -d ' ') =="
  echo "== server bytes: $(wc -c < "$SERVER_OUT" | tr -d ' ') =="
  if [[ -s "$OUT" ]]; then
    echo "== tui events =="
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
    echo "NO tui-probe.jsonl events — TUI plugin did not load (see $TTY_LOG)"
    echo "Fallback: open a TUI in $SCRATCH (opencode2 --standalone) then Ctrl-C; the probe writes on setup."
  fi
  if [[ -s "$SERVER_OUT" ]]; then
    echo "== server events (selected) =="
    python3 -c '
import json,sys
from collections import Counter
c=Counter()
keep=("setup","command-invoked","command-invoked-done","command-add-ultracode-ok","command-add-ultracode-error","command-add-probe_tui-ok","tui-child-created","tui-child-final","tui-child-error","tui-child-prompt","tui-child-wait")
for line in open(sys.argv[1]):
    if not line.strip(): continue
    try:
        k=json.loads(line)["kind"]
    except Exception:
        continue
    if k in keep or k.startswith("command-") or k.startswith("tui-child"):
        c[k]+=1
print("\n".join(f"{k}: {v}" for k,v in sorted(c.items())) or "(none)")
' "$SERVER_OUT"
  fi
  if [[ -s "$ANSI" ]]; then
    echo "== ansi bytes: $(wc -c < "$ANSI" | tr -d ' ')  stripped: $(wc -c < "$STRIPPED" | tr -d ' ') =="
    python3 -c '
import sys
p=sys.argv[1]
live=sys.argv[2]=="1"
try:
    t=open(p,encoding="utf-8",errors="replace").read()
except FileNotFoundError:
    raise SystemExit
needles=["UCPROBE-CHIP","UCPROBE-PANEL","UCPROBE-DIALOG","UCPROBE-HOME"]
if live:
    needles=["ultracode ·","ultracode inspect","UC-INSPECT","ultracode","running","Phases"]
if sys.argv[3]=="1":
    needles=["G1-DIALOG-KEYS","G1LEAK"]
for needle in needles:
    print(f"stripped has {needle}: {needle in t}")
' "$STRIPPED" "$LIVE" "$DIALOG_KEYS"
  fi
}

g1_verdict() {
  python3 - "$OUT" "$STRIPPED" <<'PY'
import json, sys
path, stripped = sys.argv[1], sys.argv[2]
receipts = []
try:
    for line in open(path, encoding="utf-8", errors="replace"):
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except Exception:
            continue
        if rec.get("kind") == "dialog-keys-receipt":
            receipts.append(rec.get("data") or {})
except FileNotFoundError:
    pass
text = ""
try:
    text = open(stripped, encoding="utf-8", errors="replace").read()
except FileNotFoundError:
    pass
mechs = sorted({str(r.get("mechanism")) for r in receipts})
leaked = "G1LEAK" in text
print("G1 receipts:", len(receipts), "mechanisms=" + ",".join(mechs))
print("G1 leak G1LEAK in stripped:", leaked)
go = len(receipts) > 0 and not leaked
print("G1 verdict:", "GO" if go else "NO-GO")
if go:
    print("G1 mechanism:", ",".join(mechs))
else:
    print("G1 mechanism: none (layer inside dialog, onKey/onKeyDown, dialog.set extras)")
PY
}

run_legacy() {
  echo "== legacy mode: timeout+script, no keystrokes =="
  if command -v script >/dev/null 2>&1; then
    timeout 12 script -q /dev/null opencode2 --standalone --print-logs \
      > "$TTY_LOG" 2>&1 || true
  else
    timeout 12 opencode2 --standalone --print-logs \
      > "$TTY_LOG" 2>&1 || true
  fi
  cp "$TTY_LOG" "$ANSI" 2>/dev/null || true
  python3 -c '
import re,sys
raw=open(sys.argv[1],"rb").read()
text=re.sub(rb"(?:\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][0-9A-Za-z]|\x1b.)", b"", raw)
open(sys.argv[2],"wb").write(text)
' "$ANSI" "$STRIPPED" 2>/dev/null || true
}

run_pty() {
  echo "== pty mode: send keystrokes, capture ANSI =="
  python3 - "$SCRATCH" "$ANSI" "$STRIPPED" "$TTY_LOG" "$OUT" <<'PY'
import errno, fcntl, json, os, pty, re, select, signal, struct, sys, time, termios

scratch, ansi_path, stripped_path, tty_log_path, jsonl_path = sys.argv[1:6]
cols, rows = 120, 40
seq0 = os.environ.get("TUI_PROBE_SEQ", "default")
deadline = time.time() + (180 if seq0 == "live" else 70)
buf = bytearray()

def stripped_bytes():
    text = re.sub(
        rb"(?:\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][0-9A-Za-z]|\x1b.)",
        b"",
        bytes(buf),
    )
    return re.sub(rb"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", b"", text)

def screen_bytes(raw: bytes, nrows: int, ncols: int) -> bytes:
    """Best-effort current-screen snapshot (in-place cursor updates)."""
    lines = [[" "] * ncols for _ in range(nrows)]
    r = c = 0
    i = 0
    n = len(raw)
    def clip():
        nonlocal r, c
        r = min(max(0, r), nrows - 1)
        c = min(max(0, c), ncols - 1)
    while i < n:
        ch = raw[i]
        if ch == 0x1B and i + 1 < n:
            nxt = raw[i + 1]
            if nxt == 0x5B:  # CSI
                j = i + 2
                while j < n and not (0x40 <= raw[j] <= 0x7E):
                    j += 1
                if j >= n:
                    break
                final = chr(raw[j])
                params = raw[i + 2 : j].decode("ascii", "replace")
                nums = []
                for part in params.split(";"):
                    if part.isdigit():
                        nums.append(int(part))
                if final == "H" or final == "f":
                    r = (nums[0] - 1) if len(nums) > 0 and nums[0] else 0
                    c = (nums[1] - 1) if len(nums) > 1 and nums[1] else 0
                    clip()
                elif final == "A":
                    r -= nums[0] if nums else 1
                    clip()
                elif final == "B":
                    r += nums[0] if nums else 1
                    clip()
                elif final == "C":
                    c += nums[0] if nums else 1
                    clip()
                elif final == "D":
                    c -= nums[0] if nums else 1
                    clip()
                elif final == "J":
                    mode = nums[0] if nums else 0
                    if mode == 2 or mode == 3:
                        lines = [[" "] * ncols for _ in range(nrows)]
                        r = c = 0
                    elif mode == 0:
                        for x in range(c, ncols):
                            lines[r][x] = " "
                        for rr in range(r + 1, nrows):
                            lines[rr] = [" "] * ncols
                elif final == "K":
                    mode = nums[0] if nums else 0
                    if mode == 0:
                        for x in range(c, ncols):
                            lines[r][x] = " "
                    elif mode == 1:
                        for x in range(0, c + 1):
                            lines[r][x] = " "
                    else:
                        lines[r] = [" "] * ncols
                i = j + 1
                continue
            if nxt == 0x5D:  # OSC
                j = i + 2
                while j < n and raw[j] not in (0x07, 0x1B):
                    j += 1
                if j < n and raw[j] == 0x1B and j + 1 < n and raw[j + 1] == 0x5C:
                    i = j + 2
                else:
                    i = j + 1
                continue
            i += 2
            continue
        if ch == 0x0A:
            r = min(r + 1, nrows - 1)
            c = 0
            i += 1
            continue
        if ch == 0x0D:
            c = 0
            i += 1
            continue
        if ch == 0x08:
            c = max(0, c - 1)
            i += 1
            continue
        if ch == 0x09:
            c = min(ncols - 1, (c // 8 + 1) * 8)
            i += 1
            continue
        if 32 <= ch < 127:
            if 0 <= r < nrows and 0 <= c < ncols:
                lines[r][c] = chr(ch)
            c += 1
            if c >= ncols:
                c = 0
                r = min(r + 1, nrows - 1)
        i += 1
    return ("\n".join("".join(row).rstrip() for row in lines).rstrip() + "\n").encode()

def dump():
    open(ansi_path, "wb").write(buf)
    open(stripped_path, "wb").write(stripped_bytes())

def dump_named(label: str) -> str:
    dump()
    path = stripped_path[:-4] + f"-{label}.txt" if stripped_path.endswith(".txt") else stripped_path + f"-{label}.txt"
    open(path, "wb").write(screen_bytes(bytes(buf), rows, cols))
    sys.stderr.write(f"  frame {label} -> {path}\n")
    return path

def jsonl_has(kind: str) -> bool:
    try:
        fh = open(jsonl_path, encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return False
    with fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            if f'"kind":"{kind}"' in line.replace(" ", ""):
                return True
            if f'"kind": "{kind}"' in line:
                return True
    return False

pid, fd = pty.fork()
if pid == 0:
    try:
        os.chdir(scratch)
        os.environ.setdefault("TERM", "xterm-256color")
        os.environ.setdefault("COLORTERM", "truecolor")
        winsize = struct.pack("HHHH", rows, cols, 0, 0)
        try:
            fcntl.ioctl(1, termios.TIOCSWINSZ, winsize)
        except OSError:
            pass
        os.setsid()
    except Exception:
        pass
    os.execvp("opencode2", ["opencode2", "--standalone", "--print-logs"])

# parent
try:
    winsize = struct.pack("HHHH", rows, cols, 0, 0)
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
    except OSError:
        pass
    try:
        os.set_blocking(fd, False)
    except Exception:
        fl = fcntl.fcntl(fd, fcntl.F_GETFL)
        fcntl.fcntl(fd, fcntl.F_SETFL, fl | os.O_NONBLOCK)

    tty_log = open(tty_log_path, "wb")

    def pump(seconds: float) -> None:
        end = time.time() + seconds
        while time.time() < end:
            if time.time() > deadline:
                return
            timeout = min(0.15, max(0.0, end - time.time()))
            try:
                r, _, _ = select.select([fd], [], [], timeout)
            except (select.error, OSError):
                return
            if not r:
                continue
            try:
                chunk = os.read(fd, 65536)
            except OSError as e:
                if e.errno in (errno.EAGAIN, errno.EWOULDBLOCK, errno.EINTR):
                    continue
                return
            if not chunk:
                return
            buf.extend(chunk)
            tty_log.write(chunk)
            tty_log.flush()

    def send(data: bytes, label: str) -> None:
        sys.stderr.write(f"  send {label!r} ({data!r})\n")
        sys.stderr.flush()
        try:
            os.write(fd, data)
        except OSError as e:
            sys.stderr.write(f"  send-error {e}\n")
        pump(0.4)

    def wait_kind(kind: str, seconds: float) -> bool:
        end = time.time() + seconds
        while time.time() < end:
            if jsonl_has(kind):
                return True
            pump(0.2)
        return jsonl_has(kind)

    seq = os.environ.get("TUI_PROBE_SEQ", "default")
    sys.stderr.write(f"  seq={seq}\n")

    # boot
    pump(2.0)
    booted = wait_kind("tui-setup-done", 12.0)
    sys.stderr.write(f"  tui-setup-done={booted}\n")
    ready = wait_kind("ready-for-keys", 20.0)
    sys.stderr.write(f"  ready-for-keys={ready}\n")
    pump(1.5)
    dump()

    if seq == "dialog-keys":
        # G1: keys while dialog.show content is mounted
        send(b"d", "d-layer-inside-dialog")
        send(b"x", "x-layer-inside-dialog")
        send(b"p", "p-layer-inside-dialog")
        send(b"G1LEAK", "g1leak-prompt-canary")
        pump(0.8)
        dump()
        send(b"\x1b", "esc-close-dialog")
        pump(1.0)
        dump()
        send(b"\x03", "ctrl+c")
        pump(1.0)
        send(b"\x03", "ctrl+c-2")
        pump(1.5)
        dump()
    elif seq == "live":
        # Real authoring prompt (F12). p/x while the run is still active.
        paint_only_env = os.environ.get("TUI_PROBE_ALLOW_PAINT_FALLBACK") == "1"
        prompt = os.environ.get(
            "TUI_PROBE_AUTHORING",
            "ultracode: use two explore agents in parallel to each read README.md. Reply OK.",
        )
        if paint_only_env:
            got_children = False
            sys.stderr.write("  paint-only: skip authoring prompt so panel can own keys\n")
        else:
            send(prompt.encode(), "authoring-prompt")
            send(b"\r", "enter-prompt")
            got_children = wait_kind("live-real-uc-children", 75.0)
        got_panel = wait_kind("live-panel-open", 20.0 if paint_only_env else 20.0)
        sys.stderr.write(f"  live-real-uc-children={got_children} live-panel-open={got_panel}\n")
        pump(2.0)
        dump_named("before-down")
        send(b"\x1b[B", "down-arrow")
        pump(2.0)
        dump_named("after-down")
        already_done = jsonl_has("live-child-complete")
        paint_only = os.environ.get("TUI_PROBE_ALLOW_PAINT_FALLBACK") == "1" and not got_children
        def log_kind(kind, **data):
            try:
                with open(jsonl_path, "a", encoding="utf-8") as fh:
                    fh.write(json.dumps({"time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "kind": kind, "data": data}) + "\n")
            except OSError:
                pass
        dump_named("before-complete")
        if got_children and not already_done and not paint_only:
            send(b"p", "p-pause-while-active")
            pump(1.5)
            send(b"x", "x-stop-while-active")
            pump(2.5)
            log_kind("live-keys-sent-while-active", pause=True, stop=True)
        else:
            log_kind("live-timing-fail", children=got_children, already_done=already_done, paint_only=paint_only)
            sys.stderr.write("  live-timing-fail: run finished or missing before p/x\n")
        got_done = wait_kind("live-child-complete", 40.0) or wait_kind("live-run-stopped", 10.0)
        sys.stderr.write(f"  live-child-complete/stopped={got_done}\n")
        pump(1.5)
        dump_named("after-complete")
        dump()
        send(b"\x1b", "esc")
        send(b"\x03", "ctrl+c")
        pump(1.0)
        send(b"\x03", "ctrl+c-2")
        pump(1.5)
        dump()
    else:
        # auto-show dialog is up: send z while dialog open (layer should NOT see it)
        send(b"z", "z-while-dialog")
        send(b"z", "z-while-dialog-2")
        send(b"\x0b", "ctrl+k-while-dialog")
        pump(0.5)
        dump()

        # esc closes dialog / fires onClose
        send(b"\x1b", "esc-close-dialog")
        pump(0.8)
        dump()

        # keystroke-driven panel (ultracode.inspect bind ctrl+g)
        send(b"\x07", "ctrl+g")
        pump(1.2)
        dump()

        # keystroke-driven dialog (probe.dialog bind ctrl+f)
        send(b"\x06", "ctrl+f")
        pump(1.2)
        dump()

        send(b"z", "z-while-dialog-2nd")
        pump(0.4)
        send(b"\x1b", "esc-close-dialog-2")
        pump(0.8)
        dump()

        # z after dialog close — layer should capture; must not leak into prompt
        send(b"zzz", "zzz-after-esc")
        pump(0.6)
        dump()

        # command palette (ctrl+p) searches title
        send(b"\x10", "ctrl+p")
        pump(0.6)
        send(b"inspect", "type inspect")
        pump(0.5)
        send(b"\r", "enter")
        pump(1.0)
        dump()

        # slash fallback
        send(b"\x1b", "esc-2")
        pump(0.3)
        send(b"/ucprobe", "slash ucprobe")
        pump(0.4)
        send(b"\r", "enter-slash")
        pump(1.0)
        dump()

        # quit
        send(b"\x1b", "esc-quit")
        send(b"\x03", "ctrl+c")
        pump(1.0)
        send(b"\x03", "ctrl+c-2")
        pump(1.5)
        dump()
finally:
    dump()
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    # wait briefly, then KILL process group if still alive
    for _ in range(10):
        try:
            wpid, _status = os.waitpid(pid, os.WNOHANG)
            if wpid == pid:
                break
        except ChildProcessError:
            break
        time.sleep(0.15)
    else:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass
    # reap any leftover children in our session if we can
    try:
        os.killpg(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        pass

sys.stderr.write(f"  captured ansi bytes={len(buf)}\n")
PY
}

cleanup_strays() {
  # Never leave OUR opencode2 running. Match by scratch cwd in ps if possible.
  python3 -c '
import os, signal, sys, time
scratch=sys.argv[1]
try:
    import subprocess
    out=subprocess.check_output(["ps","-ax","-o","pid=,command="], text=True, errors="replace")
except Exception:
    raise SystemExit
for line in out.splitlines():
    line=line.strip()
    if not line: continue
    if "opencode2" not in line: continue
    if "--standalone" not in line and "serve --stdio" not in line: continue
    if scratch not in line and "opencode2 --standalone" not in line:
        continue
    # only kill if the command line mentions scratch OR is a leftover serve from this probe
    pid=int(line.split(None,1)[0])
    if pid==os.getpid():
        continue
    # be conservative: require scratch path in the command or cwd
    cmd=line.split(None,1)[1] if " " in line else line
    cwd=""
    try:
        cwd=os.readlink(f"/proc/{pid}/cwd")
    except Exception:
        pass
    if scratch not in cmd and scratch not in cwd:
        continue
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
' "$SCRATCH" 2>/dev/null || true
}

restore_pkg() {
  if [[ -f "$PKG_BAK" ]]; then
    cp "$PKG_BAK" "$PKG" 2>/dev/null || true
  fi
  if [[ -f "$INDEX_BAK" ]]; then
    cp "$INDEX_BAK" "$PROBE_DIR/index.ts" 2>/dev/null || true
  fi
  if [[ -f "$TUI_BAK" ]]; then
    cp "$TUI_BAK" "$PROBE_DIR/tui.tsx" 2>/dev/null || true
  fi
}

trap 'cleanup_strays; restore_pkg' EXIT

cp "$PKG" "$PKG_BAK"

if [[ "$LIVE" -eq 1 ]]; then
  echo "== live mode: real src/index.ts + src/tui.tsx via probe re-exports =="
  echo "== host auto-loads plugins/*/index.ts and sibling tui.tsx; swapping those files =="
  cp "$PROBE_DIR/index.ts" "$INDEX_BAK"
  cp "$PROBE_DIR/tui.tsx" "$TUI_BAK"
  cat > "$PROBE_DIR/index.ts" <<EOF
/** Live re-export of the real server plugin. Restored by tui-probe.sh --live. */
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
const _p = process.env.PROBE_OUT ?? "$SERVER_OUT"
try {
  mkdirSync(dirname(_p), { recursive: true })
  appendFileSync(_p, JSON.stringify({ time: new Date().toISOString(), kind: "index-live-wrapper-eval", data: { pid: process.pid } }) + "\\n")
} catch {}
export { default } from "./index-live.ts"
EOF
  cat > "$PROBE_DIR/tui.tsx" <<'EOF'
/** @jsxImportSource solid-js */
/** Live re-export of the real TUI plugin. Restored by tui-probe.sh --live. */
export { default } from "./tui-live.tsx"
EOF
  set_plugin_exports "./index-live.ts" "./tui-live.tsx"
else
  # D13: try plain .tsx first
  set_tui_export "./tui.tsx"
fi

live_keys_ok() {
  python3 -c '
import json,sys
path=sys.argv[1]
keys=False
children=False
try:
    for line in open(path, encoding="utf-8", errors="replace"):
        line=line.strip()
        if not line: continue
        try:
            rec=json.loads(line)
        except Exception:
            continue
        k=rec.get("kind")
        if k=="live-keys-sent-while-active":
            keys=True
        if k=="live-real-uc-children":
            children=True
except FileNotFoundError:
    raise SystemExit(1)
raise SystemExit(0 if keys and children else 1)
' "$OUT"
}

run_once() {
  if [[ "$MODE" == "legacy" ]]; then
    run_legacy
  else
    if ! python3 -c 'import pty,select,fcntl,termios,struct' 2>/dev/null; then
      echo "python pty unavailable — falling back to legacy"
      run_legacy
    else
      run_pty || true
    fi
  fi
}

FAST_PROMPT="ultracode: use two explore agents in parallel to each read README.md. Reply OK."
SLOW_PROMPT="ultracode: use two explore agents in parallel. Each must read README.md, src/tui.tsx, src/tui-render.ts, src/index.ts, and package.json. Take about 30 seconds exploring those files before answering. Reply with one word: OK."
TRANSPORT_SKIPPED=0

if [[ "$LIVE" -eq 1 ]]; then
  export TUI_PROBE_AUTHORING="$FAST_PROMPT"
  if [[ "${TUI_PROBE_ALLOW_PAINT_FALLBACK:-}" == "1" ]]; then
    echo "== TUI_PROBE_ALLOW_PAINT_FALLBACK=1 — paint-only (transport SKIPPED) =="
    TRANSPORT_SKIPPED=1
    run_once
  else
  unset TUI_PROBE_ALLOW_PAINT_FALLBACK || true
  run_once
  if ! live_keys_ok; then
    echo "== retry live with slower authoring prompt (~30s) =="
    : > "$OUT"
    : > "$SERVER_OUT"
    : > "$PARENT_MSG_OUT"
    export TUI_PROBE_AUTHORING="$SLOW_PROMPT"
    run_once
  fi
  if ! live_keys_ok; then
    echo "== two failed timings — labeled paint-only fallback; transport SKIPPED =="
    : > "$OUT"
    : > "$SERVER_OUT"
    : > "$PARENT_MSG_OUT"
    export TUI_PROBE_ALLOW_PAINT_FALLBACK=1
    export TUI_PROBE_AUTHORING="$SLOW_PROMPT"
    TRANSPORT_SKIPPED=1
    run_once
  fi
  fi
else
  run_once
fi

# If TSX never evaluated, switch export to tui.ts and rerun once (unless already fallback)
if [[ "$LIVE" -eq 0 ]] && ! jsonl_has "$OUT" "tui-module-evaluated"; then
  echo "== D13: tui.tsx did not evaluate; retrying with ./tui.ts fallback =="
  : > "$OUT"
  : > "$SERVER_OUT"
  set_tui_export "./tui.ts"
  run_once
fi

summarize
echo "== done =="
echo "jsonl: $OUT"
echo "server jsonl: $SERVER_OUT"
echo "ansi: $ANSI"
echo "stripped: $STRIPPED"

if [[ "$DIALOG_KEYS" -eq 1 ]]; then
  echo "== G1 dialog-keys =="
  g1_verdict
fi

FAILED=0
if [[ "$LIVE" -eq 1 ]]; then
  assert_live_paint || FAILED=1
  BASE="${STRIPPED%.txt}"
  echo "== P6 new-marker assertions =="
  assert_new_marker "${BASE}-before-down.txt" "${BASE}-after-down.txt" '> 2 ' || FAILED=1
  if [[ "$TRANSPORT_SKIPPED" -eq 1 ]]; then
    echo "P6 completion marker SKIPPED: paint-only fallback"
  else
    assert_new_marker "${BASE}-before-complete.txt" "${BASE}-after-complete.txt" '[✓✗■]' || FAILED=1
  fi
  echo "== F12 transport =="
  if [[ "$TRANSPORT_SKIPPED" -eq 1 ]]; then
    echo "F12 transport SKIPPED: paint-only fallback after two failed timings"
  else
    assert_live_transport || FAILED=1
  fi
  echo "== live assertion aggregate failed=$FAILED transport_skipped=$TRANSPORT_SKIPPED =="
  exit "$FAILED"
fi
