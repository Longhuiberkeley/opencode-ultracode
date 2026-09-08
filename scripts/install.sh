#!/usr/bin/env bash
# Install ultracode as an OpenCode plugin re-export (D10). No network.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: install.sh [--project DIR] [--global] [--tui] [--write-config] [--repo PATH]

Install the ultracode plugin by writing a re-export into the OpenCode auto-load
directory. Idempotent: reruns rewrite the same files and never duplicate config.

  --project DIR     Project root (default: current working directory)
  --global          Install into ~/.config/opencode (not DIR/.opencode)
  --tui             Also write sibling tui.tsx (inspect UI is opt-in)
  --write-config    Merge a plugins entry into opencode.json if missing
  --repo PATH       Plugin repo root (default: parent of this script)

Preconditions: npm install has been run in the plugin repo; the target is writable.
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

PROJECT=""
GLOBAL=0
TUI=0
WRITE_CONFIG=0
REPO_ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --project)
      [[ $# -ge 2 ]] || die "--project requires a directory"
      PROJECT="$2"
      shift 2
      ;;
    --global)
      GLOBAL=1
      shift
      ;;
    --tui)
      TUI=1
      shift
      ;;
    --write-config)
      WRITE_CONFIG=1
      shift
      ;;
    --repo)
      [[ $# -ge 2 ]] || die "--repo requires a path"
      REPO_ARG="$2"
      shift 2
      ;;
    *)
      die "unknown flag: $1"
      ;;
  esac
done

if [[ "$GLOBAL" -eq 1 && -n "$PROJECT" ]]; then
  die "use either --project DIR or --global, not both"
fi

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
if [[ -n "$REPO_ARG" ]]; then
  [[ -d "$REPO_ARG" ]] || die "repo path is not a directory: $REPO_ARG"
  REPO="$(CDPATH= cd -- "$REPO_ARG" && pwd -P)"
else
  REPO="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd -P)"
fi

if [[ ! -e "$REPO/node_modules/@opencode/plugin" ]]; then
  die "run npm install in $REPO"
fi
[[ -f "$REPO/src/index.ts" ]] || die "repo is missing src/index.ts: $REPO"
[[ -f "$REPO/src/tui.tsx" ]] || die "repo is missing src/tui.tsx: $REPO"

if [[ "$GLOBAL" -eq 1 ]]; then
  [[ -n "${HOME:-}" ]] || die "HOME is unset"
  TARGET="${HOME}/.config/opencode"
  OPENCODE_DIR="$TARGET"
else
  if [[ -n "$PROJECT" ]]; then
    TARGET="$PROJECT"
  else
    TARGET="$PWD"
  fi
  [[ -d "$TARGET" ]] || die "target dir does not exist: $TARGET"
  TARGET="$(CDPATH= cd -- "$TARGET" && pwd -P)"
  OPENCODE_DIR="$TARGET/.opencode"
fi

if [[ ! -d "$TARGET" ]]; then
  mkdir -p "$TARGET" || die "target dir is not writable: $TARGET"
fi
[[ -w "$TARGET" ]] || die "target dir is not writable: $TARGET"

PLUGIN_DIR="$OPENCODE_DIR/plugins/ultracode"
CONFIG_JSON="$OPENCODE_DIR/opencode.json"
PACKAGE_PATH="./plugins/ultracode"
INDEX_SRC="$REPO/src/index.ts"
TUI_SRC="$REPO/src/tui.tsx"

ts_string() {
  SRC_PATH="$1" node -e 'process.stdout.write(JSON.stringify(process.env.SRC_PATH ?? ""))'
}

write_reexport() {
  local dest="$1"
  local src="$2"
  local pragma="${3:-}"
  mkdir -p "$(dirname -- "$dest")"
  {
    if [[ -n "$pragma" ]]; then
      printf '%s\n' "$pragma"
    fi
    printf 'export { default } from %s\n' "$(ts_string "$src")"
  } >"$dest"
}

mkdir -p "$PLUGIN_DIR" || die "target dir is not writable: $TARGET"
write_reexport "$PLUGIN_DIR/index.ts" "$INDEX_SRC"
echo "wrote $PLUGIN_DIR/index.ts"

if [[ "$TUI" -eq 1 ]]; then
  write_reexport "$PLUGIN_DIR/tui.tsx" "$TUI_SRC" "/** @jsxImportSource solid-js */"
  echo "wrote $PLUGIN_DIR/tui.tsx"
fi

if [[ "$WRITE_CONFIG" -eq 1 ]]; then
  command -v node >/dev/null 2>&1 || die "node is required for --write-config"
  mkdir -p "$OPENCODE_DIR"
  OPENCODE_JSON="$CONFIG_JSON" PACKAGE_PATH="$PACKAGE_PATH" node -e '
const fs = require("fs")
const path = process.env.OPENCODE_JSON
const spec = process.env.PACKAGE_PATH
if (!path || !spec) {
  console.error("error: missing OPENCODE_JSON or PACKAGE_PATH")
  process.exit(1)
}
function pkgOf(entry) {
  if (typeof entry === "string") return entry
  if (entry && typeof entry === "object" && typeof entry.package === "string") return entry.package
  return null
}
function norm(p) {
  return String(p).replace(/\/+$/, "")
}
let doc = {}
let existed = false
if (fs.existsSync(path)) {
  existed = true
  const raw = fs.readFileSync(path, "utf8")
  if (raw.trim() !== "") {
    try {
      doc = JSON.parse(raw)
    } catch (err) {
      console.error("error: cannot parse " + path + ": " + (err && err.message ? err.message : err))
      process.exit(1)
    }
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
      console.error("error: " + path + " root must be a JSON object")
      process.exit(1)
    }
  }
}
if (!Object.prototype.hasOwnProperty.call(doc, "plugins") || doc.plugins == null) {
  doc.plugins = []
}
if (!Array.isArray(doc.plugins)) {
  console.error("error: plugins in " + path + " must be an array")
  process.exit(1)
}
const want = norm(spec)
const found = doc.plugins.some((entry) => {
  const p = pkgOf(entry)
  return p != null && norm(p) === want
})
if (!found) {
  doc.plugins.push({ package: spec })
  fs.writeFileSync(path, JSON.stringify(doc, null, 2) + "\n")
  console.log((existed ? "updated " : "wrote ") + path + " (plugins entry " + spec + ")")
} else {
  console.log("plugins entry already present in " + path + " (" + spec + ") — left unchanged")
}
'
else
  cat <<EOF
Optional config (auto-load of plugins/*/index.ts is enough on OpenCode beta-19271).
Pass --write-config to merge this, or add it yourself at $CONFIG_JSON:

{
  "plugins": [
    { "package": "$PACKAGE_PATH" }
  ]
}
EOF
fi

cat <<EOF

Next steps:
  1. In a project session, send a normal message with the standalone keyword
     ultracode (no leading slash), e.g. \`please ultracode this\` or
     \`ultracode: audit src/auth\`.
  2. Saved workflows (samples included) need a one-time approval:
     /ultracode trust <name>
  3. TUI inspect (chip + panel) is opt-in. $(
    if [[ "$TUI" -eq 1 ]]; then
      printf '%s' "This install wrote tui.tsx. Remove it or rerun without --tui and uninstall the sibling to opt out."
    else
      printf '%s' "Rerun with --tui to write sibling tui.tsx (host auto-loads it next to index.ts)."
    fi
  )

Plugin repo: $REPO
Load path:   $PLUGIN_DIR
EOF
