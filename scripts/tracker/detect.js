/*
 * detect.js — is this text actually in the language it is supposed to be in?
 *
 * Browser + Node. Zero dependencies, no DOM, no Node APIs. See ./README.md.
 *
 * ─── Why detection lives here and not in a library ──────────────────────────
 *
 * The question this file answers is NOT "which of 400 languages is this?", which is
 * what a language-identification library solves. It is the far narrower, far more
 * answerable question the QA tiers actually ask:
 *
 *     this text is on a /de/ page. Is it German, or is it still English?
 *
 * Framing it as a two-way decision between the EXPECTED language and English is what
 * makes a zero-dependency implementation trustworthy. A general LID model has to keep
 * Dutch, Danish and Afrikaans apart; we only ever have to keep the ten locales in
 * `locales.js` apart from each other and from English, on a corpus (technical prose
 * from one site's own blocks) that is about as clean as text gets.
 *
 * The other reason is honesty about short strings. Most of what a tier checks is not
 * paragraphs — it is block cell values: a CTA, a speaker's role, an eyebrow label.
 * Those are 2–6 tokens, sometimes pure proper nouns ("Document Authoring",
 * "adaptTo 2026"), where NO detector can answer and the only correct output is "I
 * don't know". A library returns its best guess with a confidence nobody calibrated;
 * this file returns `null` and the callers gate on it. A false "still English!" on a
 * cell reading "GitHub Actions" would train reviewers to ignore the check, which costs
 * more than the check is worth.
 *
 * Ported from the upstream tracker's language detector, minus its brand vocabulary.
 * The reasoning comments come with the code because every one of them is a defect
 * somebody already paid for.
 */

import { LOCALES, SOURCE_LOCALE, locale } from './locales.js';

/* ------------------------------------------------------------------ the script gate */

/*
 * Unicode ranges that settle a language without any statistics at all.
 *
 * Written as `\u` escapes rather than literal range endpoints: `[一-鿿]` and
 * `[㐀-䶿]` are indistinguishable by eye in a review, so a wrong endpoint is
 * impossible to spot and trivial to introduce. The ranges are CJK unified
 * ideographs + extension A, hiragana + katakana, and Hangul syllables + both jamo
 * blocks. `latin` is a-z plus Latin-1/Extended-A/B accents.
 */
const SCRIPT_RANGES = {
  hangul: /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/g,
  kana: /[\u3040-\u30ff]/g,
  han: /[\u3400-\u4dbf\u4e00-\u9fff]/g,
  latin: /[a-z\u00c0-\u024f]/gi,
};

/*
 * The script gate reads its answers out of the locale registry rather than naming
 * locale codes here, so adding a locale cannot leave the gate stale. Where a script
 * maps to exactly one locale (kana → ja, hangul → ko) that locale IS the answer;
 * where it maps to two (han → zh-cn, zh-tw) the gate reports the ambiguity instead
 * of guessing. See `hanVariant()`.
 */
const codesForScript = (script) => LOCALES.filter((l) => l.script === script).map((l) => l.code);
const KANA_CODES = codesForScript('kana');
const HANGUL_CODES = codesForScript('hangul');
const HAN_CODES = codesForScript('han');

/**
 * Locales that Han characters alone cannot tell apart: both Chinese locales, plus
 * Japanese — because Japanese written without kana is Han and nothing else.
 */
const HAN_AMBIGUOUS = new Set([...HAN_CODES, ...KANA_CODES]);

/*
 * A CJK page still carries Latin brand names ("Document Authoring", "aem.live"), so
 * CJK does not have to dominate absolutely — it just has to be present in real
 * quantity. Conversely a Latin page quoting two Han characters is not Chinese, which
 * is what the ratio protects against.
 */
const CJK_LATIN_RATIO = 0.25;

/*
 * Simplified vs Traditional: the one tie-break the script gate can make on its own.
 *
 * NEW in this port. The upstream registry had a single Han locale, so `han` was settled
 * answer there; aemdev.org has two (zh-cn and zh-tw), and picking one at random would
 * report a wrong-language defect on half of all correctly translated Chinese pages —
 * exactly the false finding the rest of this file is built to avoid.
 *
 * The two strings are counterparts, index for index, so a reviewer can check a pair by
 * eye and a test can assert they stay the same length. Only characters whose two forms
 * genuinely differ are listed; the enormous shared middle of the writing system
 * (的, 是, 在, 和 …) says nothing and is left out.
 *
 * Two deliberate limits:
 *  - it chooses only BETWEEN the two Chinese locales. It never rules Japanese out,
 *    because many of the traditional forms here (東, 車, 門, 時) are ordinary Japanese
 *    kanji. `hanOnly` therefore stays set on the result, and `translationVerdict()` is
 *    what resolves it against the language the page was supposed to be in.
 *  - no signal means no answer. Real prose of a sentence or two hits several of these;
 *    a stat label like "165支店" hits none, and abstaining there is the correct output.
 */
