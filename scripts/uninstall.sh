#!/usr/bin/env bash
# Remove an ultracode plugin install (v2 self-contained copy or v1 shims). No network.
# Does not require the source checkout: removal is marker/layout-based.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: uninstall.sh [--project DIR] [--global] [--purge] [--purge-workflows] [--yes] [--repo PATH]

Remove the ultracode install this installer wrote (self-contained copy or v1
re-export shims). Never touches other plugins. Idempotent: safe to run twice.

  --project DIR        Project root (default: current working directory)
  --global             Uninstall from ~/.config/opencode
  --purge              Delete workflows/runs/ and the skill mirror only if it
                       still matches the repo copy. Prints a KV-residue note.
  --purge-workflows    Delete saved *.js/*.json workflow pairs (asks first;
                       skip the prompt with --yes). Off by default.
  --yes                Skip the --purge-workflows confirmation prompt
  --repo PATH          Plugin repo root (default: parent of this script)
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

PROJECT=""
GLOBAL=0
PURGE=0
PURGE_WORKFLOWS=0
YES=0
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
    --purge)
      PURGE=1
      shift
      ;;
    --purge-workflows)
      PURGE_WORKFLOWS=1
      shift
      ;;
    --yes)
      YES=1
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

PLUGIN_DIR="$OPENCODE_DIR/plugins/ultracode"
INDEX_FILE="$PLUGIN_DIR/index.ts"
TUI_FILE="$PLUGIN_DIR/tui.tsx"
MARKER_FILE="$PLUGIN_DIR/.ultracode-install"
CONFIG_JSON="$OPENCODE_DIR/opencode.json"
PACKAGE_PATH="./plugins/ultracode"
WF_DIR="$OPENCODE_DIR/workflows"
RUNS_DIR="$WF_DIR/runs"
SKILL_MIRROR="$WF_DIR/ultracode-skill.md"
SKILL_REPO="$REPO/skills/ultracode.md"

# Our own entries in the plugin dir (v2 copy install + v1 shim install).
OURS_ENTRIES=(index.ts tui.tsx .ultracode-install src skills node_modules package.json)

# Remove the plugin dir contents only when everything in it is ours:
# a marker file (v2), or v1 shim re-export files, or our copied tree.
# Foreign files are never deleted; an unrelated plugin dir is left untouched.
if [[ -d "$PLUGIN_DIR" ]]; then
  foreign=""
  while IFS= read -r entry; do
    [[ -n "$entry" ]] || continue
    name="$(basename -- "$entry")"
    keep=0
    for ours in "${OURS_ENTRIES[@]}"; do
      [[ "$name" == "$ours" ]] && keep=1 && break
    done
    if [[ "$keep" -eq 0 ]]; then
      foreign="$name"
      break
    fi
  done < <(find "$PLUGIN_DIR" -maxdepth 1 -mindepth 1 2>/dev/null || true)

  looks_ours=0
  if [[ -f "$MARKER_FILE" ]]; then
    looks_ours=1
  elif [[ -f "$INDEX_FILE" ]] && grep -F -q 'export { default } from' "$INDEX_FILE" 2>/dev/null; then
    looks_ours=1
  elif [[ -f "$PLUGIN_DIR/src/index.ts" ]]; then
    looks_ours=1
  fi

  if [[ "$looks_ours" -eq 1 && -z "$foreign" ]]; then
    for ours in "${OURS_ENTRIES[@]}"; do
      rm -rf "${PLUGIN_DIR:?}/$ours"
    done
    echo "removed ultracode install entries in $PLUGIN_DIR"
    if [[ -z "$(ls -A "$PLUGIN_DIR" 2>/dev/null || true)" ]]; then
      rmdir "$PLUGIN_DIR"
      echo "removed empty $PLUGIN_DIR"
    fi
    # Prune now-empty parents (rmdir fails safely on non-empty dirs).
    if [[ -d "$OPENCODE_DIR/plugins" && -z "$(ls -A "$OPENCODE_DIR/plugins" 2>/dev/null || true)" ]]; then
      rmdir "$OPENCODE_DIR/plugins" 2>/dev/null || true
    fi
    if [[ -d "$OPENCODE_DIR" && -z "$(ls -A "$OPENCODE_DIR" 2>/dev/null || true)" && ! -f "$CONFIG_JSON" ]]; then
      rmdir "$OPENCODE_DIR" 2>/dev/null || true
    fi
  elif [[ "$looks_ours" -eq 1 && -n "$foreign" ]]; then
    for ours in "${OURS_ENTRIES[@]}"; do
      rm -rf "${PLUGIN_DIR:?}/$ours"
    done
    echo "removed ultracode install entries in $PLUGIN_DIR (left foreign file: $foreign)"
  else
    echo "leaving $PLUGIN_DIR (not recognized as an ultracode install)"
  fi
fi

if [[ -f "$CONFIG_JSON" ]]; then
  command -v node >/dev/null 2>&1 || die "node is required to update $CONFIG_JSON"
  OPENCODE_JSON="$CONFIG_JSON" PACKAGE_PATH="$PACKAGE_PATH" REPO="$REPO" node -e '
const fs = require("fs")
const path = process.env.OPENCODE_JSON
const relative = process.env.PACKAGE_PATH
const repo = process.env.REPO
if (!path) {
  console.error("error: missing OPENCODE_JSON")
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
const want = new Set([relative, repo].filter(Boolean).map(norm))
const raw = fs.readFileSync(path, "utf8")
if (raw.trim() === "") process.exit(0)
let doc
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
if (!Object.prototype.hasOwnProperty.call(doc, "plugins") || doc.plugins == null) process.exit(0)
if (!Array.isArray(doc.plugins)) {
  console.error("error: plugins in " + path + " must be an array")
  process.exit(1)
}
const next = []
let removed = 0
for (const entry of doc.plugins) {
  const p = pkgOf(entry)
  if (p != null && want.has(norm(p))) {
    removed++
    continue
  }
  next.push(entry)
}
if (removed === 0) process.exit(0)
doc.plugins = next
fs.writeFileSync(path, JSON.stringify(doc, null, 2) + "\n")
console.log("removed " + removed + " plugins entry from " + path)
'
fi

if [[ "$PURGE" -eq 1 ]]; then
  if [[ -e "$RUNS_DIR" ]]; then
    rm -rf "$RUNS_DIR"
    echo "removed $RUNS_DIR"
  fi
  if [[ -f "$SKILL_MIRROR" ]]; then
    if [[ -f "$SKILL_REPO" ]] && cmp -s "$SKILL_MIRROR" "$SKILL_REPO"; then
      rm -f "$SKILL_MIRROR"
      echo "removed $SKILL_MIRROR (matched repo skill)"
    else
      echo "leaving $SKILL_MIRROR (not content-equal to $SKILL_REPO)"
    fi
  fi
  cat <<'EOF'
KV residue: run/result/trust keys in OpenCode project KV are harmless and are
not deleted here (no shell can compute project KV ids). They go away with an
OpenCode data reset.
EOF
fi

if [[ "$PURGE_WORKFLOWS" -eq 1 ]]; then
  command -v node >/dev/null 2>&1 || die "node is required for --purge-workflows"
  PAIR_LIST=""
  if [[ -d "$WF_DIR" ]]; then
    PAIR_LIST="$(WF_DIR="$WF_DIR" node -e '
const fs = require("fs")
const path = require("path")
const dir = process.env.WF_DIR
const NAME_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/
if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) process.exit(0)
let names
try {
  names = fs.readdirSync(dir)
} catch {
  process.exit(0)
}
const lines = []
for (const file of names.sort()) {
  if (!file.endsWith(".js")) continue
  const name = file.slice(0, -3)
  if (!NAME_RE.test(name)) continue
  const js = path.join(dir, file)
  const json = path.join(dir, name + ".json")
  try {
    if (!fs.statSync(js).isFile()) continue
    if (!fs.existsSync(json) || !fs.statSync(json).isFile()) continue
  } catch {
    continue
  }
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(json, "utf8"))
  } catch {
    continue
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) continue
  if (typeof manifest.name !== "string" || manifest.name !== name) continue
  lines.push(js)
  lines.push(json)
}
if (lines.length) process.stdout.write(lines.join("\n") + "\n")
')"
  fi
  if [[ -z "$PAIR_LIST" ]]; then
    echo "no recognized saved-workflow pairs in $WF_DIR"
  else
    echo "recognized saved-workflow pairs to delete:"
    printf '%s' "$PAIR_LIST"
    if [[ "$YES" -eq 0 ]]; then
      if [[ ! -t 0 ]]; then
        die "--purge-workflows requires confirmation; re-run with --yes"
      fi
      printf 'Delete the pairs listed above in %s? [y/N] ' "$WF_DIR"
      read -r ans
      case "$ans" in
        y | Y | yes | YES) ;;
        *)
          echo "saved workflows left untouched"
          PURGE_WORKFLOWS=0
          ;;
      esac
    fi
    if [[ "$PURGE_WORKFLOWS" -eq 1 ]]; then
      while IFS= read -r file; do
        [[ -n "$file" ]] || continue
        rm -f "$file"
        echo "removed $file"
      done <<< "$PAIR_LIST"
    fi
  fi
else
  echo "saved workflows left untouched (pass --purge-workflows to delete *.js/*.json pairs)"
fi

echo "uninstall complete ($OPENCODE_DIR)"
