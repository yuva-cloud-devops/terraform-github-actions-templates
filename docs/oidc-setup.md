# Keyless OIDC Authentication Setup (GCP, AWS, Azure)

These centralized pipelines use **short-lived OIDC tokens**—never static cloud access keys or JSON service account keys.

---

## 1. Required GitHub Workflow Permissions

Both the consumer workflow (`ci.yml` / `cd.yml`) and the reusable workflows require `id-token: write` to mint the OIDC JWT:

```yaml
permissions:
  id-token: write   # Allows GitHub to mint the short-lived OIDC JWT
  contents: read    # Required to checkout the repository
```

The centralized auth modules in `pipelines/common/auth/` handle login automatically based on `cloud_provider`:
- **GCP** (`pipelines/common/auth/gcp/action.yml`): `google-github-actions/auth@v2`
- **AWS** (`pipelines/common/auth/aws/action.yml`): `aws-actions/configure-aws-credentials@v4`
- **Azure** (`pipelines/common/auth/azure/action.yml`): `azure/login@v2`

---

## 2. Required GitHub Secrets (Per Cloud)

Configure these in **Repo/Org Settings → Secrets and variables → Actions** (or scoped per **GitHub Environment** such as `dev`, `uat`, `prod`):

| Cloud | Required Secrets | Example Value |
| :--- | :--- | :--- |
| **GCP** | `GCP_WIF_PROVIDER`<br>`GCP_SERVICE_ACCOUNT` | `projects/123456789/locations/global/workloadIdentityPools/github-pool/providers/github-provider`<br>`terraform-ci@my-project.iam.gserviceaccount.com` |
| **AWS** | `AWS_ROLE_ARN`<br>`AWS_REGION` *(optional)* | `arn:aws:iam::123456789012:role/github-terraform-role`<br>`ap-south-1` |
| **Azure** | `AZURE_CLIENT_ID`<br>`AZURE_TENANT_ID`<br>`AZURE_SUBSCRIPTION_ID` | App Registration (Client) UUID<br>Entra ID Tenant UUID<br>Target Subscription UUID |

---

## 3. Cloud-Side OIDC Trust Configuration

### GCP (Workload Identity Federation)
1. Create a **Workload Identity Pool** (e.g., `github-pool`).
2. Add an **OIDC Provider** inside the pool:
   - **Issuer URL**: `https://token.actions.githubusercontent.com`
   - **Attribute mapping**: `google.subject = assertion.sub`, `attribute.repository = assertion.repository`, `attribute.repository_owner = assertion.repository_owner`
   - **Attribute condition** *(restricts access to your org)*: `assertion.repository_owner == "your-github-org"`
3. Grant the **Service Account** (`GCP_SERVICE_ACCOUNT`) `roles/iam.workloadIdentityUser` for that pool principal, plus the IAM roles Terraform requires (e.g., `roles/compute.admin`, `roles/storage.objectAdmin` on the state bucket).

### AWS (IAM OIDC Identity Provider + Role)
1. In **IAM → Identity providers**, add an OIDC provider:
   - **Provider URL**: `https://token.actions.githubusercontent.com`
   - **Audience**: `sts.amazonaws.com`
2. Create an **IAM Role** (`AWS_ROLE_ARN`) with a **Trust Policy** allowing `sts:AssumeRoleWithWebIdentity` from your org/repo:
   ```json
   "Condition": {
     "StringEquals": {
       "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
     },
     "StringLike": {
       "token.actions.githubusercontent.com:sub": "repo:your-github-org/*:*"
     }
   }
   ```
3. Attach Terraform resource permissions and S3/DynamoDB state permissions to the role.

### Azure (Entra ID App Registration + Federated Credential)
1. Create an **App Registration** in Microsoft Entra ID (note its `AZURE_CLIENT_ID` and `AZURE_TENANT_ID`).
2. Under **Certificates & secrets → Federated credentials → Add credential**, choose **GitHub Actions deploying Azure resources**:
   - **Organization**: `your-github-org`
   - **Repository**: your consumer repo name
   - **Entity type**: `Pull request` (for CI) and `Branch: main` or `Environment: dev/prod` (for CD)
3. Assign RBAC roles (e.g., `Contributor` on the subscription + `Storage Blob Data Contributor` on the `tfstate` storage account) to the App Registration's Service Principal.
