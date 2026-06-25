---
name: handover-admin
description: Generate comprehensive admin documentation for AEM Edge Delivery Services project handover. Use when handing over admin responsibilities, onboarding a new site administrator, or documenting admin procedures — e.g., "admin guide", "admin documentation", "admin handover".
license: Apache-2.0
allowed-tools: Read, Write, Edit, Bash, AskUserQuestion, Skill
metadata:
  version: "1.0.0"
---

# Project Handover - Admin Guide

Generate comprehensive documentation for administrators taking over an AEM Edge Delivery Services project. Produces a complete admin guide with Config Service setup, permissions, Admin API operations, and troubleshooting.

---

## Step 0: Navigate to Project Root (CONDITIONAL)

Skip if `allGuides` is set in `.claude-plugin/project-config.json` (orchestrator already validated).

```bash
ALL_GUIDES=$(cat .claude-plugin/project-config.json 2>/dev/null | node -e "
  const d = require('fs').readFileSync(0,'utf8');
  try { console.log(JSON.parse(d).allGuides ? 'true' : ''); } catch(e) { console.log(''); }
")
if [ -z "$ALL_GUIDES" ]; then
  cd "$(git rev-parse --show-toplevel)"
  ls scripts/aem.js
fi
```

If `scripts/aem.js` does not exist, tell the user this skill requires an AEM Edge Delivery Services project and stop.

All subsequent steps operate from project root. Guides are created at `project-guides/`.

---

## Execution Checklist

```markdown
- [ ] Phase 0: Get org name and authenticate
- [ ] Phase 1: Fetch project context from Config Service API
- [ ] Phase 2: Generate admin guide content
- [ ] Phase 3: Customize for project
- [ ] Phase 4: Convert to PDF
```

---

## Phase 0: Get Organization Name and Authenticate

### 0.1 Check for Saved Organization

```bash
cat .claude-plugin/project-config.json 2>/dev/null | node -e "
  const d = require('fs').readFileSync(0,'utf8');
  try { const o = JSON.parse(d).org; if(o) console.log('org: ' + o); } catch(e) {}
"
```

### 0.2 Prompt for Organization Name (If Not Saved)

If no org name is found, ask the user:

> "What is your Config Service organization name? This is the `{org}` part of your Edge Delivery Services URLs (e.g., `https://main--site--{org}.aem.page`). The org name may differ from your GitHub organization."

Ask as a plain text question — not `AskUserQuestion` with options. Organization name is mandatory; do not offer a skip option.

### 0.3 Save Organization Name

```bash
mkdir -p .claude-plugin
grep -qxF '.claude-plugin/' .gitignore 2>/dev/null || echo '.claude-plugin/' >> .gitignore

if [ -f .claude-plugin/project-config.json ]; then
  cat .claude-plugin/project-config.json | sed 's/"org"[[:space:]]*:[[:space:]]*"[^"]*"/"org": "{ORG_NAME}"/' > /tmp/project-config.json && mv /tmp/project-config.json .claude-plugin/project-config.json
else
  echo '{"org": "{ORG_NAME}"}' > .claude-plugin/project-config.json
fi
```

Replace `{ORG_NAME}` with the actual organization name.

### 0.4 Check Auth Token

```bash
AUTH_TOKEN=$(node -e "
  const fs = require('fs');
  try {
    const t = JSON.parse(fs.readFileSync(process.env.HOME + '/.aem/ims-token.json', 'utf8'));
    if (t.authToken && t.authTokenExpiry > Math.floor(Date.now()/1000) + 60) {
      process.stdout.write(t.authToken);
    }
  } catch (e) {}
")
echo "auth=${AUTH_TOKEN:+set}"
```

If no valid token exists, invoke the auth skill:

```
Skill({ skill: "aem-project-management:auth" })
```

### 0.5 Verify Authentication

```bash
AUTH_TOKEN=$(node -e "
  const fs = require('fs');
  try {
    const t = JSON.parse(fs.readFileSync(process.env.HOME + '/.aem/ims-token.json', 'utf8'));
    process.stdout.write(t.authToken || '');
  } catch (e) {}
")
ORG=$(cat .claude-plugin/project-config.json | node -e "
  const d = require('fs').readFileSync(0,'utf8');
  console.log(JSON.parse(d).org || '');
")
STATUS=$(curl -s -w "%{http_code}" -o /dev/null \
  -H "x-auth-token: ${AUTH_TOKEN}" \
  "https://admin.hlx.page/config/${ORG}/sites.json")
echo "Auth check: HTTP $STATUS"
```

