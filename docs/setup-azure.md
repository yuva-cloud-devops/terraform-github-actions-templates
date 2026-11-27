# Consumer Repository Setup Guide: Microsoft Azure

This guide explains how to configure an Azure Terraform repository to consume the unified centralized CI/CD template.

---

## 1. Prerequisites on Azure
1. **Azure Storage Account for State**: Create a Resource Group (`rg-tfstate-${ENV}`), Storage Account (`sttfstate${ENV}`, or pass `state_bucket` input), and Blob Container (`tfstate`).
2. **Entra ID App Registration & Federated Credentials**: Configure Federated Credentials for your GitHub repo/PR/environment. See [oidc-setup.md](./oidc-setup.md) for details.
3. **GitHub Secrets & Environments**:
   * **Add `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and `AZURE_SUBSCRIPTION_ID` in Repository Secrets** (*Settings → Secrets and variables → Actions → Repository secrets*). Because `terraform.yml` uses `secrets: inherit`, both `plan` (PR) and `apply` (merge) receive them automatically.
   * *(Important: Do **not** place them only inside a GitHub Environment—the `plan` job runs without `environment:` so `uat`/`prod` approval gates don't block PR plans, meaning Environment-only secrets would be empty during `plan`.)*
   * **Create GitHub Environments (`dev`, `uat`, `prod`)** solely for deployment approval gates (`0` reviewers on `dev` for auto-apply; required reviewers + `main` branch restriction on `uat`/`prod`).

---

## 2. Terraform Repository Structure

```
azure-platform-terraform/
├── .github/
│   ├── pull_request_template.md
│   └── workflows/
│       └── terraform.yml
├── infrastructure/
│   └── network/
│       ├── versions.tf
│       ├── main.tf
│       └── variables.tf
└── environments/
    └── dev.yaml
```

---

## 3. Backend & Provider Configuration (`versions.tf`)

```hcl
terraform {
  required_version = ">= 1.10.5"

  backend "azurerm" {}

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }
}

provider "azurerm" {
  features {}
  use_oidc = true
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
    uses: yuva-cloud-devops/terraform-github-actions-templates/.github/workflows/terraform-pipeline.yml@main
    with:
      cloud_provider: "azure"
      terraform_version: "1.10.5"
      enable_security_scans: true
    secrets: inherit
```

---

## 5. Pull Request Trigger Format
```yaml
deployment_request:
  infrastructure:
    - infrastructure/network
  environment: dev
  description: "Deploy Azure VNet stack"
```

---

## 6. Branch Protection Rules (`main`)

In GitHub **Settings → Branches → Add branch protection rule** for pattern `main`:

* ✅ **Require a pull request before merging**
  * *Solo testing*: Leave **Require approvals** unchecked (GitHub prevents approving your own PR).
  * *Team workflow*: Enable **Require approvals** (`1+`) and ✅ **Dismiss stale pull request approvals when new commits are pushed**.
* ✅ **Require status checks to pass before merging**
  * ✅ **Require branches to be up to date before merging**.
  * *(Note: Status checks appear in the search list only after running at least one PR workflow—save first, open 1 test PR, then select `Detect Targets & Validate` and `Plan (...)`.)*
* ✅ **Require conversation resolution before merging** *(recommended)*.
* ❌ **Leave unchecked**:
  * **Require deployments to succeed before merging** *(must remain unchecked—`apply` runs after merge)*.
  * **Lock branch**, **Allow force pushes**, **Allow deletions**.

---

## 7. GitHub Actions Repository Settings (`Settings → Actions → General`)

* **Actions permissions**: Select **Allow all actions and reusable workflows** *(or allowlist `yuva-cloud-devops/*`, `actions/*`, `hashicorp/*`, `azure/*`, `aquasecurity/*`, `terraform-linters/*`, `bridgecrewio/*`)*.
  * ❌ Keep **Require actions to be pinned to a full-length commit SHA** unchecked *(workflows use version tags like `@v4`, `@v2`, `@main`)*.
* **Artifact & log retention**: Set to **`90` days**.
* **Fork pull request workflows**: Select **Require approval for all external contributors** *(essential on public repos)*.
* **Workflow permissions**:
  * Select **Read repository contents and packages permissions** *(granular `id-token: write`, `issues: write`, and `pull-requests: write` are declared explicitly in `terraform.yml`)*.
  * ❌ Leave **Allow GitHub Actions to create and approve pull requests** unchecked.