const HAN_VARIANT_MARKS = {
  'zh-cn': '这们说语华业东车门无马龙义广应长时开关见对发个为从众电国会学与网页单该后术数变样题现实让处务员类构结统编译档库认证请问简体',
  'zh-tw': '這們說語華業東車門無馬龍義廣應長時開關見對發個為從眾電國會學與網頁單該後術數變樣題現實讓處務員類構結統編譯檔庫認證請問簡體',
};

/*
 * An empty character class never matches, so a Han locale with no marker string
 * simply abstains rather than throwing at module load.
 */
const HAN_VARIANT_RES = HAN_CODES.map((code) => [
  code,
  new RegExp(`[${HAN_VARIANT_MARKS[code] || ''}]`, 'g'),
]);

const countMatches = (text, re) => (text.match(re) || []).length;

/**
 * How much of each writing system is in this text?
 *
 * Exported because the layout and fidelity tiers want it too: "this /ja/ cell is 90%
 * Latin" is a finding on its own, and it is the same count the gate runs on.
 */
export function scriptCounts(text) {
  const raw = String(text ?? '');
  const hangul = countMatches(raw, SCRIPT_RANGES.hangul);
  const kana = countMatches(raw, SCRIPT_RANGES.kana);
  const han = countMatches(raw, SCRIPT_RANGES.han);
  const latin = countMatches(raw, SCRIPT_RANGES.latin);
  return {
    hangul,
    kana,
    han,
    latin,
    cjk: hangul + kana + han,
  };
}

/** Which Chinese locale does this Han text look like? `null` when nothing says. */
export function hanVariant(text) {
  const raw = String(text ?? '');
  const ranked = HAN_VARIANT_RES
    .map(([code, re]) => ({ code, hits: countMatches(raw, re) }))
    .sort((a, b) => b.hits - a.hits);
  const [top, next] = ranked;
  if (!top || top.hits === 0) return null;
  // A tie is not an answer. Mixed-form text is either a mistake in the page or a
  // quotation, and either way a coin flip would be the wrong thing to report.
  if (next && next.hits === top.hits) return null;
  return top.code;
}

/* --------------------------------------------------------------- the word profiles */

/*
 * High-frequency function words per language. Content words are deliberately absent:
 * they track the SUBJECT, not the language, so a German page about "Dashboard",
 * "Pipeline" and "Cloud" would score as English on a content-word list. Function words
 * are the part of a sentence that cannot be borrowed.
 *
 * These lists overlap heavily on purpose — `de` belongs to French, Spanish AND
 * Portuguese; `la` to three of them; `i` to Polish and Italian. That overlap is not a
 * flaw to be pruned, it is DATA, and `WORD_WEIGHTS` below is what turns it into
 * discrimination: a word's evidentiary value is inversely proportional to how many of
 * these languages contain it. `und` (German only) counts for a full point; `de` (three
 * languages) counts for a third. Pruning the shared words instead would throw away the
 * fact that a text full of `de`, `la` and `des` is definitely one of the Romance
 * languages even before we know which — which is exactly the signal that keeps English
 * from winning by default on a text whose distinctive words happen to be rare.
 */
