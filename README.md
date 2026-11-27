# Centralized Multi-Cloud Terraform GitHub Actions Templates

Production-ready, unified reusable GitHub Actions pipeline (`terraform-pipeline.yml`), nested pipeline modules, and automation scripts for Terraform CI/CD across **GCP**, **AWS**, and **Azure**—built natively on **Node.js 24** actions and keyless **OIDC** authentication.

---

## Repository Structure

```
terraform-github-actions-templates/
├── .github/
│   └── workflows/
│       └── terraform-pipeline.yml                 # Unified Master Workflow (PR Plan + Merge Apply)
│
├── pipelines/                                     # Nested Pipeline Action Modules
│   ├── continuous-integration/
│   │   ├── parse-pr-metadata/action.yml           # PR/commit, config_file & hierarchical stack parser
│   │   ├── validate-schema/action.yml             # Request schema & consumer schema/<name>.schema.json check
│   │   ├── security-scan/action.yml               # Gitleaks, Trivy (v0.36.0), TFLint (v6), Checkov (v12)
│   │   └── terraform-plan/action.yml              # Dynamic backend.hcl init & plan + tfplan.json
│   │
│   ├── continuous-provisioning/
│   │   ├── terraform-apply/action.yml             # Dynamic backend.hcl init, sequential apply & outputs.json
│   │   └── deployment-audit/action.yml            # Consolidated CD audit builder & merged PR poster
│   │
│   └── common/
│       ├── auth/
│       │   ├── gcp/action.yml                     # Google Cloud Workload Identity Federation (auth@v3)
│       │   ├── aws/action.yml                     # AWS AssumeRoleWithWebIdentity (configure-aws-credentials@v6)
│       │   └── azure/action.yml                   # Azure Federated Credentials (login@v3)
│       └── bot/action.yml                         # Consolidated PR Plan & Compliance Audit Bot
│
├── scripts/
│   ├── parse-pr-metadata.sh                       # Parses PR deployment_request & enforces layer hierarchy
│   ├── validate-request.sh                        # Validates request & YAML against consumer schema
│   ├── generate-plan-report.js                    # Aggregates security + per-layer tfplan.json reports
│   ├── generate-apply-report.js                   # Aggregates CD state paths, outputs & provenance metadata
│   └── post-comment.js                            # Sticky CI PR updater & CD merged-PR comment poster
│
├── schemas/
│   └── deployment-request-schema.json             # Pipeline request contract (env schemas live in consumer repo)
│
└── docs/
    ├── architecture.md                            # Deep-dive pipeline & backend design
    ├── oidc-setup.md                              # Keyless OIDC trust setup for GCP, AWS, Azure
    ├── setup-gcp.md                               # Consumer repo setup guide (GCP)
    ├── setup-aws.md                               # Consumer repo setup guide (AWS)
    └── setup-azure.md                             # Consumer repo setup guide (Azure)
```

---

## Every Pipeline Step Explained

### Common Gate Stages (Run on both PR & Merge to `main`)
1. **`Step 1 - Parse PR & Config Metadata`** (`parse-pr-metadata`)
   * Extracts `environment` (e.g., `dev`), `configuration` (e.g., `compute.yaml`), `infrastructure` stacks, and `[skip-ci]` from the PR `deployment_request` YAML (or auto-detects from `git diff` / merge commit).
   * Enforces strict architectural dependency order: **`foundation ➔ network ➔ security ➔ compute ➔ availability`**.
2. **`Step 2 - Validate Config & Schema`** (`validate-schema`)
   * Validates `cloud_provider` and `environment` against [deployment-request-schema.json](schemas/deployment-request-schema.json).
   * Confirms all target stack directories exist.
   * Strips `.yaml`/`.yml` from `configuration` (`compute.yaml` ➔ `compute`) and validates `environments/<env>/<configuration>` against `schema/<name>.schema.json` in the consumer repo.

---

### Pull Request Flow (`CI` — runs when `github.event_name == 'pull_request'`)
*(PR concurrency automatically cancels any stale in-flight PR run when a new commit is pushed.)*

3. **Parallel Security & Compliance Stage**:
   * **`CI - Gitleaks Secret Scan`**: Scans repo commits & files for hardcoded secrets (`gitleaks_report.txt`).
   * **`CI - Trivy Vulnerability Scan`**: Scans IaC files for `HIGH`/`CRITICAL` vulnerabilities and misconfigurations (`trivy_report.txt`).
   * **`CI - TFLint Check`**: Runs `tflint --init` and `tflint -f compact` across each target stack.
   * **`CI - Checkov Policy Scan`**: Evaluates Terraform resources against CIS & cloud policies (`checkov_report.txt`).
