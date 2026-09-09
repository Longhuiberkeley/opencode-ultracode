#!/usr/bin/env bash
# Install ultracode as an OpenCode plugin (self-contained copy, v2). No network.
#
# Layout written into the target plugins dir:
#   plugins/ultracode/index.ts            -> relative re-export of ./src/index.ts
#   plugins/ultracode/tui.tsx  (--tui)    -> relative re-export of ./src/tui.tsx
#   plugins/ultracode/src/…               -> copied plugin sources
#   plugins/ultracode/skills/ultracode.md -> copied authoring skill
#   plugins/ultracode/package.json        -> generated package manifest
#   plugins/ultracode/node_modules/…      -> runtime deps (@opencode/plugin tree)
#   plugins/ultracode/.ultracode-install  -> install marker (uninstall safety)
#
# The installed tree is relocatable: it contains NO absolute paths and keeps
# working after the source checkout is moved or deleted. (v1 installs wrote
# absolute-path re-export shims; the OpenCode TUI client refuses those.)
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: install.sh [--project DIR] [--global] [--tui] [--write-config] [--no-deps] [--repo PATH]

Install the ultracode plugin as a self-contained copy in the OpenCode plugin
directory. Idempotent: reruns rebuild the same tree. No network required.

  --project DIR     Project root (default: current working directory)
  --global          Install into ~/.config/opencode (not DIR/.opencode)
  --tui             Also write sibling tui.tsx (inspect UI is opt-in)
  --write-config    Merge a plugins entry into opencode.json if missing
  --no-deps         Skip the node_modules copy (tests/dev only — the plugin
                    then requires @opencode/plugin resolution from elsewhere)
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
NO_DEPS=0
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
    --no-deps)
      NO_DEPS=1
      shift
      ;;
    --repo)
      [[ $# -ge 2 ]] || die "--repo requires a directory"
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

[[ -f "$REPO/src/index.ts" ]] || die "repo is missing src/index.ts: $REPO"
[[ -f "$REPO/src/tui.tsx" ]] || die "repo is missing src/tui.tsx: $REPO"
[[ -f "$REPO/skills/ultracode.md" ]] || die "repo is missing skills/ultracode.md: $REPO"
[[ -f "$REPO/package.json" ]] || die "repo is missing package.json: $REPO"

if [[ "$NO_DEPS" -eq 0 && ! -e "$REPO/node_modules/@opencode/plugin" ]]; then
  die "run npm install in $REPO (or pass --no-deps to skip the dependency copy)"
fi

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
MARKER="$PLUGIN_DIR/.ultracode-install"

# ---------------------------------------------------------------------------
# Ownership safety: only touch a plugin dir that is ours (marker file) or a
# v1 shim install (2-line absolute-path re-export). Refuse on anything else.
# ---------------------------------------------------------------------------

# ours iff every top-level entry is one we write AND the dir looks like an
# ultracode install (marker, re-export entry, or copied src tree). An empty
# dir (interrupted install) also counts — reruns must recover, not brick.
is_ours() {
  [[ -d "$PLUGIN_DIR" ]] || return 1
  local foreign
  foreign="$(find "$PLUGIN_DIR" -maxdepth 1 -mindepth 1 \
    ! -name 'index.ts' ! -name 'tui.tsx' ! -name '.ultracode-install' \
    ! -name 'src' ! -name 'skills' ! -name 'node_modules' ! -name 'package.json' \
    ! -name 'LICENSE' \
    -print -quit 2>/dev/null || true)"
  [[ -z "$foreign" ]] || return 1
  [[ -f "$MARKER" ]] && return 0
  [[ -f "$PLUGIN_DIR/src/index.ts" ]] && return 0
  if [[ -f "$PLUGIN_DIR/index.ts" ]]; then
    grep -F -q 'export { default } from' "$PLUGIN_DIR/index.ts" 2>/dev/null && return 0
  fi
  # Empty (or marker-less and file-less): interrupted install — recoverable.
  [[ -z "$(ls -A "$PLUGIN_DIR" 2>/dev/null || true)" ]] && return 0
  return 1
}

if [[ -L "$PLUGIN_DIR" ]]; then
  die "refusing to install through symlink $PLUGIN_DIR — remove the link first"
fi
if [[ -d "$PLUGIN_DIR" ]] && ! is_ours; then
  die "refusing to overwrite $PLUGIN_DIR — it contains files this installer did not write"
fi

# ---------------------------------------------------------------------------
# Build the tree (clean rebuild of our own entries; preserves foreign files)
# ---------------------------------------------------------------------------

VERSION="$(PLUGIN_JSON="$REPO/package.json" node -e '
const fs = require("fs")
try {
  const doc = JSON.parse(fs.readFileSync(process.env.PLUGIN_JSON, "utf8"))
  process.stdout.write(String(doc.version || "0.0.0"))
} catch { process.stdout.write("0.0.0") }
')"

PLUGIN_DEP="$(PLUGIN_JSON="$REPO/package.json" node -e '
const fs = require("fs")
try {
  const doc = JSON.parse(fs.readFileSync(process.env.PLUGIN_JSON, "utf8"))
  const deps = doc.dependencies || {}
  process.stdout.write(JSON.stringify({ "@opencode/plugin": deps["@opencode/plugin"] || "*" }))
} catch { process.stdout.write(JSON.stringify({ "@opencode/plugin": "*" })) }
')"

mkdir -p "$PLUGIN_DIR" || die "target dir is not writable: $TARGET"

# Remove our own previous entries (foreign files are never touched).
rm -rf "$PLUGIN_DIR/src" "$PLUGIN_DIR/skills" "$PLUGIN_DIR/node_modules"
rm -f "$PLUGIN_DIR/index.ts" "$PLUGIN_DIR/tui.tsx" "$PLUGIN_DIR/package.json" \
  "$PLUGIN_DIR/.ultracode-install" "$PLUGIN_DIR/LICENSE"

# Sources + skill (src/index.ts resolves ../skills/ultracode.md via import.meta.url).
cp -Rp "$REPO/src" "$PLUGIN_DIR/src"
mkdir -p "$PLUGIN_DIR/skills"
cp -p "$REPO/skills/ultracode.md" "$PLUGIN_DIR/skills/ultracode.md"
# License travels with the copy (redistribution correctness).
if [[ -f "$REPO/LICENSE" ]]; then
  cp -p "$REPO/LICENSE" "$PLUGIN_DIR/LICENSE"
fi

# Runtime dependency tree (typescript is a devDependency — skip it).
if [[ "$NO_DEPS" -eq 0 ]]; then
  mkdir -p "$PLUGIN_DIR/node_modules"
  for entry in "$REPO"/node_modules/*; do
    name="$(basename -- "$entry")"
    [[ "$name" == "typescript" ]] && continue
    [[ "$name" == ".bin" || "$name" == ".package-lock.json" ]] && continue
    cp -Rp "$entry" "$PLUGIN_DIR/node_modules/$name"
  done
fi

# Generated package manifest (kept in sync with the repo version).
VERSION="$VERSION" PLUGIN_DEP="$PLUGIN_DEP" node -e '
const fs = require("fs")
const version = process.env.VERSION || "0.0.0"
const deps = JSON.parse(process.env.PLUGIN_DEP || "{}")
const doc = {
  name: "opencode-ultracode",
  version,
  description: "Claude Code-style dynamic workflows (ultracode) for OpenCode v2",
  type: "module",
  main: "src/index.ts",
  exports: {
    ".": "./src/index.ts",
    "./tui": "./src/tui.tsx",
  },
  dependencies: deps,
  private: true,
}
fs.writeFileSync(process.argv[1], JSON.stringify(doc, null, 2) + "\n")
' "$PLUGIN_DIR/package.json"

# Entry points: RELATIVE re-exports (the TUI client rejects absolute paths).
printf '%s\n' 'export { default } from "./src/index.ts"' >"$PLUGIN_DIR/index.ts"
echo "wrote $PLUGIN_DIR/index.ts"

if [[ "$TUI" -eq 1 ]]; then
  printf '%s\n' '/** @jsxImportSource solid-js */' 'export { default } from "./src/tui.tsx"' >"$PLUGIN_DIR/tui.tsx"
  echo "wrote $PLUGIN_DIR/tui.tsx"
fi

# Install marker (uninstall removes the tree only when this is present).
printf '%s\n' "{\"v\":2,\"version\":\"$VERSION\",\"tui\":$TUI}" >"$MARKER"
echo "wrote $MARKER (self-contained copy, version $VERSION)"

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
Relocatable: yes — the installed tree has no absolute paths and no dependency
             on the source checkout.
EOF
