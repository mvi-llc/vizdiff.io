# GitLab CI Integration Guide

This guide explains how to integrate VizDiff with GitLab CI for automated visual regression testing of your Storybook components.

## Overview

VizDiff captures screenshots of your Storybook components on every commit and merge request, comparing them against baseline images to detect visual changes. When integrated with GitLab CI:

- Screenshots are captured automatically on each pipeline run
- Visual diffs are reported as commit statuses on GitLab
- Merge requests show VizDiff status before merging

## Prerequisites

- A self-hosted VizDiff instance (see [self-contained-install.md](self-contained-install.md))
- GitLab project with Storybook configured
- GitLab CI/CD enabled for your project

VizDiff's GitLab integration has two independent pieces:

- **User login** is handled by the instance's pluggable auth provider (`AUTH_PROVIDER` — usually
  `oidc` against your organization's IdP, or `dev` for non-production trials). It does not use
  GitLab OAuth.
- **GitLab API access** (listing groups/projects, posting commit statuses) uses a per-host
  **service token** configured by the operator via `GITLAB_HOSTS` — never individual users'
  tokens.

## Step 1: Create a GitLab Service Token

VizDiff calls the GitLab API with one configured service token per GitLab host.

1. Create a personal, group, or project access token on your GitLab host
   (e.g. **Group > Settings > Access tokens**)
2. Give it the `api` scope and the **Developer** role or higher (required to post commit
   statuses and read projects)
3. Copy the token (`glpat-...`) — it goes into the VizDiff environment in Step 2

## Step 2: Configure VizDiff Environment

Add the token to `GITLAB_HOSTS` (a JSON array of per-host configs) in your VizDiff instance's
environment:

```bash
# One entry per GitLab host (gitlab.com and/or on-prem instances)
GITLAB_HOSTS=[{"host":"https://gitlab.com","token":"glpat-...","rejectUnauthorized":true}]

# Optional: global webhook secret (a per-host "webhookSecret" in GITLAB_HOSTS takes precedence)
GITLAB_WEBHOOK_SECRET=generate_a_random_secret
```

For a self-hosted GitLab with self-signed certificates, set `"rejectUnauthorized": false` on that
host's entry. See [CONFIGURATION.md](CONFIGURATION.md#gitlab-service-tokens-gitlab_hosts) for the
full semantics (multi-host setups, per-host webhook secrets, and the single-host
`GITLAB_HOST`/`GITLAB_TOKEN` fallback).

After updating environment variables, restart your VizDiff services.

## Step 3: Sign In and Create a Project

1. Visit your VizDiff instance and click **Sign in** (you'll authenticate with the identity
   provider configured for the instance)
2. Navigate to **Projects** and click **New Project**
3. Select your GitLab group and project from the list (VizDiff lists what the configured service
   token can see)
