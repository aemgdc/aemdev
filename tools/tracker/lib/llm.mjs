/**
 * llm.mjs — minimal client for LOCAL model inference over HTTP.
 *
 * Speaks two dialects, selected per tier in config:
 *   api: 'openai'  → llama.cpp `llama-server` / any OpenAI-compatible endpoint
 *                    (POST {endpoint}/v1/chat/completions, response_format json_schema)
 *   api: 'ollama'  → Ollama native (POST {endpoint}/api/chat, format: <schema>)
 *
 * Two exported calls:
 *   llmJson(tierCfg, {system, user, schema}) → parsed object
 *   callVision(tierCfg, images, prompt)      → text (or parsed object, with a schema)
 *
 * Schema-forced output is the reliability lever for small models — never parse free
 * text from them. Throws LlmUnavailable on transport failure so callers can route the
 * page to the escalation queue instead of guessing.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFileSync } from 'node:fs';

/**
 * A tier that could not answer, as distinct from a tier that answered badly.
 *
 * The distinction is the exit code, and it is the whole reason this is its own class:
 * a service that is down or wedged is exit 2 — "the page holds, the pipeline
 * continues" — while a model that returned unparseable nonsense is exit 3, a real
 * failure of the run. Collapsing the two makes a stopped service look like a corrupt
 * verdict, and every page in the batch gets a fabricated problem.
 */
export class LlmUnavailable extends Error {}

/**
 * POST JSON, parse the JSON reply, with exactly one deadline: `timeoutMs`.
 *
 * Deliberately node:http and not fetch(). A CPU-hosted 14B spends minutes on prompt
 * processing before emitting a single response byte, and undici (Node's fetch) imposes
 * its own 300s `headersTimeout` that no RequestInit option can raise — an
 * AbortController set to 20 minutes does not help. The symptom is a healthy,
 * still-working judge killed at exactly 5 minutes with a bare "fetch failed", so the
 * page lands in the escalation queue as if the model were down. It bites any prompt
 * that needs more than 5 minutes, which on CPU inference is most of them.
 */
