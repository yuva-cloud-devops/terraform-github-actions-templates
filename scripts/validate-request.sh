#!/usr/bin/env bash
set -euo pipefail

SCHEMA_FILE="${SCHEMA_PATH:-}"
TARGET_FILE="${ENV_FILE:-}"
CLOUD="${CLOUD_PROVIDER:-}"
ENV="${TARGET_ENV:-}"
CFG_FILE="${CONFIG_FILE:-}"
STACKS="${CHANGED_STACKS:-[]}"

echo "============================================="
echo "Running Schema & Stack Validation Gate"
echo "Request Schema : ${SCHEMA_FILE}"
echo "Cloud Provider : ${CLOUD}"
echo "Target Env     : ${ENV}"
echo "Config File    : ${CFG_FILE:-<auto>}"
echo "Target Stacks  : ${STACKS}"
echo "============================================="

# 1. Validate cloud_provider and target_env against deployment-request-schema.json
if [ -n "$SCHEMA_FILE" ] && [ -f "$SCHEMA_FILE" ]; then
  node - <<'EOF'
const fs = require('fs');
const schema = JSON.parse(fs.readFileSync(process.env.SCHEMA_PATH, 'utf8'));
const cloud = process.env.CLOUD_PROVIDER || '';
const env = process.env.TARGET_ENV || '';

if (cloud && schema.properties?.cloud_provider?.enum) {
  const allowedClouds = schema.properties.cloud_provider.enum;
  if (!allowedClouds.includes(cloud)) {
    console.error(`::error::Invalid cloud_provider '${cloud}'. Allowed: ${allowedClouds.join(', ')}`);
    process.exit(1);
  }
  console.log(`✓ cloud_provider '${cloud}' matches deployment-request-schema.json.`);
}

if (env && schema.properties?.environment?.enum) {
  const allowedEnvs = schema.properties.environment.enum;
  if (!allowedEnvs.includes(env)) {
    console.error(`::error::Invalid target environment '${env}'. Allowed: ${allowedEnvs.join(', ')}`);
    process.exit(1);
  }
  console.log(`✓ environment '${env}' matches deployment-request-schema.json.`);
}
EOF
fi

# Helper function to validate a single YAML file against a JSON Schema
validate_yaml_against_schema() {
  local yaml_path="$1"
  local schema_path="$2"
  echo "Validating ${yaml_path} against ${schema_path}..."
  python3 - "$yaml_path" "$schema_path" <<'PYEOF'
import sys, json, yaml

yaml_path, schema_path = sys.argv[1], sys.argv[2]
with open(yaml_path, "r", encoding="utf-8") as f:
    data = yaml.safe_load(f)
with open(schema_path, "r", encoding="utf-8") as f:
    schema = json.load(f)

def validate(val, sch, path="$"):
    expected_type = sch.get("type")
    type_map = {
        "object": dict,
        "array": list,
        "string": str,
        "boolean": bool,
        "integer": int,
        "number": (int, float),
    }
    if expected_type and expected_type in type_map:
        if expected_type == "integer" and isinstance(val, bool):
            raise ValueError(f"{path}: expected integer, got boolean")
        if not isinstance(val, type_map[expected_type]):
            raise ValueError(f"{path}: expected {expected_type}, got {type(val).__name__}")

    if "enum" in sch and val not in sch["enum"]:
        raise ValueError(f"{path}: value {val!r} not in allowed enum {sch['enum']}")

    if isinstance(val, dict):
        for req in sch.get("required", []):
            if req not in val or val[req] is None or val[req] == "":
                raise ValueError(f"{path}: missing required property '{req}'")
        props = sch.get("properties", {})
        for k, v in val.items():
            if k in props:
                validate(v, props[k], f"{path}.{k}")
            elif sch.get("additionalProperties") is False:
                raise ValueError(f"{path}: unexpected property '{k}'")

    if isinstance(val, list):
        if "minItems" in sch and len(val) < sch["minItems"]:
            raise ValueError(f"{path}: expected at least {sch['minItems']} items, got {len(val)}")
        if "items" in sch:
            for idx, item in enumerate(val):
                validate(item, sch["items"], f"{path}[{idx}]")

try:
    validate(data, schema)
    print(f"✓ {yaml_path} passed validation against {schema_path}.")
except Exception as exc:
    print(f"::error::Schema validation failed for {yaml_path}: {exc}", file=sys.stderr)
    sys.exit(1)
PYEOF
}