4. Copy the **Project Token** from the project settings (you'll need this for CI)

### Monorepos: multiple Storybooks per repository

A single GitLab repository can host **multiple** VizDiff projects — one per Storybook (e.g.
several frontends plus a shared component library). To add another project for the same repo,
fill in the **Project key** field (or pass `key` to `POST /api/projects`) with a unique slug per
Storybook, e.g. `web`, `admin`, `ui-lib`:

- Each project gets its own upload token; give each package's CI job its own
  `VIZDIFF_PROJECT_TOKEN` and scope the job with `rules:changes` so it only runs when that
  package changes.
- Each project reports an independent commit status: the default (no-key) project uses
  `vizdiff/visual-tests`, keyed projects use `vizdiff/visual-tests/<key>` — so one MR shows a
  per-Storybook pass/fail breakdown.
- Webhooks need no extra configuration: events fan out to every VizDiff project registered for
  the repository.

## Step 4: Configure GitLab CI

Add the following `.gitlab-ci.yml` to your repository:

```yaml
# .gitlab-ci.yml - VizDiff Visual Testing Integration

stages:
  - build
  - test

variables:
  # These are configured in GitLab CI/CD Settings > Variables
  # VIZDIFF_API_URL: https://your-vizdiff-instance.com/api   (include the /api suffix)
  # VIZDIFF_PROJECT_TOKEN: your-project-token

# Build Storybook
build-storybook:
  stage: build
  image: node:20-alpine
  cache:
    key: ${CI_COMMIT_REF_SLUG}
    paths:
      - node_modules/
      - .yarn/cache/
  script:
    - npm ci --prefer-offline
    - npm run build-storybook
  artifacts:
    paths:
      - storybook-static/
    expire_in: 1 hour
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH

# Upload to VizDiff
vizdiff:
  stage: test
  image: alpine:latest
  needs: [build-storybook]
  before_script:
    - apk add --no-cache curl tar gzip
  script:
    - tar -czf storybook.tar.gz -C storybook-static .
    - |
      echo "Uploading Storybook to VizDiff..."
      
      RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
        "${VIZDIFF_API_URL}/upload/storybook?token=${VIZDIFF_PROJECT_TOKEN}" \
        -H "Content-Type: application/gzip" \
        -H "x-vizdiff-commit-sha: ${CI_COMMIT_SHA}" \
        -H "x-vizdiff-branch: ${CI_COMMIT_REF_NAME}" \
        ${CI_MERGE_REQUEST_IID:+-H "x-vizdiff-pr-number: ${CI_MERGE_REQUEST_IID}"} \
        ${CI_MERGE_REQUEST_DIFF_BASE_SHA:+-H "x-vizdiff-base-commit-sha: ${CI_MERGE_REQUEST_DIFF_BASE_SHA}"} \
        ${CI_MERGE_REQUEST_TARGET_BRANCH_NAME:+-H "x-vizdiff-base-branch: ${CI_MERGE_REQUEST_TARGET_BRANCH_NAME}"} \
        --data-binary @storybook.tar.gz)
      
      HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
      BODY=$(echo "$RESPONSE" | sed '$d')
      
      echo "Response: $BODY"
      echo "HTTP Status: $HTTP_CODE"
      
      if [ "$HTTP_CODE" -ge 400 ]; then
        echo "ERROR: Upload failed with status $HTTP_CODE"
        exit 1
      fi
      
      echo "Upload successful! VizDiff will process screenshots and update commit status."
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
```

## Step 5: Set CI/CD Variables

In your GitLab project, go to **Settings > CI/CD > Variables** and add:

| Variable | Value | Protected | Masked |
|----------|-------|-----------|--------|
| `VIZDIFF_API_URL` | `https://your-vizdiff-instance.com/api` | Optional | No |
| `VIZDIFF_PROJECT_TOKEN` | Your project token from Step 3 | Yes | Yes |

`VIZDIFF_API_URL` must include the `/api` suffix (the [`@vizdiff/cli`](https://www.npmjs.com/package/@vizdiff/cli)
and the raw-`curl` example above both append endpoint paths like `/upload/storybook` directly to it).

## Step 6: Configure Webhook (Optional)

Webhooks enable real-time notifications when commits are pushed or merge requests are created. While not required (VizDiff can work with just CI uploads), webhooks improve the user experience.

1. Go to your GitLab project: **Settings > Webhooks**
2. Add a new webhook:
   - **URL**: `https://YOUR_VIZDIFF_DOMAIN/api/webhooks/gitlab`
   - **Secret token**: Same value as your `GITLAB_WEBHOOK_SECRET`
   - **Trigger events**: Select:
     - Push events
     - Merge request events
   - **SSL verification**: Enable (unless using self-signed certificates)
3. Click **Add webhook**

## GitLab CI Variables Reference

These GitLab CI predefined variables are used by VizDiff:

| VizDiff Header | GitLab CI Variable | Description |
|----------------|-------------------|-------------|
| `x-vizdiff-commit-sha` | `CI_COMMIT_SHA` | The commit SHA being tested |
| `x-vizdiff-branch` | `CI_COMMIT_REF_NAME` | Branch or tag name |
| `x-vizdiff-pr-number` | `CI_MERGE_REQUEST_IID` | Merge request ID (MR pipelines only) |
| `x-vizdiff-base-commit-sha` | `CI_MERGE_REQUEST_DIFF_BASE_SHA` | Base commit for comparison (MR pipelines only) |
| `x-vizdiff-base-branch` | `CI_MERGE_REQUEST_TARGET_BRANCH_NAME` | Target branch (MR pipelines only) |

## Viewing Results

After a successful upload:

1. **GitLab Commit Status**: VizDiff posts a commit status that appears:
   - On the commit page
   - In merge request widgets
   - In pipeline views

2. **VizDiff Dashboard**: View detailed results at:
   - `https://YOUR_VIZDIFF_DOMAIN/build?id=BUILD_ID`
   - Click the commit status link to go directly to the build

3. **Approval Workflow**: If visual changes are detected:
   - Review changes in the VizDiff UI
   - Approve or reject changes
   - Commit status updates automatically

## Troubleshooting

### Upload fails with 401 Unauthorized

- Verify `VIZDIFF_PROJECT_TOKEN` is correct
- Check the token hasn't expired
- Ensure the token is properly masked in CI/CD variables

### Upload fails with 404 Not Found

- Verify `VIZDIFF_API_URL` is correct and accessible, and includes the `/api` suffix
  (e.g. `https://your-vizdiff-instance.com/api`)
- Check for typos in the URL

### No commit status appears on GitLab

- Ensure the service token configured for this host in `GITLAB_HOSTS` has the `api` scope and
  Developer role or higher on the project
- Check VizDiff logs for GitLab API errors
- Verify the service token hasn't expired or been revoked (rotate it in `GITLAB_HOSTS` if needed)

### Storybook build fails

- Ensure `npm run build-storybook` works locally
- Check that all Storybook dependencies are in `package.json`
- Verify the `storybook-static/` output directory matches your configuration

### Self-hosted GitLab connection issues

- Set `"rejectUnauthorized": false` on that host's `GITLAB_HOSTS` entry for self-signed
  certificates
- Verify network connectivity between VizDiff and your GitLab instance
- Check that the GitLab URL doesn't have a trailing slash

## Advanced Configuration

### Custom Storybook Output Directory

If your Storybook outputs to a different directory:

```yaml
script:
  - npm run build-storybook -- -o custom-output/
  - tar -czf storybook.tar.gz custom-output/
```

### Yarn/pnpm Support

For Yarn:
```yaml
script:
  - yarn install --frozen-lockfile
  - yarn build-storybook
```

For pnpm:
```yaml
script:
  - pnpm install --frozen-lockfile
  - pnpm build-storybook
```

### Monorepo Configuration

If Storybook is in a subdirectory:

```yaml
build-storybook:
  script:
    - cd packages/ui
    - npm ci
    - npm run build-storybook
  artifacts:
    paths:
      - packages/ui/storybook-static/
```

### Conditional Execution

Run VizDiff only for specific paths:

```yaml
vizdiff:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
      changes:
        - "src/components/**/*"
        - "src/stories/**/*"
        - ".storybook/**/*"
```

## Support

- Documentation: https://vizdiff.io/docs
- Issues: Contact your VizDiff administrator