export const FUNCTION_WORDS = {
  en: ['the', 'of', 'and', 'to', 'in', 'is', 'that', 'for', 'it', 'with', 'as', 'on', 'by',
    'this', 'be', 'are', 'from', 'at', 'an', 'a', 'have', 'has', 'was', 'were', 'which',
    'or', 'not', 'but', 'can', 'will', 'their', 'its', 'these', 'they', 'we', 'you',
    'more', 'also', 'than', 'other', 'into', 'through', 'about', 'them', 'been', 'would'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'mit', 'für', 'von', 'den', 'dem', 'des',
    'ein', 'eine', 'einen', 'einer', 'sich', 'auch', 'werden', 'wird', 'wurde', 'auf', 'im',
    'zu', 'als', 'aus', 'bei', 'nach', 'über', 'durch', 'oder', 'wenn', 'dass', 'kann',
    'sie', 'ihre', 'ihren', 'diese', 'dieser', 'dieses', 'sind', 'haben', 'hat', 'war',
    'zur', 'zum', 'am', 'an', 'um', 'noch', 'nur', 'sowie', 'damit', 'wie'],
  /*
   * `a` is deliberately absent, though French has it (il a). It is English's
   * second-commonest word and French's is comparatively rare, so listing it in both
   * prices English's strongest short-string signal down to a coin flip — which is what
   * made "Request a Demo" undetectable. One shared entry can do that much damage
   * precisely because the weighting is inverse-frequency.
   */
  fr: ['le', 'la', 'les', 'de', 'des', 'du', 'et', 'est', 'un', 'une', 'dans', 'pour',
    'que', 'qui', 'sur', 'avec', 'pas', 'plus', 'ce', 'cette', 'ces', 'au', 'aux', 'par',
    'ne', 'son', 'ses', 'leur', 'leurs', 'nous', 'vous', 'être', 'ont', 'sont',
    'ainsi', 'mais', 'ou', 'comme', 'aussi', 'tout', 'tous', 'même', 'entre', 'sans',
    'elle', 'ils', 'lui', 'donc', 'afin', 'lors', 'dont'],
  es: ['el', 'la', 'los', 'las', 'de', 'del', 'y', 'es', 'un', 'una', 'en', 'para',
    'que', 'con', 'por', 'no', 'se', 'su', 'sus', 'como', 'más', 'pero', 'este', 'esta',
    'estos', 'al', 'lo', 'son', 'han', 'ha', 'está', 'también', 'entre', 'sobre', 'sin',
    'todo', 'todos', 'muy', 'ya', 'cuando', 'donde', 'desde', 'hasta', 'ser',
    'ellos', 'nuestra', 'nuestro'],
  it: ['il', 'lo', 'la', 'i', 'gli', 'le', 'di', 'del', 'della', 'dei', 'delle', 'e', 'è',
    'un', 'una', 'in', 'per', 'che', 'con', 'da', 'non', 'si', 'su', 'come', 'più',
    'questo', 'questa', 'al', 'alla', 'sono', 'ha', 'hanno', 'anche', 'tra', 'senza',
    'tutti', 'tutto', 'ma', 'nel', 'nella', 'dal', 'alle', 'essere', 'loro', 'suo', 'sua'],
  /*
   * Portuguese and Polish are carried over from the upstream profiles (`pt-BR` there, `pt`
   * here — the function words below are identical in both varieties, which is why the
   * list transfers unchanged rather than being rebuilt). Nothing in THIS repo has yet
   * scored them against a real translated page, so treat a `pt` or `pl` answer as
   * weaker than a `de` or `fr` one until a corpus exists.
   *
   * `a` is dropped from the Portuguese list for the reason the `fr` list documents
   * above — it is a real Portuguese article, but it is also English's second-commonest
   * word, and one shared entry at inverse-frequency weighting is enough to lose a short
   * English string. `as` is knowingly left in: it collides too, but English does not
   * lean on it the way it leans on `a`.
   */
  pt: ['o', 'os', 'as', 'de', 'do', 'da', 'dos', 'das', 'e', 'é', 'um', 'uma',
    'em', 'para', 'que', 'com', 'por', 'não', 'se', 'sua', 'seu', 'como', 'mais', 'mas',
    'este', 'esta', 'ao', 'à', 'são', 'tem', 'foi', 'também', 'entre', 'sobre', 'sem',
    'todos', 'todo', 'já', 'quando', 'onde', 'desde', 'até', 'ser', 'pelo', 'pela',
    'nos', 'nas', 'no', 'na'],
  pl: ['i', 'w', 'z', 'na', 'do', 'nie', 'się', 'jest', 'że', 'to', 'o', 'od', 'po',
    'za', 'dla', 'przez', 'oraz', 'lub', 'jak', 'ale', 'są', 'być', 'może', 'który',
    'która', 'które', 'tym', 'tej', 'tego', 'aby', 'przy', 'bez', 'wszystkich', 'ich',
    'jego', 'jej', 'ma', 'było', 'były', 'także', 'więc', 'gdy', 'czy', 'już', 'tylko'],
};

/*
 * Orthographic signatures — characters and letter sequences that a language uses and
 * its neighbours essentially don't.
 *
 * These earn their place on the SHORT strings, which is where the function-word profile
 * has nothing to work with. "Fordern Sie eine Demo an" has three German function words
 * and resolves cleanly; "Veranstaltungsübersicht" has none at all, and only `ung` + the
 * umlaut + the compound shape says German. Weighted lower than a function word because
 * they are suggestive rather than conclusive: `tion` is French AND English, and a single
 * `ó` is Spanish, Portuguese, Italian or Polish. Individually weak, collectively
 * decisive.
 */