If not 200, re-run the auth skill before proceeding.

---

## Phase 1: Gather Project Context

### 1.1 Fetch Sites via Config Service API

The Config Service API is the only reliable source for site information. Do not use `fstab.yaml`, README, or git remote URLs.

```bash
ORG=$(cat .claude-plugin/project-config.json | node -e "
  const d = require('fs').readFileSync(0,'utf8');
  console.log(JSON.parse(d).org || '');
")
AUTH_TOKEN=$(node -e "
  const fs = require('fs');
  try {
    const t = JSON.parse(fs.readFileSync(process.env.HOME + '/.aem/ims-token.json', 'utf8'));
    process.stdout.write(t.authToken || '');
  } catch (e) {}
")

curl -s -H "x-auth-token: ${AUTH_TOKEN}" -H "Accept: application/json" \
  "https://admin.hlx.page/config/${ORG}/sites.json" > .claude-plugin/sites-config.json

node -e "
  const d = require('fs').readFileSync('.claude-plugin/sites-config.json', 'utf8');
  const j = JSON.parse(d);
  if (!j.sites || !j.sites.length) {
    console.error('No sites returned — verify org name and re-authenticate if needed');
    process.exit(1);
  }
  console.log('Found ' + j.sites.length + ' site(s): ' + j.sites.map(s => s.name).join(', '));
"
```

If validation fails, verify the org name is correct, re-authenticate, and retry.

### 1.2 Fetch Per-Site Config

For each site, fetch its config:

```bash
curl -s -H "x-auth-token: ${AUTH_TOKEN}" \
  "https://admin.hlx.page/config/${ORG}/sites/{site-name}.json"
```

Extract:
- `code.owner` / `code.repo` — GitHub repository
- `content.source.url` — Content mountpath
- `content.source.type` — Content source type (markup, onedrive, google)

Multiple sites = repoless setup. Single site = standard setup.

Build context:
```
Organization: {org}
Site(s): {site1}, {site2}, ...
Setup: {repoless | standard}
Code Repo: {owner}/{repo}
Preview: https://main--{site}--{org}.aem.page/
Live: https://main--{site}--{org}.aem.live/
Login: https://admin.hlx.page/login/{org}/{site}
Config: https://admin.hlx.page/config/{org}/
```

---

## Phase 2: Generate Admin Guide

Output file: `project-guides/ADMIN-GUIDE.md` (run `mkdir -p project-guides` first).

```markdown
---
title: "[Project Name] - Admin Guide"
date: "[Full Date — e.g., February 17, 2026]"
---

# [Project Name] - Admin Guide

Complete administration guide for managing this Edge Delivery Services project.

## Quick Reference

### URLs

| Purpose | URL |
|---------|-----|
| **Login** | https://admin.hlx.page/login/{org}/{site} |
| **Config Service** | https://admin.hlx.page/config/{org}/ |
| **Preview** | https://main--{site}--{org}.aem.page/ |
| **Live** | https://main--{site}--{org}.aem.live/ |

### Sites (if multi-site/repoless)

| Site | Content Source | Preview | Live |
|------|----------------|---------|------|
| {site1} | [from site config] | https://main--{site1}--{org}.aem.page/ | https://main--{site1}--{org}.aem.live/ |

## Authentication

### Login

1. Open: https://admin.hlx.page/login/{org}/{site}
2. Sign in with your credentials

### Logout

```bash
curl -X POST -H "x-auth-token: $AUTH_TOKEN" \
  "https://admin.hlx.page/logout/{org}/{site}/main"
```

## User Management

### View Current Access

```bash
curl -H "x-auth-token: $AUTH_TOKEN" \
  "https://admin.hlx.page/config/{org}/sites/{site}/access.json"
