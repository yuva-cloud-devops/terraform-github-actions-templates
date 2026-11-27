# Consumer Repository Setup Guide: Google Cloud Platform (GCP)

This guide covers every step required to configure a GCP Terraform repository to consume the unified centralized CI/CD template (`terraform-pipeline.yml`).

---

## 1. Prerequisites on GCP
1. **GCS State Bucket**: Create a globally unique bucket (e.g., `<project-id>-dev-tfstate`) with versioning enabled and public access prevention enforced.
2. **Workload Identity Federation (WIF) & Service Account**: Set up a Workload Identity Pool, an OIDC provider trusting `https://token.actions.githubusercontent.com`, and a least-privilege Service Account. See [oidc-setup.md](./oidc-setup.md) for details.
3. **GitHub Secrets & Environments**:
   * **Add `GCP_WIF_PROVIDER` and `GCP_SERVICE_ACCOUNT` in Repository Secrets** (*Settings → Secrets and variables → Actions → Repository secrets*). Because `terraform.yml` uses `secrets: inherit`, both `CI - Terraform Plan` (PR) and `CD - Terraform Apply` (merge) receive them automatically.
   * *(Important: Do **not** place them only inside a GitHub Environment—`CI - Terraform Plan` runs without `environment:` so `uat`/`prod` approval gates don't block PR plans, meaning Environment-only secrets would be empty during `plan`.)*
   * **Create GitHub Environments (`dev`, `uat`, `prod`)** solely for deployment approval gates (`0` reviewers on `dev` for auto-apply; required reviewers + `main` branch restriction on `uat`/`prod`).

---

## 2. Terraform Repository Structure

```
gcp-platform-terraform/
├── .github/
│   ├── pull_request_template.md
│   └── workflows/
│       └── terraform.yml
├── compute-infrastructure/        # Or foundation / network / security / compute / availability
│   ├── versions.tf
│   ├── main.tf
│   ├── variables.tf
│   └── outputs.tf
├── environments/
│   ├── dev/
│   │   └── compute.yaml
│   ├── uat/
│   │   └── compute.yaml
│   └── prod/
│       └── compute.yaml
└── schema/
    └── compute.schema.json        # Matched automatically from configuration: compute.yaml
```

---

## 3. Backend & Provider Configuration (`versions.tf`)

Leave the `gcs` backend block empty. The pipeline generates `backend.hcl`, prints it, runs `terraform init -reconfigure -backend-config=backend.hcl`, and exports `TF_VAR_environment` and `TF_VAR_config_file`.

```hcl
terraform {
  required_version = ">= 1.5.0"

  backend "gcs" {}

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

provider "google" {
  project = var.project_id != "" ? var.project_id : try(local.raw_config.project_id, null)
  region  = var.region != "" ? var.region : try(local.raw_config.region, "asia-south1")
}
```

---

## 4. Workflow File (`.github/workflows/terraform.yml`)

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
      cloud_provider: "gcp"
      terraform_version: "1.10.5"
      state_bucket: "<your-project-id>-dev-tfstate"
      enable_security_scans: true
      templates_ref: "main"
    secrets: inherit
```

---

## 5. Pull Request Trigger Format (`.github/pull_request_template.md`)

```yaml
deployment_request:
  infrastructure:
    - compute-infrastructure
  environment: dev
  configuration: compute.yaml
  description: "Deploy Compute Infrastructure (Dynamic YAML VMs)"
```

*(Multi-layer stacks are automatically sorted in strict dependency order: `foundation ➔ network ➔ security ➔ compute ➔ availability`.)*

---

## 6. What Runs on PR vs. Merge

* **On Pull Request (`pull_request`)**:
  `Step 1 - Parse PR & Config Metadata` ➔ `Step 2 - Validate Config & Schema` ➔ `[CI - Gitleaks | CI - Trivy | CI - TFLint | CI - Checkov]` ➔ `CI - Terraform Format Check` ➔ `CI - Terraform Validate` ➔ `CI - Terraform Plan` ➔ `CI - Post Plan & Audit Comment` *(posts sticky comment via built-in `github.token`)*
* **On Merge to `main` (`push`)**:
  `Step 1 - Parse PR & Config Metadata` ➔ `Step 2 - Validate Config & Schema` ➔ `CD - Terraform Apply (<env>)` *(GitHub Environment gate + fresh `backend.hcl` + sequential apply from merged `main` code)* ➔ `CD - Post Deployment Audit Comment` *(posts deployed outputs & provenance on merged PR)*

---

## 7. Branch Protection Rules (`main`)

In GitHub **Settings → Branches → Add branch protection rule** for pattern `main`:

* ✅ **Require a pull request before merging**
  * *Solo testing*: Leave **Require approvals** unchecked (GitHub prevents approving your own PR).
  * *Team workflow*: Enable **Require approvals** (`1+`) and ✅ **Dismiss stale pull request approvals when new commits are pushed**.
* ✅ **Require status checks to pass before merging**
  * ✅ **Require branches to be up to date before merging**.
  * *(Note: Status checks appear in the search list only after running at least one PR workflow—save first, open 1 test PR, then select `Step 1`, `Step 2`, and `CI - Terraform Plan`.)*
* ✅ **Require conversation resolution before merging** *(recommended)*.
* ❌ **Leave unchecked**:
  * **Require deployments to succeed before merging** *(must remain unchecked—`apply` runs after merge)*.
  * **Lock branch**, **Allow force pushes**, **Allow deletions**.

---

## 8. GitHub Actions Repository Settings (`Settings → Actions → General`)

* **Actions permissions**: Select **Allow all actions and reusable workflows** *(or allowlist `yuva-cloud-devops/*`, `actions/*`, `hashicorp/*`, `google-github-actions/*`, `aquasecurity/*`, `terraform-linters/*`, `bridgecrewio/*`)*.
  * ❌ Keep **Require actions to be pinned to a full-length commit SHA** unchecked *(workflows use version tags like `@v6`, `@v3`, `@main`)*.
* **Artifact & log retention**: Set to **`90` days**.
* **Fork pull request workflows**: Select **Require approval for all external contributors** *(essential on public repos)*.
* **Workflow permissions**:
  * Select **Read repository contents and packages permissions** *(granular `id-token: write`, `issues: write`, and `pull-requests: write` are declared explicitly in `terraform.yml`)*.
  * ❌ Leave **Allow GitHub Actions to create and approve pull requests** unchecked.