4. **`CI - Terraform Format Check`**: Runs `terraform fmt -check -recursive` across every target stack.
5. **`CI - Terraform Validate`**: Runs `terraform init -backend=false` and `terraform validate` across every target stack.
6. **`CI - Terraform Plan`**:
   * Authenticates via keyless OIDC (`GCP`, `AWS`, or `Azure`).
   * Generates `backend.hcl`, prints it, runs `terraform init -reconfigure -backend-config=backend.hcl`, passes `TF_VAR_environment` and `TF_VAR_config_file`, and runs `terraform plan -detailed-exitcode`.
   * Uploads `tfplan.json`, `plan.txt`, `backend.hcl`, and `meta.json` under `tf-plan-artifacts/`.
7. **`CI - Post Plan & Audit Comment`**:
   * Downloads all security and plan artifacts and generates **one consolidated sticky PR comment** (`## 🤖 Terraform Plan & Compliance Audit Report`) using the built-in `github.token` (`github-actions[bot]`).

---

### Merge to `main` Flow (`CD` — runs when `github.event_name == 'push' && github.ref == 'refs/heads/main'`)

3. **`CD - Terraform Apply (<env>)`**:
   * Protected by **GitHub Environment** (`dev` = 0 required reviewers auto-apply; `uat`/`prod` = manual approval gate).
   * Serialized per cloud & environment (`cancel-in-progress: false` so active applies are never aborted).
   * Checks out the **merged `main` code**, authenticates via OIDC, generates a fresh `backend.hcl`, runs `terraform init -reconfigure -backend-config=backend.hcl`, executes **sequential fail-fast `terraform apply -auto-approve`** in strict `foundation ➔ network ➔ security ➔ compute ➔ availability` order, and exports `terraform output -json > outputs.json`.
4. **`CD - Post Deployment Audit Comment`**:
   * Resolves the merged PR via GitHub API and posts **`## 🚀 Terraform CD Deployment Audit Report`** showing applied layers (`layer1 ➔ layer2`), state bucket paths, deployed Terraform outputs, actor, commit SHA, Run ID, and timestamp.

---

## Consumer Usage (Single Workflow File)

In your consumer Terraform repository (`.github/workflows/terraform.yml`):

```yaml
name: Terraform Pipeline

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

permissions:
  id-token: write
  contents: read
  issues: write
  pull-requests: write

concurrency:
  group: tf-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:
  terraform:
    name: CTP
    uses: yuva-cloud-devops/terraform-github-actions-templates/.github/workflows/terraform-pipeline.yml@main
    with:
      cloud_provider: "gcp" # "gcp" | "aws" | "azure"
      terraform_version: "1.10.5"
      state_bucket: "your-tfstate-bucket"
      enable_security_scans: true
      templates_ref: "main"
    secrets: inherit
```

---

## Workflow Inputs Reference

| Input | Required | Default | Description |
| :--- | :---: | :--- | :--- |
| `cloud_provider` | **Yes** | — | Target cloud: `gcp`, `aws`, or `azure` |
| `terraform_version` | No | `"1.10.5"` | Terraform CLI version |
| `environment` | No | `"dev"` | Fallback environment if not in PR body / diff |
| `working_directory` | No | `"."` | Fallback stack folder if not in PR body / diff |
| `state_bucket` | No | `""` | Override remote state bucket / storage account name |
| `enable_security_scans` | No | `true` | Run Gitleaks, Trivy, TFLint, and Checkov on PRs |
| `fail_on_security_issues` | No | `false` | Fail CI if scanners report HIGH/CRITICAL findings |
| `templates_repository` | No | `"yuva-cloud-devops/terraform-github-actions-templates"` | Templates repo (`owner/repo`) |
| `templates_ref` | No | `"main"` | Branch, tag, or SHA of templates repo |

---

## Cloud Setup Guides
* [OIDC Setup Guide (GCP, AWS, Azure)](docs/oidc-setup.md)
* [GCP Consumer Repo Setup](docs/setup-gcp.md)
* [AWS Consumer Repo Setup](docs/setup-aws.md)
* [Azure Consumer Repo Setup](docs/setup-azure.md)
* [Detailed Architecture](docs/architecture.md)