export const SIGNATURES = {
  en: [[/\bth/g, 0.3], [/ing\b/g, 0.4], [/tion\b/g, 0.3], [/\bwh/g, 0.4]],
  de: [[/[äöüß]/g, 1.2], [/sch/g, 0.8], [/ung\b/g, 0.8], [/keit\b/g, 1.0], [/\bge/g, 0.3]],
  fr: [[/[çœ]/g, 1.5], [/[èêàâîôûëï]/g, 0.9], [/eux\b/g, 0.9], [/\bqu'/g, 1.2], [/aient\b/g, 1.2]],
  es: [[/[ñ¿¡]/g, 1.5], [/ción\b/g, 1.2], [/dad\b/g, 0.7], [/\bll/g, 0.5], [/miento\b/g, 1.0]],
  it: [[/zione\b/g, 1.2], [/\bgli\b/g, 1.0], [/[àèìòù]/g, 0.8], [/cch/g, 0.9], [/\bgn/g, 0.5]],
  pt: [[/[ãõ]/g, 1.5], [/ção\b/g, 1.5], [/ões\b/g, 1.5], [/nh/g, 0.5], [/lh/g, 0.5]],
  pl: [[/[łąężźćńś]/g, 1.5], [/sz/g, 0.6], [/cz/g, 0.6], [/rz/g, 0.6], [/prz/g, 0.9], [/ość\b/g, 1.2]],
};

/*
 * Which registry locales the statistical half can actually see.
 *
 * Derived from the registry so that adding, say, Dutch to `locales.js` cannot silently
 * leave detection blind to it: a Latin-script locale with no profile would score zero
 * for ever and every Dutch page would read as English. `UNPROFILED_LOCALES` is exported
 * so a test can assert it is empty rather than a reviewer having to notice.
 */
const LATIN_LOCALES = codesForScript('latin');

export const UNPROFILED_LOCALES = LATIN_LOCALES.filter((code) => !FUNCTION_WORDS[code]);

/** The Latin-script locales detection is trained on, in registry order. */
export const DETECTABLE_LANGS = LATIN_LOCALES.filter((code) => FUNCTION_WORDS[code]);

/*
 * Evidentiary weight per (language, word): 1 / (how many languages use it).
 * Computed once at module load from the profiles above, so adding a word to one list
 * automatically re-prices it everywhere else. Hand-maintaining these numbers would
 * guarantee they drift out of step with the lists the moment anyone extends one.
 */
export const WORD_WEIGHTS = (() => {
  const shared = new Map();
  for (const lang of DETECTABLE_LANGS) {
    for (const w of FUNCTION_WORDS[lang]) shared.set(w, (shared.get(w) || 0) + 1);
  }
  const out = {};
  for (const lang of DETECTABLE_LANGS) {
    out[lang] = new Map(FUNCTION_WORDS[lang].map((w) => [w, 1 / shared.get(w)]));
  }
  return out;
})();

/** Word tokens, lowercased, punctuation and digits stripped. */
export function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}'’-]+/gu, ' ')
    .split(' ')
    .filter((t) => t.length > 0);
}

/**
 * How much language-bearing evidence a text contains at all — counted, crucially,
 * BEFORE asking which language won.
 *
 * Proper nouns, product names, numbers and URLs carry no language. A cell reading
 * "Document Authoring on aem.live" is not English that failed to translate — it is text
 * with nothing to translate, and it is IDENTICAL in every locale by design. This is the
 * single most important guard in the file: without it, every product-name cell in all
 * ten locales reports as untranslated English, which is thousands of false findings and
 * the fastest way to get the whole check switched off.
 *
 * Counts two kinds of mark, because the two languages at opposite ends of this problem
 * announce themselves in different ways. English is function-word-rich and
 * orthographically unmarked; Polish is the reverse — "Jeśli myślisz o wydajności
 * strony, prawdopodobnie wyobrażasz sobie…" has few listed function words but is
 * saturated with ł/ś/ż/ę. Counting only function words would rate that sentence as thin
 * evidence when it is in fact unmistakable.
 *
 * @param text   the raw text; only its lowercased form is used, for the marks
 * @param tokens its tokens, passed in when the caller already has them
 */
export function evidence(text, tokens = tokenize(text)) {
  const lower = String(text ?? '').toLowerCase();
  let words = 0;
  for (const t of tokens) {
    if (DETECTABLE_LANGS.some((lang) => WORD_WEIGHTS[lang].has(t))) words += 1;
  }
  /*
   * Only the orthography marks that are actually distinctive — the weight >= 0.8
   * entries. `\bth` and `ing\b` are common enough in several of these languages'
   * loanwords that counting them as evidence would let any Latin text clear the floor.
   */
  let marks = 0;
  for (const lang of DETECTABLE_LANGS) {
    for (const [re, weight] of SIGNATURES[lang] || []) {
      if (weight >= 0.8) marks += countMatches(lower, re);
    }
  }
  return { words, marks, total: words + Math.min(marks, 6) * 0.5 };
}

