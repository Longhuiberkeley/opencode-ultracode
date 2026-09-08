#!/usr/bin/env bash
# Load the TUI half of spike/scratch/.opencode/plugins/probe, SEND keystrokes
# into a PTY, and capture ANSI + jsonl.
#
# Default: interactive PTY driver (python pty).
# Fallback: TUI_PROBE_MODE=legacy uses the old timeout+script dump (no keys).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH="$REPO_ROOT/spike/scratch"
OUT_DIR="$REPO_ROOT/spike/out"
OUT="$OUT_DIR/tui-probe.jsonl"
SERVER_OUT="$OUT_DIR/tui-probe-server.jsonl"
PKG="$SCRATCH/.opencode/plugins/probe/package.json"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
ANSI="$OUT_DIR/tui-probe-$TS.ansi"
STRIPPED="$OUT_DIR/tui-probe-$TS.txt"
TTY_LOG="$OUT_DIR/tui-probe-tty.txt"
MODE="${TUI_PROBE_MODE:-pty}"

mkdir -p "$OUT_DIR"
: > "$OUT"
: > "$SERVER_OUT"
: > "$TTY_LOG"

export PROBE_TUI_OUT="$OUT"
export PROBE_OUT="$SERVER_OUT"

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
try:
    t=open(p,encoding="utf-8",errors="replace").read()
except FileNotFoundError:
    raise SystemExit
for needle in ["UCPROBE-CHIP","UCPROBE-PANEL","UCPROBE-DIALOG","UCPROBE-HOME"]:
    print(f"stripped has {needle}: {needle in t}")
' "$STRIPPED"
  fi
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
import errno, fcntl, os, pty, re, select, signal, struct, sys, time, termios

scratch, ansi_path, stripped_path, tty_log_path, jsonl_path = sys.argv[1:6]
cols, rows = 120, 40
deadline = time.time() + 70
buf = bytearray()

def dump():
    open(ansi_path, "wb").write(buf)
    text = re.sub(
        rb"(?:\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][0-9A-Za-z]|\x1b.)",
        b"",
        bytes(buf),
    )
    # also drop leftover C0 besides newline/tab
    text = re.sub(rb"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", b"", text)
    open(stripped_path, "wb").write(text)

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

    # boot
    pump(2.0)
    booted = wait_kind("tui-setup-done", 12.0)
    sys.stderr.write(f"  tui-setup-done={booted}\n")
    ready = wait_kind("ready-for-keys", 20.0)
    sys.stderr.write(f"  ready-for-keys={ready}\n")
    pump(1.5)
    dump()

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

trap 'cleanup_strays' EXIT

# D13: try plain .tsx first
set_tui_export "./tui.tsx"

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

# If TSX never evaluated, switch export to tui.ts and rerun once (unless already fallback)
if ! jsonl_has "$OUT" "tui-module-evaluated"; then
  echo "== D13: tui.tsx did not evaluate; retrying with ./tui.ts fallback =="
  : > "$OUT"
  : > "$SERVER_OUT"
  set_tui_export "./tui.ts"
  if [[ "$MODE" == "legacy" ]]; then
    run_legacy
  else
    run_pty || true
  fi
fi

summarize
echo "== done =="
echo "jsonl: $OUT"
echo "server jsonl: $SERVER_OUT"
echo "ansi: $ANSI"
echo "stripped: $STRIPPED"
