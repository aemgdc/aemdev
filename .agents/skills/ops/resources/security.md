# Security & Confirmation Requirements

## Destructive Operations (Require User Confirmation)

Before ANY destructive operation:

1. **State the action clearly**: "This will unpublish /products/old-widget from the live site"
2. **Explain the impact**: "Users will get a 404 error when visiting this URL"
3. **Ask for explicit confirmation**: "Do you want to proceed? (yes/no)"
4. **Only execute after user confirms with "yes"**

| Operation | Resource | Risk Level |
|-----------|----------|------------|
| Unpublish (single/bulk) | `content.md` | HIGH — Removes from live site |
| Bulk publish (> 50 paths) | `content.md` | MEDIUM — Large surface area |
| Delete preview | `content.md` | MEDIUM |
| Delete code | `code.md` | HIGH — Affects all sites in repoless |
| Purge all cache (wildcard) | `cache.md` | MEDIUM — Site-wide cache miss spike |
| Remove from index | `index.md` | MEDIUM |
| Publish entire snapshot | `snapshots.md` | HIGH — Mass publish to live |
| Approve snapshot | `snapshots.md` | HIGH — Publishes all + clears snapshot |
| Delete snapshot | `snapshots.md` | MEDIUM |
| Remove user | `users.md` | HIGH — Revokes access |
| Stop job | `jobs.md` | MEDIUM — Can leave content half-published |
| Delete org/site config | `config-api.md` | CRITICAL — Can break site |
| Config update (org/site) | `config-api.md` | HIGH — POST replaces entire config |
| Delete secret | `secrets.md` | HIGH — Can break integrations |
| Revoke API key | `apikeys.md` | HIGH — Can break CI/CD |
| DA delete | `da.md` | HIGH — Permanently deletes from DA |
| DA copy/move (overwrite) | `da.md` | MEDIUM — Can silently overwrite |
| DA update config | `da.md` | HIGH — Can lock out all users |
| Revoke token | `tokens.md` | HIGH — Can break access |
| Delete config version | `versioning.md` | MEDIUM |
| Restore config version | `versioning.md` | HIGH — Replaces current config |
| Delete profile config | `profiles.md` | MEDIUM |
| Delete index config | `index-config.md` | MEDIUM |
| Delete sitemap config | `sitemap-config.md` | MEDIUM |

## Non-Destructive but Dangerous Operations

| Operation | Risk | Guardrail |
|-----------|------|-----------|
| Config update (POST) | Malformed config can break the entire site | Always GET current config first, show to user, confirm before POST |
| Code sync in repoless | Affects ALL sites sharing the repo | Check site count first; warn if > 1 |
| Bulk preview/publish (> 50 paths) | Large jobs, partial failures possible | Show path list, confirm, suggest batching for > 100 |
| Wildcard bulk operations | Can trigger thousands of jobs | Explain that `/*` creates an async job |
| DA config update | Must include CONFIG write permission | Validate config JSON includes a CONFIG write entry |

## Token Security

- Auth token stored at `~/.aem/ims-token.json` — never in project-config
- `.claude-plugin/` directory MUST be in `.gitignore`
- Tokens expire after ~24 hours
- Never log or display full token values
- Never store secret values, API keys, or access token values in config files

## Secret / API Key / Token Creation Safety

Secrets, API keys, and access tokens return their value **only once** at creation.

Before creating:
1. Warn the user: "The value will only be shown once. Make sure you're ready to store it securely."
2. Only proceed after user confirms.

After creation:
1. Display the value clearly: "Copy this value now. It cannot be retrieved again."
2. Never store the returned value in any tracked file.

## Config Update Safety

Before any config update (org, site, profile, or DA config):

1. Always GET the current config first — show it to the user.
2. Show the proposed change (diff or summary).
3. Warn about potential impact — a malformed body can break the site.
4. For DA config updates: config JSON **must** include at least one entry granting CONFIG write permission. Sending a config without it will lock everyone out (requires Cloudflare KV escalation to fix).

## Publish Safety

- If user says "publish" without a preceding preview, suggest: "Do you want me to preview first, then publish?"
- For bulk operations > 50 paths, always show the path list and ask for confirmation.
- For wildcard bulk operations (`/*`), explain this creates an async job that may process thousands of pages.

## Error Recovery

| Scenario | Recovery |
|----------|----------|
| Accidental unpublish | Re-publish: `POST /live/{org}/{site}/{ref}/{path}` |
| Accidental config delete | Restore from version: `POST /config/{org}.json?restoreVersion={id}` |
| Accidental secret/key delete | Cannot be recovered — create a new one and update integrations |
| Bad config update | List config versions, find last good one, restore it |
| Bulk job running wild | Stop it: `DELETE /job/{org}/{site}/{ref}/{topic}/{jobName}` |
| DA content accidentally deleted | Check for version via `/versionlist/` — restore if available |
| DA config locked everyone out | Requires Cloudflare KV access — escalate to DA admin team |
