# How AEM Publish backend requests are routed (Fastly / www.aemdev.org)

**Service:** `www.aemdev.org` — Fastly VCL service id `tTSyFJgoN3lZqBOA0n3Rd7`.
**Config mirror in git:** [`config/fastly/www-aemdev-org/`](../../config/fastly/www-aemdev-org/)
(read-only sync — see [`.agents/plans/fastly-cdn-cicd.md`](../plans/fastly-cdn-cicd.md);
there is no push pipeline yet, so live changes are made in the Fastly UI and then synced down).

## The two backends

The service fronts **two origins** ([`objects/backend.json`](../../config/fastly/www-aemdev-org/objects/backend.json)):

| Backend | Origin host | When it's used |
|---|---|---|
| `Helix 5/DA Origin` | `main--aemdev--aemgdc.aem.live` | **Default** — all EDS/Helix page traffic |
| `AEM Publish Services Origin` | `publish-p121227-e1306133.adobeaemcloud.com` | Requests matching the **"services path"** request condition |

## How a request picks the AEM Publish backend

Backend selection happens in `vcl_recv` (see [`generated.vcl`](../../config/fastly/www-aemdev-org/generated.vcl)):

1. Default: `set req.backend = F_Helix_5_DA_Origin;`
2. Then the **"services path"** request condition
   ([`objects/condition.json`](../../config/fastly/www-aemdev-org/objects/condition.json)) overrides it:
   ```vcl
   # Request Condition: services path  Prio: 10
   if ( req.url.path ~ "^/(services|content/dam)/" ) {
     set req.backend = F_AEM_Publish_Services_Origin;
   }
   ```
3. The `AEM Publish Services Origin` backend has **`override_host = publish-p121227-e1306133.adobeaemcloud.com`**,
   so the upstream `Host` header is rewritten to the AEM publish domain. This is why the
   browser keeps talking to `www.aemdev.org` while AEM serves the bytes.

So: **a path matched by the "services path" condition → AEM Publish backend → Host rewritten to the AEM publish origin.** Everything else → Helix.

## What routes to AEM Publish today

The condition statement is the single source of truth for what passes through. Current matches:

- `^/services/` — the DAM servlet (`/services/damservlet?path=...`) used by the
  [`dam-display`](../../blocks/dam-display/dam-display.js) block.
- `^/content/dam/` — DAM assets themselves (PDF binaries + renditions like
  `cq5dam.web.1280.1280.jpeg`). **Added so asset/rendition URLs returned by the servlet
  (which are server-relative `/content/dam/...`) resolve on `www.aemdev.org` instead of
  404ing against the Helix origin.**

To pass another path prefix through to AEM Publish, **widen this one condition statement** —
do not add a second backend. The `override_host` already covers any path the condition matches.

## Related caveats

- **Query-string strip snippet** (`strip query string on vcl_rcv`, [`objects/snippet.json`])
  exempts `^/services/` from query-string stripping. DAM asset/rendition URLs carry no
  query string (and image extensions are already exempt), so `/content/dam/` was not added
  there. Revisit if an AEM-Publish path ever needs a preserved query string.
- Caching: `vcl_fetch` sets a default 2-minute TTL; AEM cache-control headers may override.

## Changing this in the Fastly UI

To widen what routes to AEM Publish (e.g. add another path prefix):

1. Fastly app → **Observability/Configure** → select service **www.aemdev.org**
   (id `tTSyFJgoN3lZqBOA0n3Rd7`).
2. Click **Edit configuration → Clone version N to edit** (Fastly only lets you edit a
   draft/cloned version, never the active one).
3. Left nav → **Settings → Conditions** (request conditions live here). Find the request
   condition named **`services path`**.
4. Edit its **Apply if…** statement. To add `/content/dam/` alongside `/services/`:
   ```
   req.url.path ~ "^/(services|content/dam)/"
   ```
   (Same condition is also reachable via **Origins → Hosts → AEM Publish Services Origin →
   attached request condition** — editing it in either place changes the same object.)
5. **Save**, then **Activate** the cloned version.
6. Verify: `curl -I https://www.aemdev.org/content/dam/<somepath>/_jcr_content/renditions/cq5dam.web.1280.1280.jpeg`
   should now return `200` (was `404`, served by Helix). A DAM page such as a
   `meetup-recaps` recap should render thumbnails/PDF links.
7. Sync git: run the **`sync-fastly-config`** GitHub workflow (or wait for the daily
   `17:06 UTC` schedule) so `config/fastly/...` reflects the live change.

Do **not** add a second backend for new paths — just extend this one condition statement;
the `override_host` already rewrites the Host for everything the condition matches.
