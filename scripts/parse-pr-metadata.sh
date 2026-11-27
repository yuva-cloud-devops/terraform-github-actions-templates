#!/usr/bin/env bash
set -euo pipefail

TARGET_ENV="${DEFAULT_ENV:-dev}"
SKIP_CI="false"
STACKS_JSON="[]"
DEPLOY_DESC=""
CONFIG_FILE=""

echo "============================================="
echo "Parsing Deployment Metadata"
echo "============================================="

# Use PR_BODY on pull_request, or COMMIT_MSG on push (merge commit often carries PR body)
METADATA_TEXT="${PR_BODY:-}"
if [ -z "$METADATA_TEXT" ] && [ -n "${COMMIT_MSG:-}" ]; then
  METADATA_TEXT="$COMMIT_MSG"
fi

# 1. Parse structured YAML deployment_request from PR body / commit message
if echo "$METADATA_TEXT" | grep -q "deployment_request:"; then
  echo "Found structured deployment_request block."

  PARSED_OUTPUT=$(METADATA_TEXT="$METADATA_TEXT" node - <<'EOF'
const body = process.env.METADATA_TEXT || '';
// Capture deployment_request block until code fence end or blank line followed by non-YAML
const match = body.match(/deployment_request:\s*([\s\S]*?)(?=(```|$))/);
if (!match) {
  console.log(JSON.stringify({ environment: '', stacks: [], configuration: '', description: '' }));
  process.exit(0);
}

const yamlChunk = 'deployment_request:\n' + match[1];
const envMatch = yamlChunk.match(/environment:\s*([a-zA-Z0-9_-]+)/);
const env = envMatch ? envMatch[1].trim() : '';

const configMatch = yamlChunk.match(/configuration:\s*([a-zA-Z0-9_.\-\/]+)/);
const configuration = configMatch ? configMatch[1].trim() : '';

const descMatch = yamlChunk.match(/description:\s*["']?([^\n"']+)["']?/);
const description = descMatch ? descMatch[1].trim() : '';

const infraMatch = yamlChunk.match(/infrastructure:\s*([\s\S]*?)(?=(\n\s*[a-zA-Z0-9_-]+:|$))/);
const stacks = [];
if (infraMatch) {
  for (const line of infraMatch[1].split('\n')) {
    const itemMatch = line.match(/^\s*-\s*([a-zA-Z0-9_\-\/.]+)/);
    if (itemMatch) {
      stacks.push(itemMatch[1].trim());
    }
  }
}
console.log(JSON.stringify({ environment: env, stacks, configuration, description }));
EOF
)

  EXTRACTED_ENV=$(echo "$PARSED_OUTPUT" | jq -r '.environment // empty')
  EXTRACTED_CONFIG=$(echo "$PARSED_OUTPUT" | jq -r '.configuration // empty')
  EXTRACTED_DESC=$(echo "$PARSED_OUTPUT" | jq -r '.description // empty')
  EXTRACTED_STACKS=$(echo "$PARSED_OUTPUT" | jq -c '.stacks')

  if [ -n "$EXTRACTED_ENV" ]; then
    TARGET_ENV="$EXTRACTED_ENV"
  fi
  if [ -n "$EXTRACTED_CONFIG" ]; then
    CONFIG_FILE=$(basename "$EXTRACTED_CONFIG")
  fi
  if [ -n "$EXTRACTED_DESC" ]; then
    DEPLOY_DESC="$EXTRACTED_DESC"
  fi

  # Resolve stack paths cleanly (e.g. "network" -> "infrastructure/network" if it lives under infrastructure/)
  if [ "$EXTRACTED_STACKS" != "[]" ]; then
    RESOLVED_LIST=()
    while IFS= read -r item; do
      [ -z "$item" ] && continue
      if [ -d "$item" ]; then
        RESOLVED_LIST+=("$item")
      elif [ -d "infrastructure/$item" ]; then
        RESOLVED_LIST+=("infrastructure/$item")
      else
        RESOLVED_LIST+=("$item")
      fi
    done < <(echo "$EXTRACTED_STACKS" | jq -r '.[]')

    if [ ${#RESOLVED_LIST[@]} -gt 0 ]; then
      STACKS_JSON=$(printf '%s\n' "${RESOLVED_LIST[@]}" | awk '!seen[$0]++' | jq -R -s -c 'split("\n")[:-1]')
    fi
  fi
fi

# 2. Check for tag annotations e.g. [env:uat], [skip-ci] in PR title or commit message
TITLE_OR_MSG="${PR_TITLE:-${COMMIT_MSG:-}}"
if [[ "$TITLE_OR_MSG" =~ \[env:([a-zA-Z0-9_-]+)\] ]]; then
  TARGET_ENV="${BASH_REMATCH[1]}"
fi

if [[ "$TITLE_OR_MSG" =~ \[skip-ci\] ]] || [[ "$METADATA_TEXT" =~ \[skip-ci\] ]]; then
  SKIP_CI="true"
fi

# 3. Auto-detect changed files from git diff when stacks/env/configuration were not explicitly declared
DIFF_FILES=""
if [ -n "${BASE_REF:-}" ] && git rev-parse --verify "origin/${BASE_REF}" >/dev/null 2>&1; then
  DIFF_FILES=$(git diff --name-only "origin/${BASE_REF}" HEAD || true)
elif git rev-parse --verify HEAD~1 >/dev/null 2>&1; then
  DIFF_FILES=$(git diff --name-only HEAD~1 HEAD || true)
fi

if [ -n "$DIFF_FILES" ]; then
  # Auto-detect environment from changed environments/<env>/... if not explicitly given
  if [ -z "${EXTRACTED_ENV:-}" ] && ! [[ "$TITLE_OR_MSG" =~ \[env: ]]; then
    DETECTED_ENV=$(echo "$DIFF_FILES" | sed -nE 's#^(.*\/)?environments\/([a-zA-Z0-9_-]+)(\/.*|\.(yaml|yml|tfvars))$#\2#p' | head -n1 || true)
    if [ -n "$DETECTED_ENV" ]; then
      TARGET_ENV="$DETECTED_ENV"
    fi
  fi

  # Auto-detect configuration filename from changed environments/<env>/<config>.yaml if not explicitly given
  if [ -z "$CONFIG_FILE" ]; then
    DETECTED_CONFIG=$(echo "$DIFF_FILES" | sed -nE "s#^(.*\/)?environments\/${TARGET_ENV}\/([a-zA-Z0-9_.-]+\.(yaml|yml))$#\2#p" | head -n1 || true)
    if [ -n "$DETECTED_CONFIG" ]; then
      CONFIG_FILE="$DETECTED_CONFIG"
    fi
  fi

  # Discover modified Terraform stack directories if STACKS_JSON is still empty
  if [ "$STACKS_JSON" = "[]" ]; then
    FOUND_STACKS=()
    while IFS= read -r file; do
      [ -z "$file" ] && continue
      dir=$(dirname "$file")
      while [ "$dir" != "." ] && [ "$dir" != "/" ]; do
        if ls "$dir"/*.tf >/dev/null 2>&1; then
          FOUND_STACKS+=("$dir")
          break
        fi
        dir=$(dirname "$dir")
      done
    done <<< "$DIFF_FILES"

    if [ ${#FOUND_STACKS[@]} -gt 0 ]; then
      STACKS_JSON=$(printf '%s\n' "${FOUND_STACKS[@]}" | sort -u | jq -R -s -c 'split("\n")[:-1]')
    fi
  fi
fi

# 4. Fallback if still empty
if [ "$STACKS_JSON" = "[]" ]; then
  if [ -n "${WORKING_DIR:-}" ] && [ "${WORKING_DIR:-}" != "." ]; then
    STACKS_JSON="[\"${WORKING_DIR}\"]"
  elif [ -d "compute-infrastructure" ]; then
    STACKS_JSON='["compute-infrastructure"]'
  else
    STACKS_JSON='["."]'
  fi
fi

# 5. Enforce strict dependency hierarchy: foundation -> network -> security -> compute -> availability
STACKS_JSON=$(STACKS_JSON="$STACKS_JSON" node - <<'EOF'
let stacks = [];
try {
  stacks = JSON.parse(process.env.STACKS_JSON || '[]');
} catch (e) {
  stacks = [];
}

function getLayerRank(stackPath) {
  const s = stackPath.toLowerCase();
  if (/(^|[\/_-])(foundation|bootstrap)([\/_-]|$)/.test(s)) return 0;
  if (/(^|[\/_-])network([\/_-]|$)/.test(s)) return 1;
  if (/(^|[\/_-])security([\/_-]|$)/.test(s)) return 2;
  if (/(^|[\/_-])compute([\/_-]|$)/.test(s)) return 3;
  if (/(^|[\/_-])availability([\/_-]|$)/.test(s)) return 4;
  return 99;
}

const unique = [...new Set(stacks)];
unique.sort((a, b) => {
  const rankDiff = getLayerRank(a) - getLayerRank(b);
  if (rankDiff !== 0) return rankDiff;
  return a.localeCompare(b);
});

console.log(JSON.stringify(unique));
EOF
)

# Output safely to GITHUB_OUTPUT
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "target_env=${TARGET_ENV}" >> "$GITHUB_OUTPUT"
  echo "config_file=${CONFIG_FILE}" >> "$GITHUB_OUTPUT"
  echo "skip_ci=${SKIP_CI}" >> "$GITHUB_OUTPUT"
  echo "changed_stacks=${STACKS_JSON}" >> "$GITHUB_OUTPUT"
  echo "deploy_description=${DEPLOY_DESC}" >> "$GITHUB_OUTPUT"
fi

echo "Target Environment : ${TARGET_ENV}"
echo "Configuration File : ${CONFIG_FILE:-<auto>}"
echo "Skip CI Flag       : ${SKIP_CI}"
echo "Target Stacks      : ${STACKS_JSON}"
echo "Description        : ${DEPLOY_DESC}"
echo "============================================="
