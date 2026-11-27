# Multi-Cloud Centralized Terraform CI/CD Architecture

This repository (`terraform-github-actions-templates`) provides an enterprise-grade, unified reusable GitHub Actions pipeline (`terraform-pipeline.yml`) and nested pipeline modules for managing Infrastructure as Code across **GCP**, **AWS**, and **Azure**.

---

## 1. Core Principles

- **Unified Single Master Workflow**: One master workflow (`.github/workflows/terraform-pipeline.yml`) handles both PR previews (`pull_request`) and environment-gated provisioning (`push` to `main`).
- **PR Concurrency Protection**: Stale/running PR pipelines are automatically cancelled when a new commit is pushed (`cancel-in-progress: ${{ github.event_name == 'pull_request' }}`), preventing orphan runs while keeping `main` applies serialized.
- **Strict OIDC Authentication**: Short-lived OIDC JWT federation only—no persistent cloud credentials stored in GitHub Secrets.
- **Dynamic Backend Injection**: No hardcoded backend buckets or prefixes in Terraform root modules.
- **Per-Stack Sticky PR Bot**: Updates one sticky comment per `(mode, env, stack)` tuple and records deployment audit results directly on merged PRs.

---

## 2. Lifecycle Flow

1. **Pull Request (`pull_request`)**:
   - `detect`: Parses `deployment_request` YAML from the PR body (or changed `environments/<env>/...` files) and validates schema/stack directories.
   - `plan`: Runs Trivy/TFLint/Checkov security checks → OIDC Auth → `terraform init` + `validate` + `plan` → posts/updates per-stack sticky PR comment.
2. **Merge to `main` (`push`)**:
   - `detect`: Resolves target environment and stacks from the merge commit/diff.
   - `apply`: Protected by `environment: <target_env>` (`dev` = 0 approvers auto-apply; `uat`/`prod` = approval gate) → OIDC Auth → `terraform init` + `apply` → posts Deployment Audit comment on the merged PR and Actions Summary.