# Resolve matching schema file for a given config filename (e.g. compute.yaml -> schema/compute.schema.json)
find_schema_for_config() {
  local cfg_name="$1"
  local stack_dir="${2:-.}"
  local base_name="${cfg_name%.yaml}"
  base_name="${base_name%.yml}"

  for candidate in \
    "schema/${base_name}.schema.json" \
    "schemas/${base_name}.schema.json" \
    "${stack_dir}/schema/${base_name}.schema.json" \
    "${stack_dir}/schemas/${base_name}.schema.json" \
    "environments/${ENV}/schema.json" \
    "${stack_dir}/environments/${ENV}/schema.json"; do
    if [ -f "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

# 2. Verify every target stack directory exists
if [ -n "$STACKS" ] && [ "$STACKS" != "[]" ]; then
  while IFS= read -r stack_dir; do
    [ -z "$stack_dir" ] && continue
    if [ ! -d "$stack_dir" ]; then
      echo "::error::Target stack directory does not exist: '${stack_dir}'"
      exit 1
    fi
    echo "✓ Stack directory exists: ${stack_dir}"
  done < <(echo "$STACKS" | jq -r '.[]')
fi

# 3. Validate the configuration YAML against schema/<config>.schema.json
FIRST_STACK=$(echo "$STACKS" | jq -r '.[0] // "."')

if [ -n "$CFG_FILE" ]; then
  # Explicit configuration file requested (e.g. configuration: compute.yaml)
  TARGET_CFG_PATH=""
  for cfg_candidate in \
    "environments/${ENV}/${CFG_FILE}" \
    "${FIRST_STACK}/environments/${ENV}/${CFG_FILE}"; do
    if [ -f "$cfg_candidate" ]; then
      TARGET_CFG_PATH="$cfg_candidate"
      break
    fi
  done

  if [ -z "$TARGET_CFG_PATH" ]; then
    echo "::error::Requested configuration file '${CFG_FILE}' not found under environments/${ENV}/"
    exit 1
  fi

  MATCHED_SCHEMA=$(find_schema_for_config "$CFG_FILE" "$FIRST_STACK" || true)
  if [ -z "$MATCHED_SCHEMA" ]; then
    BASE_NAME="${CFG_FILE%.yaml}"; BASE_NAME="${BASE_NAME%.yml}"
    echo "::error::Schema file not found for '${CFG_FILE}' (expected schema/${BASE_NAME}.schema.json)"
    exit 1
  fi

  validate_yaml_against_schema "$TARGET_CFG_PATH" "$MATCHED_SCHEMA"
else
  # Auto-validate any YAML files present under environments/<env>/ if matching schema/<name>.schema.json exists
  for env_dir in "environments/${ENV}" "${FIRST_STACK}/environments/${ENV}"; do
    [ -d "$env_dir" ] || continue
    for yaml_file in "$env_dir"/*.yaml "$env_dir"/*.yml; do
      [ -f "$yaml_file" ] || continue
      fname=$(basename "$yaml_file")
      MATCHED_SCHEMA=$(find_schema_for_config "$fname" "$FIRST_STACK" || true)
      if [ -n "$MATCHED_SCHEMA" ]; then
        validate_yaml_against_schema "$yaml_file" "$MATCHED_SCHEMA"
      else
        echo "No schema found for ${yaml_file}; skipping custom schema check."
      fi
    done
  done
fi

# 4. Sanity-check root environment YAML if present
if [ -n "$TARGET_FILE" ] && [ -f "$TARGET_FILE" ]; then
  if command -v python3 >/dev/null 2>&1 && python3 -c "import yaml" >/dev/null 2>&1; then
    python3 - "$TARGET_FILE" <<'PYEOF'
import sys, yaml
with open(sys.argv[1], "r", encoding="utf-8") as f:
    data = yaml.safe_load(f)
if not isinstance(data, dict):
    print(f"::error::{sys.argv[1]} must parse to a YAML object.", file=sys.stderr)
    sys.exit(1)
print(f"✓ {sys.argv[1]} passed YAML syntax check.")
PYEOF
  fi
fi

echo "✓ Schema validation gate completed successfully."
