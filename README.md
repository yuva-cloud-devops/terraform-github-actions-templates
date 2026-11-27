# Centralized Multi-Cloud Terraform GitHub Actions Templates

Production-ready, unified reusable GitHub Actions workflow (`terraform-pipeline.yml`), nested pipeline modules, and automation scripts for Terraform CI/CD across **GCP**, **AWS**, and **Azure**.

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
│   │   ├── parse-pr-metadata/action.yml           # PR/commit & YAML path metadata parser
│   │   ├── validate-schema/action.yml             # Request, stack & YAML schema validator
│   │   ├── security-scan/action.yml               # Trivy IaC/Secrets, TFLint, Checkov
│   │   └── terraform-plan/action.yml              # Dynamic backend init & plan
│   │
│   ├── continuous-provisioning/
│   │   ├── terraform-apply/action.yml             # Dynamic backend init & apply
│   │   └── deployment-audit/action.yml            # Apply audit logger (summary + merged PR)
│   │
│   └── common/
│       ├── auth/
│       │   ├── gcp/action.yml                     # Google Cloud Workload Identity Federation
│       │   ├── aws/action.yml                     # AWS AssumeRoleWithWebIdentity OIDC
│       │   └── azure/action.yml                   # Azure Federated Credentials OIDC
│       └── bot/action.yml                         # Per-stack sticky PR comment & audit poster
│
├── scripts/
│   ├── parse-pr-metadata.sh
│   ├── validate-request.sh
│   ├── generate-plan-report.js
│   ├── generate-apply-report.js
│   └── post-comment.js
│
├── schemas/
│   └── deployment-request-schema.json             # Pipeline request contract (env schemas live in consumer repo)
│
└── docs/
    ├── architecture.md
    ├── oidc-setup.md
    ├── setup-gcp.md
    ├── setup-aws.md
    └── setup-azure.md
```

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
    uses: yuva-cloud-devops/terraform-github-actions-templates/.github/workflows/terraform-pipeline.yml@main
    with:
      cloud_provider: "gcp" # or "aws" or "azure"
      terraform_version: "1.10.5"
      enable_security_scans: true
    secrets: inherit
```

* **On Pull Request**: Runs `detect` → `security-scan` + `terraform-plan` → posts per-stack sticky Plan comments. New commits automatically cancel stale runs and update the same comment in place.
* **On Merge to `main`**: Runs `detect` → `terraform-apply` behind `environment: <target_env>` (`dev` = auto-apply with 0 reviewers; `uat`/`prod` = pauses at GitHub Environment Approval Gate) → posts Deployment Audit output on the merged PR.