/* ------------------------------------------------------------------- detectLanguage */

/**
 * Which language is this text in?
 *
 * @returns {{ code: string|null, script: string, confidence: number, hanOnly: boolean,
 *             scores: Record<string, number>, tokens: number, evidence: number }}
 *
 * `code` is a locale code from `locales.js`, or `null` when there isn't enough signal
 * to answer — treat that as "unknown", never as "English". `script` is one of
 * `none` (no letters at all), `latin`, `kana`, `hangul`, `han`, or `other` (letters in
 * a script no tracked locale uses).
 *
 * `confidence` is deliberately NOT a probability. It answers "how clearly did this
 * win?", which is the only question a caller deciding whether to raise a finding
 * actually has.
 */
export function detectLanguage(text) {
  const raw = String(text ?? '');
  const blank = {
    code: null,
    script: 'none',
    confidence: 0,
    hanOnly: false,
    scores: {},
    tokens: 0,
    evidence: 0,
  };
  if (!raw.trim()) return blank;

  /*
   * 1. The script gate. Non-Latin scripts are conclusive and need no statistics:
   *    Hangul is only Korean, kana is only Japanese, and Han without kana is Chinese.
   *    Run BEFORE tokenizing, because `tokenize()` has nothing useful to say about a
   *    script with no word delimiters — and before any word scoring, because a page of
   *    Han characters is not German whatever the word scores say.
   */
  const counts = scriptCounts(raw);
  if (counts.cjk > 0 && counts.cjk >= counts.latin * CJK_LATIN_RATIO) {
    const { hangul, kana, han } = counts;
    if (hangul >= kana && hangul >= han) {
      return {
        ...blank,
        code: HANGUL_CODES[0],
        script: 'hangul',
        confidence: 1,
        scores: { [HANGUL_CODES[0]]: hangul },
        evidence: 1,
      };
    }
    if (kana > 0) {
      // Japanese prose always mixes kana with kanji; Chinese never uses kana. So ANY
      // kana settles it, even against a much larger Han count.
      return {
        ...blank,
        code: KANA_CODES[0],
        script: 'kana',
        confidence: 1,
        scores: { [KANA_CODES[0]]: kana + han },
        evidence: 1,
      };
    }
    /*
     * Han with no kana. `hanVariant()` may name a Chinese locale, but the answer stays
     * flagged `hanOnly` either way — because Japanese written without kana is
     * indistinguishable from Chinese by script alone, and short Japanese strings
     * routinely have none.
     *
     * Found on real content upstream: a Japanese page's stat labels "165支店"
     * and "従業員数 4,000 人" are ordinary Japanese and were reported as "reads as
     * Chinese, expected Japanese". Two false wrong-language findings on a correctly
     * translated page, which is exactly the kind of noise that gets a check ignored.
     *
     * The flag is resolved by `translationVerdict()`, which knows what language was
     * expected. `detectLanguage` deliberately does NOT guess between Han and Japanese:
     * with no kana there is genuinely no evidence either way, and inventing a
     * preference here would just move the false positive to the other locale.
     */
    const variant = hanVariant(raw);
    return {
      ...blank,
      code: variant,
      script: 'han',
      confidence: variant ? 1 : 0,
      hanOnly: true,
      scores: Object.fromEntries([...HAN_CODES, ...KANA_CODES].map((c) => [c, han])),
      evidence: 1,
    };
  }

  // 2. Latin script — weighted function words plus orthographic signatures.
  const tokens = tokenize(raw);
  if (!tokens.length) return { ...blank, script: counts.latin ? 'latin' : 'none' };
  /*
   * Letters, but in none of the four scripts the registry uses (Cyrillic, Greek,
   * Devanagari…). Scoring that against Latin word lists would return a nonsense winner
   * with a real-looking score, so it is its own answer.
   */
  if (!counts.latin) return { ...blank, script: 'other', tokens: tokens.length };

  const lower = raw.toLowerCase();
  const ev = evidence(raw, tokens);

  const scores = {};
  for (const lang of DETECTABLE_LANGS) {
    let score = 0;
    for (const t of tokens) score += WORD_WEIGHTS[lang].get(t) || 0;
    // Normalize by token count so a long paragraph and a short heading are scored on
    // the same scale — otherwise every long text beats every short one.
    score /= tokens.length;
    for (const [re, weight] of SIGNATURES[lang] || []) {
      score += (countMatches(lower, re) / tokens.length) * weight * 0.5;
    }
    scores[lang] = Number(score.toFixed(4));
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  /*
   * Refuse to answer with no evidence at all. This is the product-name cell
   * ("Document Authoring", "columns-10-90", "adaptTo 2026") and the answer is unknown —
   * which the tiers treat as "no finding" but still surface to the reviewer as
   * unverified, rather than as "no problem".
   */
  if (ev.total < 1 || top[1] <= 0) {
    return {
      ...blank,
      script: 'latin',
      scores,
      tokens: tokens.length,
      evidence: ev.total,
    };
  }
  /*
   * Confidence is the product of two independent things, and conflating them was the
   * first version's bug:
   *
   *   margin   — how clearly the winner beat the runner-up. Answers "which language",
   *              and is 1 when nothing else scored at all.
   *   strength — how much evidence there was to decide on. Answers "should you believe
   *              this at all".
   *
   * A text with a single function word can have a perfect margin (nothing else matched)
   * while being nearly worthless as evidence. Reporting that as confidence 1.0 is how a
   * detector earns a reputation for confident nonsense. Three marks is the point at
   * which a short string is genuinely decided, so that is where strength saturates.
   */
  const margin = second && second[1] > 0 ? (top[1] - second[1]) / top[1] : 1;
  const strength = Math.min(1, ev.total / 3);
  const confidence = Math.max(0, Math.min(1, margin)) * strength;
  return {
    ...blank,
    code: top[0],
    script: 'latin',
    confidence: Number(confidence.toFixed(3)),
    scores,
    tokens: tokens.length,
    evidence: Number(ev.total.toFixed(1)),
  };
}

/* ----------------------------------------------------------------- the QA gate verdict */

/**
 * The targeted question: is this text in the language it is supposed to be in?
 *
 * Deliberately a three-way answer, not a boolean. `uncertain` is the most common
 * outcome on block cell values and it is a legitimate one — see `evidence()`.
 * Collapsing it into `untranslated` would report every product name as untranslated;
 * collapsing it into `translated` would silently pass genuinely untranslated short
 * strings. It has to stay its own answer and reach the human as one.
 *
 * `minTokens` exists because the margin on a 2-token string is noise. Four is the point
 * at which a CTA-length string ("Fordern Sie eine Demo an") carries enough function
 * words to be worth believing; below it, only a non-Latin script (which is conclusive
 * at any length) produces a verdict.
 *
 * A text that reads as a THIRD language is `uncertain`, not `untranslated`, and the
 * `reason` says `other-language`. Spanish, Portuguese and Italian share so much
 * function-word mass that "reads as Portuguese on a Spanish page" is more often a limit
 * of this detector than a defect in the page, and it needs a human to say which. "Reads
 * as English" carries no such ambiguity, which is why that one alone is a verdict.
 *
 * @returns {{ verdict: 'translated'|'untranslated'|'uncertain', reason: string,
 *             detail: string, confidence: number, detected: string|null,
 *             script: string, evidence: number }}
 *   `confidence` is the DETECTOR's confidence in `detected`, not a confidence in the
 *   verdict: an `other-language` answer can be confidently detected and still need
 *   adjudicating.
 */
export function translationVerdict({
  text, expected, minTokens = 4, minConfidence = 0.15,
} = {}) {
  const d = detectLanguage(text);
  const target = locale(expected);
  const out = (verdict, reason, detail, confidence = d.confidence) => ({
    verdict,
    reason,
    detail,
    confidence,
    detected: d.code,
    script: d.script,
    evidence: d.evidence,
  });

  if (!target) return out('uncertain', 'no-locale', `no such locale: ${expected}`);
  if (!String(text ?? '').trim()) return out('uncertain', 'blank', 'no text to judge');
  if (d.script === 'none') {
    return out('uncertain', 'no-evidence', 'no letters — digits, punctuation or symbols only');
  }

  /*
   * Han-only text cannot distinguish Japanese from Chinese, so on any of those locales
   * it is accepted rather than contradicted. This is not a fudge: the script genuinely
   * carries no evidence between them, and the honest options are "accept" or
   * "uncertain". Accept is the right one because the page as a whole has already been
   * checked — a /ja/ page whose other 27 nodes read as Japanese does not become Chinese
   * because one stat label happens to be kanji and digits. The confidence is fixed at
   * 0.5 to say so: the answer is "not contradicted", not "confirmed".
   */
  if (d.hanOnly) {
    if (!HAN_AMBIGUOUS.has(target.code)) {
      return out('uncertain', 'other-language', `Han characters on a ${target.name} page`);
    }
    /*
     * The Simplified/Traditional tie-break is the only thing that can separate the two
     * Chinese locales, so when it fires AND contradicts the expected one, the reviewer
     * needs to see it. Still `uncertain` rather than a failure, because kanji-only
     * Japanese produces the same marks — 国, 会, 学 and 与 are simplified forms and
     * ordinary Japanese kanji at once — which is also why an expected `ja` accepts
     * whatever variant the tie-break named.
     */
    const contradicted = d.code && d.code !== target.code && !KANA_CODES.includes(target.code);
    if (contradicted) {
      return out('uncertain', 'han-variant', `reads as ${locale(d.code).name} on a ${target.name} page`);
    }
    return out(
      'translated',
      'han-only',
      `Han characters only — ${target.name} cannot be told from the other Han-script `
        + 'locales by script alone, so it is not contradicted',
      0.5,
    );
  }
  if (d.script === 'other') {
    return out('uncertain', 'other-script', `neither Latin nor CJK on a ${target.name} page`);
  }
  if (!d.code) {
    return out('uncertain', 'no-evidence', 'no language evidence (proper nouns, numbers or too short)');
  }
  // A conclusive script answer stands at any length; a statistical one needs body.
  if (d.script === 'latin') {
    if (d.tokens < minTokens) return out('uncertain', 'too-short', `only ${d.tokens} token(s)`);
    if (d.confidence < minConfidence) {
      return out('uncertain', 'ambiguous', `ambiguous (${d.code} by ${d.confidence} margin)`);
    }
  }
  if (d.code === target.code) {
    return out('translated', 'expected', `reads as ${target.name}`);
  }
  if (d.code === SOURCE_LOCALE) {
    return out('untranslated', 'still-english', `reads as English on a ${target.name} page`);
  }
  const name = locale(d.code)?.name || d.code;
  return out('uncertain', 'other-language', `reads as ${name}, expected ${target.name}`);
}

/* ----------------------------------------------- numbers: a correct localization that
 * a naive diff calls a defect */

/*
 * The number-format signature each locale is expected to adopt.
 *
 * Lives here rather than in `locales.js` because number comparison is its only consumer
 * and the registry carries layout facts instead (`expansion`). If the registry ever
 * grows `group`/`decimal`, this table moves there and this comment goes with it.
 *
 * A German page writing `176,000` instead of `176.000` has a real localization defect,
 * and a checker that does not know the convention would instead flag the CORRECT
 * `176.000` as an altered figure.
 *
 *      code     group      decimal
 */
const NUMBER_FORMAT_TABLE = [
  ['en', ',', '.'],
  ['de', '.', ','],
  ['fr', ' ', ','],
  ['es', '.', ','],
  ['it', '.', ','],
  ['pt', '.', ','],
  ['pl', ' ', ','],
  ['ja', ',', '.'],
  ['ko', ',', '.'],
  ['zh-cn', ',', '.'],
  ['zh-tw', ',', '.'],
];

export const NUMBER_FORMATS = Object.fromEntries(
  NUMBER_FORMAT_TABLE.map(([code, group, decimal]) => [code, { group, decimal }]),
);

/**
 * Grouped/decimal numbers in a text, normalized to a comparable value.
 *
 * The reason this exists: `176,000+` on the English page and `176.000+` on the German
 * page are THE SAME NUMBER, correctly localized. A content-fidelity check is built to
 * flag exactly that kind of digit-level change as an altered figure, so pointing it at
 * a translated page would fail every well-translated page with a statistic on it.
 * Comparing normalized values instead means the check flags `1.5` vs `15` (a real
 * defect) and stays quiet about `1.5` vs `1,5` (a correct one).
 *
 * @returns {Array<{ raw: string, value: number }>}
 */
export function extractNumbers(text, code = SOURCE_LOCALE) {
  const fmt = NUMBER_FORMATS[locale(code)?.code] || NUMBER_FORMATS[SOURCE_LOCALE];
  const out = [];
  /*
   * Any digit run with optional group/decimal separators, including the two exotic
   * spaces French and Polish group with — U+00A0 NO-BREAK SPACE and U+202F NARROW
   * NO-BREAK SPACE, which is what DA actually stores. Written as escapes rather than
   * literals on purpose: both are invisible in a diff, so a literal one is impossible
   * to review and trivial to delete by accident.
   */
  for (const m of String(text ?? '').matchAll(/\d[\d.,\u00a0\u202f ]*\d|\d/g)) {
    const raw = m[0];
    const groupClass = fmt.group === ' ' ? '\\s\\u00a0\\u202f' : `\\${fmt.group}`;
    const value = Number(raw.replace(new RegExp(`[${groupClass}]`, 'g'), '').replace(fmt.decimal, '.'));
    if (Number.isFinite(value)) out.push({ raw, value });
  }
  return out;
}

/*
 * Small numerals spelled out, 0–12.
 *
 * Every one of these languages has a house style that spells small numbers as words,
 * and translators apply it: an English "one of the ten largest contributors" comes back
 * as "einer der zehn größten Mitwirkenden". That is correct German, and a
 * figure-comparison check that does not know it reports a missing statistic on a
 * correctly translated page — which is worse than useless, because a reviewer who
 * chases one of these learns to skip the rest.
 *
 * Stops at twelve because that is where the convention stops in every one of these
 * languages, and because past it the translator writes digits, which the value
 * comparison already handles. Deliberately NOT a general number-to-words
 * implementation: the long tail (hundreds, compound forms, gendered variants) is where
 * such a table becomes a liability, and it buys nothing here.
 */
export const NUMBER_WORDS = {
  en: ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'],
  de: ['null', 'eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn', 'elf', 'zwölf'],
  fr: ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze'],
  es: ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce'],
  it: ['zero', 'uno', 'due', 'tre', 'quattro', 'cinque', 'sei', 'sette', 'otto', 'nove', 'dieci', 'undici', 'dodici'],
  pt: ['zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze'],
  pl: ['zero', 'jeden', 'dwa', 'trzy', 'cztery', 'pięć', 'sześć', 'siedem', 'osiem', 'dziewięć', 'dziesięć', 'jedenaście', 'dwanaście'],
  ja: ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'],
  ko: ['영', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구', '십', '십일', '십이'],
  'zh-cn': ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'],
  'zh-tw': ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'],
};

/**
 * Is `value` written out as a word somewhere in `text`, in this locale?
 *
 * Returns the word found, or null. Used to tell "the figure is missing" apart from
 * "the figure is spelled out", which are different findings.
 */
export function spelledOut(value, text, code) {
  const words = NUMBER_WORDS[locale(code)?.code];
  if (!words || !Number.isInteger(value) || value < 0 || value >= words.length) return null;
  const word = words[value];
  // Word-boundary match for alphabetic scripts; bare inclusion for CJK, which has no
  // word delimiters for a boundary assertion to anchor against.
  const found = /[\p{Script=Han}\p{Script=Hangul}]/u.test(word)
    ? String(text ?? '').includes(word)
    : new RegExp(`(?<![\\p{L}])${word}(?![\\p{L}])`, 'iu').test(String(text ?? ''));
  return found ? word : null;
}

/* ------------------------------------------------------------------------- typography */

/*
 * Quote conventions.
 *
 * A note, never worse — it is a typographic polish issue, and ranking it with a deleted
 * heading is exactly the kind of severity inflation that gets a report skimmed instead
 * of read.
 *
 * `de`, `fr`, `ja`, `ko` and the Traditional Chinese pattern come from upstream;
 * `es`, `it`, `pt`, `pl` and `zh-cn` are NEW here and unvalidated against real
 * translated pages, so they are the likeliest source of a wrong note. All they can ever
 * produce is a note, which is why adding them was worth the risk.
 */
export const QUOTE_CONVENTIONS = {
  de: { pattern: /[„»].+?["«]/g, expected: '„…" or »…«' },
  fr: { pattern: /«\s.+?\s»/g, expected: '« … » with spaces' },
  es: { pattern: /«.+?»|“.+?”/g, expected: '«…» or “…”' },
  it: { pattern: /«.+?»|“.+?”/g, expected: '«…» or “…”' },
  pt: { pattern: /«.+?»|“.+?”/g, expected: '«…» or “…”' },
  pl: { pattern: /„.+?["”]/g, expected: '„…"' },
  ja: { pattern: /「.+?」/g, expected: '「…」' },
  ko: { pattern: /[“"].+?[”"]/g, expected: '“…”' },
  'zh-cn': { pattern: /“.+?”/g, expected: '“…”' },
  'zh-tw': { pattern: /「.+?」/g, expected: '「…」' },
};

/*
 * The 8-character floor keeps quoted code tokens, attribute values and block names
 * ("columns-10-90") out of a typographic finding: those are supposed to be ASCII and
 * are not prose quotations at all.
 */
const STRAIGHT_QUOTED = /"[^"]{8,}"/g;

/**
 * Straight ASCII quotes where the locale's convention wants typographic ones.
 *
 * Returns null for a locale with no recorded convention — which is "nothing to say",
 * not "clean". `correct > 0` alongside `straight > 0` means the page is INCONSISTENT,
 * which is a stronger note than a page that never used the convention at all.
 */
export function quoteStyleCheck(text, code) {
  const conv = QUOTE_CONVENTIONS[locale(code)?.code];
  if (!conv) return null;
  const raw = String(text ?? '');
  const straight = countMatches(raw, STRAIGHT_QUOTED);
  const correct = countMatches(raw, conv.pattern);
  return {
    expected: conv.expected,
    straight,
    correct,
    inconsistent: straight > 0 && correct > 0,
  };
}
