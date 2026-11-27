# Consumer Repository Setup Guide: Amazon Web Services (AWS)

This guide explains how to configure an AWS Terraform repository to consume the unified centralized CI/CD template.

---

## 1. Prerequisites on AWS
1. **S3 State Bucket & DynamoDB Lock Table**: Create an S3 bucket (`org-terraform-state-${ENV}`, or pass `state_bucket` input) with versioning/encryption and a DynamoDB table (`tf-locks-${ENV}`) with partition key `LockID` (String).
2. **IAM OIDC Provider & Role**: Configure `https://token.actions.githubusercontent.com` (`sts.amazonaws.com`) and an IAM Role trusting your GitHub org/repo. See [oidc-setup.md](./oidc-setup.md) for details.
3. **GitHub Secrets & Environments**:
   * **Add `AWS_ROLE_ARN` (and optionally `AWS_REGION`, defaults to `ap-south-1`) in Repository Secrets** (*Settings → Secrets and variables → Actions → Repository secrets*). Because `terraform.yml` uses `secrets: inherit`, both `plan` (PR) and `apply` (merge) receive them automatically.
   * *(Important: Do **not** place them only inside a GitHub Environment—the `plan` job runs without `environment:` so `uat`/`prod` approval gates don't block PR plans, meaning Environment-only secrets would be empty during `plan`.)*
   * **Create GitHub Environments (`dev`, `uat`, `prod`)** solely for deployment approval gates (`0` reviewers on `dev` for auto-apply; required reviewers + `main` branch restriction on `uat`/`prod`).

---

## 2. Terraform Repository Structure

```
aws-platform-terraform/
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

  backend "s3" {}

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
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
      cloud_provider: "aws"
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
  description: "Deploy AWS VPC network stack"
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

* **Actions permissions**: Select **Allow all actions and reusable workflows** *(or allowlist `yuva-cloud-devops/*`, `actions/*`, `hashicorp/*`, `aws-actions/*`, `aquasecurity/*`, `terraform-linters/*`, `bridgecrewio/*`)*.
  * ❌ Keep **Require actions to be pinned to a full-length commit SHA** unchecked *(workflows use version tags like `@v4`, `@main`)*.
* **Artifact & log retention**: Set to **`90` days**.
* **Fork pull request workflows**: Select **Require approval for all external contributors** *(essential on public repos)*.
* **Workflow permissions**:
  * Select **Read repository contents and packages permissions** *(granular `id-token: write`, `issues: write`, and `pull-requests: write` are declared explicitly in `terraform.yml`)*.
  * ❌ Leave **Allow GitHub Actions to create and approve pull requests** unchecked.


