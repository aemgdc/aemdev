# Sensitive Data Handling

Many endpoints return secrets, credentials, PII, or organizational metadata. Responses must be handled carefully to prevent leaking into chat history or terminal scrollback.

## Sensitive Endpoints (Default to Summarized Output)

| Endpoint | Sensitive Content |
|----------|-------------------|
| `/config/{org}/apiKeys.json`, `/config/{org}/sites/{site}/apiKeys.json` | API key IDs, expiration, role metadata; `value` (JWT) on create |
| `/config/{org}/sites/{site}/tokens.json` | Token IDs; `value` (`hlx_…`) on create |
| `/config/{org}/sites/{site}/secrets.json` | Secret names; `value` on create |
| `/config/{org}.json`, `/config/{org}/sites/{site}.json` | User emails, role mappings, allowed domains, content source URLs, contentBusId |
| `/config/{org}/users.json` | User emails and IDs |
| `/log/{org}/{site}/{ref}` | User emails, IPs, paths edited, timestamps |
| `/profile` | IMS user ID, session IDs, scopes |

## Default Behavior on These Endpoints

These rules apply unconditionally on every org — personal, sandbox, dev, stage, prod, customer.

1. **Lead with a summary, not the raw payload.** Example: "Found 3 API keys (IDs: …). Want me to show full details?" — not a dump of the full JSON.
2. **Redact emails by default.** Show `<3 admin users>` or `j***@example.com` on the first response.
3. **Never echo a credential `value` field a second time.** Display it exactly once at creation, with the instruction to copy it. Do not include it in any later message or summary.
4. **Only these exact phrases un-redact:** "show full", "show un-redacted", "show raw", "show emails". Imperative verbs alone ("list users", "show users") do NOT un-redact.

## First-Touch Awareness

Before the first sensitive operation against any org in a session, surface a one-line note:

> "Querying org `{org}`. I'll redact emails by default — say 'show full' to see un-redacted output."

## Memory Rules

Never write to memory:
- API key IDs, JWTs, or `value` fields
- Token IDs or `hlx_…` secret strings
- Secret names paired with their values
- User emails from log entries or config dumps
- Full config bodies (role mappings, contentBusId, source URLs)
- IMS tokens, session IDs, IPs, or anything from `/profile`

## POST Safety on Credential Endpoints

Some endpoints **create a credential on any POST**, even with an empty body. This applies to:
- `/config/{org}/apiKeys.json`
- `/config/{org}/sites/{site}/apiKeys.json`
- `/config/{org}/sites/{site}/tokens.json`
- `/config/{org}/sites/{site}/secrets.json`

Never POST to these endpoints to "probe" or "test". Only POST when the user has explicitly asked to create a credential with the intended role/scope/expiration provided.