function post(url, body, timeoutMs) {
  const target = new URL(url);
  const payload = JSON.stringify(body);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new LlmUnavailable(`${url} → HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new LlmUnavailable(`${url} → non-JSON reply: ${text.slice(0, 200)}`));
        }
      });
    });
    // One wall-clock budget for the whole exchange rather than a socket idle timer:
    // while the model chews through a prompt the socket is legitimately silent, so an
    // idle timer cannot tell "still working" from "hung".
    const timer = setTimeout(() => {
      req.destroy(new LlmUnavailable(`${url} → no reply within ${timeoutMs}ms`));
    }, timeoutMs);
    req.on('error', (e) => {
      reject(e instanceof LlmUnavailable ? e : new LlmUnavailable(`${url} → ${e.message}`));
    });
    req.on('close', () => clearTimeout(timer));
    req.end(payload);
  });
}

const chatUrl = (cfg) => `${cfg.endpoint.replace(/\/$/, '')}/v1/chat/completions`;

/*
 * Turn OFF chain-of-thought for the hybrid-reasoning models.
 *
 * Qwen3 and its relatives think by default, and llama.cpp routes that text to
 * `reasoning_content` — leaving `content` EMPTY until the thinking finishes. On a judge
 * prompt with a 900-token budget the model spends the entire budget reasoning, hits
 * `finish_reason: length`, and returns an empty string: eleven minutes, no answer, and
 * the caller sees only "model returned invalid JSON".
 *
 * Harmless where it does not apply. llama.cpp ignores the field unless the server was
 * started with `--jinja` AND the model's template reads it, so a non-thinking model is
 * unaffected.
 *
 * This is a per-request switch rather than a config field on purpose: a judge that
 * thinks is not a different tier, it is the same tier configured wrongly, and nothing
 * in this pipeline benefits from a verdict arriving 10x slower.
 */
const NO_THINKING = { chat_template_kwargs: { enable_thinking: false } };

/** OpenAI-dialect `response_format` for a schema-forced answer. */
const jsonSchemaFormat = (schema) => ({
  type: 'json_schema',
  json_schema: { name: 'verdict', strict: true, schema },
});

/*
 * Fall back to `reasoning_content` when `content` is empty. Belt and braces for a
 * server that ignores NO_THINKING: the reasoning text of a schema-constrained request
 * usually still contains the JSON, so the parse gets a chance instead of the run
 * failing outright.
 */
const messageText = (json) => {
  const msg = json.choices?.[0]?.message ?? {};
  return msg.content || msg.reasoning_content || '';
};

async function completeOpenAi(cfg, system, user, schema) {
  const body = {
    model: cfg.model,
    temperature: 0.1,
    max_tokens: cfg.maxTokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: jsonSchemaFormat(schema),
    ...NO_THINKING,
  };
  return messageText(await post(chatUrl(cfg), body, cfg.timeoutMs));
}

async function completeOllama(cfg, system, user, schema) {
  const body = {
    model: cfg.model,
    stream: false,
    format: schema,
    options: { temperature: 0.1, num_predict: cfg.maxTokens },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  const json = await post(`${cfg.endpoint.replace(/\/$/, '')}/api/chat`, body, cfg.timeoutMs);
  return json.message?.content ?? '';
}

/** Strip a markdown code fence a model wrapped its JSON in, then parse. */
const parseJson = (raw) => JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''));

/**
 * Run one schema-constrained completion against a tier config
 * ({api, endpoint, model, maxTokens, timeoutMs}). Retries once on bad JSON.
 */
export async function llmJson(tierCfg, { system, user, schema }) {
  const complete = tierCfg.api === 'ollama' ? completeOllama : completeOpenAi;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = await complete(
      tierCfg,
      system,
      attempt === 0 ? user : `${user}\n\nReturn ONLY valid JSON matching the schema.`,
      schema,
    );
    try {
      return parseJson(raw);
    } catch (e) {
      lastErr = new Error(`model returned invalid JSON: ${raw.slice(0, 200)}`);
    }
  }
  throw lastErr;
}

/* ------------------------------------------------------------------- vision tier */

/** Content type by extension, for the data: URI the VL model is handed. */
const IMAGE_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/**
 * One image → a data: URI.
 *
 * A Buffer is assumed PNG, which is what every screenshot path in this pipeline
 * produces. A string is a FILE PATH, never base64 — base64 and a path are both strings
 * and guessing between them silently sends a filename to the model as if it were an
 * image. An already-formed `data:` URI passes through, so a caller that has one need
 * not decode it just to have it re-encoded.
 */
function imagePart(image) {
  if (Buffer.isBuffer(image)) {
    return { mime: 'image/png', b64: image.toString('base64') };
  }
  const s = String(image);
  if (s.startsWith('data:')) return { url: s };
  const ext = s.split('.').pop().toLowerCase();
  const mime = IMAGE_MIME[ext];
  if (!mime) throw new Error(`callVision: unsupported image type "${ext}" (${s})`);
  return { mime, b64: readFileSync(s).toString('base64') };
}

const imageUrl = (image) => {
  const part = imagePart(image);
  return part.url || `data:${part.mime};base64,${part.b64}`;
};

/**
 * Send one or more images plus a prompt to a vision tier.
 *
 * `images` are Buffers, file paths, or `data:` URIs; `prompt` is the instruction text.
 * Returns the model's text, or the parsed object when `schema` is given.
 *
 * Two things this does that the ad-hoc call it replaces did not:
 *
 *   - it goes through `post()`, so the vision tier gets the same single wall-clock
 *     deadline as every other tier. The call it replaces used fetch() with an
 *     AbortSignal, which cannot outlive undici's 300s headersTimeout — and a CPU-hosted
 *     VL model on a full-height crop pair routinely takes longer than that, so a
 *     `timeoutMs` of 900000 was never actually in force.
 *   - it offers `schema`, so a visual verdict can be a machine-readable object rather
 *     than prose a caller has to guess at. Free text is the reason the visual judge's
 *     exit codes were fiction: it always exited 0 because nothing could read what the
 *     model said.
 *
 * Images come BEFORE the text in the content array. llama.cpp's multimodal handling
 * substitutes image tokens at the position the part appears, and a prompt that
 * references "IMAGE 1" / "IMAGE 2" must be read after them.
 *
 * Measured against the 7B VL tier: a multi-image message does arrive intact and in
 * order (swapping two images swaps the answer), but the model readily conflates the two
 * — asked for the word in each of two near-identical crops it answered with the first
 * one twice. So a PAIR comparison should be composited into a single side-by-side image
 * and described as left/right; treat two separate images as the weaker form, not the
 * default.
 */
export async function callVision(tierCfg, images, prompt, { system = null, schema = null } = {}) {
  const list = Array.isArray(images) ? images : [images];
  if (!list.length) throw new Error('callVision: no images');
  const content = [
    ...list.map((img) => ({ type: 'image_url', image_url: { url: imageUrl(img) } })),
    { type: 'text', text: prompt },
  ];
  const body = {
    model: tierCfg.model,
    temperature: 0.1,
    max_tokens: tierCfg.maxTokens,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content },
    ],
    ...(schema ? { response_format: jsonSchemaFormat(schema) } : {}),
    ...NO_THINKING,
  };
  const raw = messageText(await post(chatUrl(tierCfg), body, tierCfg.timeoutMs));
  if (!schema) return raw;
  try {
    return parseJson(raw);
  } catch (e) {
    throw new Error(`vision model returned invalid JSON: ${raw.slice(0, 200)}`);
  }
}

/** Quick connectivity probe for a tier; returns {ok, detail}. */
export async function probe(tierCfg) {
  try {
    const base = tierCfg.endpoint.replace(/\/$/, '');
    const url = tierCfg.api === 'ollama' ? `${base}/api/tags` : `${base}/v1/models`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return { ok: res.ok, detail: `${url} → ${res.status}` };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}