```

### Add User

| Role | Command |
|------|---------|
| Admin | `POST /config/{org}/sites/{site}/access/admin.json` with `{"users": ["email"]}` |
| Author | `POST /config/{org}/sites/{site}/access/author.json` with `{"users": ["email"]}` |

### Remove User

```bash
curl -X DELETE -H "x-auth-token: $AUTH_TOKEN" \
  "https://admin.hlx.page/config/{org}/sites/{site}/access/admin/{email}.json"
```

## Content Operations

| Operation | Endpoint |
|-----------|----------|
| Preview page | `POST /preview/{org}/{site}/main/{path}` |
| Bulk preview | `POST /preview/{org}/{site}/main/*` |
| Publish page | `POST /live/{org}/{site}/main/{path}` |
| Bulk publish | `POST /live/{org}/{site}/main/*` |
| Unpublish | `DELETE /live/{org}/{site}/main/{path}` |
| Purge cache | `POST /cache/{org}/{site}/main/{path}` |
| Purge all | `POST /cache/{org}/{site}/main/*` |

## Code Operations

### Sync Code

```bash
curl -X POST -H "x-auth-token: $AUTH_TOKEN" \
  "https://admin.hlx.page/code/{owner}/{repo}/main"
```

## Common Tasks

| Task | Steps |
|------|-------|
| **Add new admin** | POST to `/config/{org}/sites/{site}/access/admin.json` |
| **Republish site** | POST `/preview/{org}/{site}/main/*` then `/live/{org}/{site}/main/*` |
| **Clear all cache** | POST to `/cache/{org}/{site}/main/*` |
| **Deploy code changes** | POST to `/code/{owner}/{repo}/main` |

## Troubleshooting

| Issue | Solution |
|-------|----------|
| 401 Unauthorized | Token expired — login again |
| 403 Forbidden | Insufficient permissions — check role |
| 404 Not Found | Check org/site/path spelling |
| 429 Rate Limited | Wait and retry |
| Cache not clearing | Try with `forceUpdate: true` |
| Code not syncing | Manual sync: POST to `/code/{owner}/{repo}/main` |

## Resources

| Resource | URL |
|----------|-----|
| Admin API Docs | https://www.aem.live/docs/admin.html |
| Config Service | https://www.aem.live/docs/config-service-setup |
```

---

## Phase 3: Customize for Project

Replace all placeholders with values from the Config Service API:
- `{org}` → actual organization name
- `{site}` → actual site name(s)
- `{owner}` / `{repo}` → code owner and repo from site config

If multi-site (repoless), add a section listing all sites with their preview URL, live URL, and content source.

Check for and document project-specific configurations:
- Custom headers: `/config/{org}/sites/{site}/headers.json`
- CDN configuration
- Any project-specific admin procedures

---

## Phase 4: Convert to Professional PDF

Save the completed markdown to `project-guides/ADMIN-GUIDE.md`. The file must start with YAML frontmatter:

```yaml
---
title: "[Project Name] - Admin Guide"
date: "[Full Date — e.g., February 17, 2026]"
---
```

Immediately invoke PDF conversion:

```
Skill({ skill: "aem-project-management:whitepaper", args: "project-guides/ADMIN-GUIDE.md project-guides/ADMIN-GUIDE.pdf" })
```

The whitepaper skill auto-cleans source files. Final output: `project-guides/ADMIN-GUIDE.pdf`.

Inform the user: "Admin guide complete: project-guides/ADMIN-GUIDE.pdf"

---

## Success Criteria

| Category | Check |
|----------|-------|
| **Data Source** | Config Service API called (`https://admin.hlx.page/config/{ORG}/sites.json`) |
| **Data Source** | Site list from API response, not fstab.yaml or codebase analysis |
| **Data Source** | Code repo info from site config API, not git remote |
| **Content** | All org/site values filled from Config Service API |
| **Content** | Login URL correct |
| **Content** | All API endpoints have correct org/site |
| **Content** | Multi-site documented (if applicable) |
| **Content** | Common tasks listed with correct paths |
| **Output** | PDF generated at `project-guides/ADMIN-GUIDE.pdf` |
| **Output** | All source files cleaned up (only PDF remains) |

---

**Communication:** Never use "EDS" as an acronym — always write "Edge Delivery Services" or "AEM Edge Delivery Services" in all output and documentation.
