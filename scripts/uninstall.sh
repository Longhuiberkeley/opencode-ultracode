#!/usr/bin/env bash
# Remove an ultracode plugin re-export install (D10). No network.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: uninstall.sh [--project DIR] [--global] [--purge] [--purge-workflows] [--yes] [--repo PATH]

Remove the ultracode re-export files this installer wrote. Never touches other
plugins. Idempotent: safe to run twice.

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
WF_DIR="$OPENCODE_DIR/workflows"
RUNS_DIR="$WF_DIR/runs"
SKILL_MIRROR="$WF_DIR/ultracode-skill.md"
SKILL_REPO="$REPO/skills/ultracode.md"

remove_if_ours() {
  local file="$1"
  local marker="$2"
  if [[ ! -e "$file" ]]; then
    return 0
  fi
  if grep -F -q -- "$marker" "$file"; then
    rm -f "$file"
    echo "removed $file"
  else
    echo "leaving $file (does not re-export $marker)"
  fi
}

remove_if_ours "$INDEX_FILE" "$REPO/src/index.ts"
remove_if_ours "$TUI_FILE" "$REPO/src/tui.tsx"

if [[ -d "$PLUGIN_DIR" ]]; then
  if [[ -z "$(ls -A "$PLUGIN_DIR" 2>/dev/null || true)" ]]; then
    rmdir "$PLUGIN_DIR"
    echo "removed empty $PLUGIN_DIR"
  fi
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
  if [[ "$YES" -eq 0 ]]; then
    if [[ ! -t 0 ]]; then
      die "--purge-workflows requires confirmation; re-run with --yes"
    fi
    printf 'Delete saved workflow pairs (*.js / *.json) in %s? [y/N] ' "$WF_DIR"
    read -r ans
    case "$ans" in
      y | Y | yes | YES) ;;
      *)
        echo "saved workflows left untouched"
        PURGE_WORKFLOWS=0
        ;;
    esac
  fi
  if [[ "$PURGE_WORKFLOWS" -eq 1 && -d "$WF_DIR" ]]; then
    shopt -s nullglob
    for js in "$WF_DIR"/*.js; do
      base="${js%.js}"
      rm -f "$js"
      echo "removed $js"
      if [[ -f "$base.json" ]]; then
        rm -f "$base.json"
        echo "removed $base.json"
      fi
    done
    for json in "$WF_DIR"/*.json; do
      rm -f "$json"
      echo "removed $json"
    done
    shopt -u nullglob
  fi
else
  echo "saved workflows left untouched (pass --purge-workflows to delete *.js/*.json pairs)"
fi

echo "uninstall complete ($OPENCODE_DIR)"
