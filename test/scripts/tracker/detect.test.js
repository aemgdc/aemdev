import { expect } from '@esm-bundle/chai';
import { ALL_LOCALES } from '../../../scripts/tracker/locales.js';
import { TRANSLATION_STATUSES } from '../../../scripts/tracker/stages.js';
import {
  DETECTABLE_LANGS,
  FUNCTION_WORDS,
  NUMBER_FORMATS,
  NUMBER_WORDS,
  UNPROFILED_LOCALES,
  WORD_WEIGHTS,
  detectLanguage,
  evidence,
  extractNumbers,
  hanVariant,
  quoteStyleCheck,
  scriptCounts,
  spelledOut,
  translationVerdict,
} from '../../../scripts/tracker/detect.js';

/*
 * Real paragraphs, not single words. The whole point of the detector is that it works
 * on the text a page actually carries, and a fixture of one word would pass a detector
 * that cannot do the job — it is short strings that are hard, and they get their own
 * cases below.
 *
 * Every fixture says roughly the same thing in a different language, so a fixture that
 * scores as the wrong language is a scoring problem and not a content difference.
 */
const TEXT = {
  en: 'The tracker follows every page from the moment it is catalogued to the moment it goes live in all ten locales. It does not store a stage; it derives one from what the crawl observed, so a page that was withdrawn from preview stops claiming to be finished. That is the whole reason the model lives in one module instead of in each of the boards that read it.',
  de: 'Der Tracker begleitet jede Seite von der Aufnahme bis zur Veröffentlichung in allen zehn Sprachen. Er speichert keine Stufe, sondern leitet sie aus den beobachteten Daten ab: eine Seite, die aus der Vorschau entfernt wurde, gilt damit nicht länger als fertig. Genau deshalb liegt das Modell in einem einzigen Modul und nicht in jeder Ansicht.',
  fr: "Le tracker suit chaque page depuis son inscription jusqu'à sa publication dans les dix langues. Il n'enregistre pas d'étape : il la déduit de ce que l'exploration a observé, de sorte qu'une page retirée de l'aperçu cesse de se déclarer terminée. C'est la raison pour laquelle le modèle vit dans un seul module et non dans chaque tableau.",
  es: 'El rastreador sigue cada página desde su registro hasta su publicación en los diez idiomas. No almacena una etapa, sino que la deduce de lo que ha observado el rastreo, de modo que una página retirada de la vista previa deja de declararse terminada. Por eso el modelo vive en un único módulo y no en cada tablero.',
  it: 'Il tracker segue ogni pagina dal momento in cui viene registrata fino alla pubblicazione in tutte le dieci lingue. Non memorizza uno stato, ma lo deduce da ciò che la scansione ha osservato, così una pagina ritirata dall anteprima non può più dichiararsi conclusa. Per questo il modello vive in un solo modulo e non in ogni tabella.',
  pt: 'O rastreador acompanha cada página desde o momento em que é registada até à publicação nos dez idiomas. Não armazena uma etapa, mas deduz-na a partir do que a análise observou, de modo que uma página retirada da pré-visualização deixa de se declarar concluída. É por isso que o modelo vive num único módulo.',
  pl: 'Narzędzie śledzi każdą stronę od momentu jej dodania aż do publikacji we wszystkich dziesięciu językach. Nie przechowuje etapu, lecz wyprowadza go z tego, co zaobserwował skan, więc strona wycofana z podglądu przestaje twierdzić, że jest gotowa. Właśnie dlatego model żyje w jednym module, a nie w każdym widoku.',
  ja: 'このトラッカーは、すべてのページを登録の時点から十の言語で公開される時点まで追跡します。段階を保存するのではなく、クロールが観測した事実から導き出すため、プレビューから取り下げられたページは完了と主張しなくなります。',
  ko: '이 트래커는 모든 페이지를 등록 시점부터 열 개 언어로 공개되는 시점까지 추적합니다. 단계를 저장하지 않고 크롤이 관찰한 사실에서 도출하기 때문에, 미리 보기에서 내려간 페이지는 더 이상 완료되었다고 주장하지 않습니다.',
  'zh-cn': '该跟踪器会记录每个页面，从收录的那一刻直到在十种语言中上线。它不存储阶段，而是根据抓取观察到的结果推导出来，因此从预览中撤下的页面不会再声称自己已经完成。',
  'zh-tw': '該追蹤器會記錄每個頁面，從收錄的那一刻直到在十種語言中上線。它不儲存階段，而是根據抓取觀察到的結果推導出來，因此從預覽中撤下的頁面不會再聲稱自己已經完成。',
};

/** Nothing but German function words — the word scorer's strongest possible signal. */
const GERMAN_WORDS = 'Der die das und ist nicht mit für von den dem des ein eine';

/** Product and block names. Identical in every locale by design, so language-free. */
const NAMES_ONLY = 'Adobe Experience Manager Document Authoring adaptTo 2026 GitHub';

describe('detect.js', () => {
  describe('the script gate', () => {
    it('settles a CJK page before any word scoring can weigh in', () => {
      // The words alone are as German as text gets...
      expect(detectLanguage(GERMAN_WORDS).code).to.equal('de');
      // ...and a page of kana and kanji is still not German.
      const mixed = `${TEXT.ja} ${GERMAN_WORDS}`;
      const d = detectLanguage(mixed);
      expect(d.code).to.equal('ja');
      expect(d.script).to.equal('kana');
    });

    it('reads Korean off hangul and Japanese off kana', () => {
      expect(detectLanguage(TEXT.ko).code).to.equal('ko');
      expect(detectLanguage(TEXT.ko).script).to.equal('hangul');
      expect(detectLanguage(TEXT.ja).script).to.equal('kana');
    });

    it('does not let a couple of Han characters make an English page Chinese', () => {
      const text = 'The report covers the 日本 market and the ten locales we publish into.';
      expect(detectLanguage(text).code).to.equal('en');
    });

    it('tells Simplified from Traditional, and abstains when nothing says', () => {
      expect(hanVariant(TEXT['zh-cn'])).to.equal('zh-cn');
      expect(hanVariant(TEXT['zh-tw'])).to.equal('zh-tw');
      // A stat label has no variant-bearing character in it. Abstaining is the answer.
      expect(hanVariant('165支店')).to.equal(null);
    });

    it('flags Han text as hanOnly even when it names a variant', () => {
      // Japanese without kana is Han and nothing else, so the answer is never closed.
      const d = detectLanguage(TEXT['zh-cn']);
      expect(d.script).to.equal('han');
      expect(d.hanOnly).to.be.true;
    });

    it('counts every script it knows about', () => {
      const counts = scriptCounts(`${TEXT.ja} ${GERMAN_WORDS}`);
      expect(counts.kana).to.be.greaterThan(0);
      expect(counts.han).to.be.greaterThan(0);
      expect(counts.latin).to.be.greaterThan(0);
      expect(counts.hangul).to.equal(0);
      expect(counts.cjk).to.equal(counts.kana + counts.han + counts.hangul);
    });

    it('reports a script no tracked locale uses rather than scoring it', () => {
      const d = detectLanguage('Это совершенно другой алфавит и другой язык целиком.');
      expect(d.script).to.equal('other');
      expect(d.code).to.equal(null);
    });
  });

  describe('word scoring', () => {
    it('reads a real English paragraph as English', () => {
      const d = detectLanguage(TEXT.en);
      expect(d.code).to.equal('en');
      expect(d.script).to.equal('latin');
      expect(d.confidence).to.be.greaterThan(0.5);
    });

    it('reads a real German paragraph as German', () => {
      const d = detectLanguage(TEXT.de);
      expect(d.code).to.equal('de');
      expect(d.confidence).to.be.greaterThan(0.5);
    });

    DETECTABLE_LANGS.forEach((code) => {
      it(`reads its own ${code} paragraph as ${code}`, () => {
        expect(detectLanguage(TEXT[code]).code).to.equal(code);
      });
    });

    it('prices a word by how many languages share it', () => {
      // `und` is German's alone, so it is worth a whole point.
      const withUnd = DETECTABLE_LANGS.filter((l) => FUNCTION_WORDS[l].includes('und'));
      expect(withUnd).to.deep.equal(['de']);
      expect(WORD_WEIGHTS.de.get('und')).to.equal(1);

      // `de` is shared by several Romance languages, so it is worth 1/that many.
      const withDe = DETECTABLE_LANGS.filter((l) => FUNCTION_WORDS[l].includes('de'));
      expect(withDe.length).to.be.greaterThan(1);
      expect(WORD_WEIGHTS.fr.get('de')).to.equal(1 / withDe.length);
    });

    it('keeps English `a` unshared, so short English strings stay detectable', () => {
      expect(WORD_WEIGHTS.en.get('a')).to.equal(1);
    });

    it('has a profile for every Latin-script locale in the registry', () => {
      // A registry locale with no profile would score zero for ever, and every page in
      // it would read as English.
      expect(UNPROFILED_LOCALES).to.deep.equal([]);
    });
  });

  describe('the evidence guard', () => {
    it('finds no evidence in a string of product names', () => {
      expect(evidence(NAMES_ONLY).total).to.equal(0);
      const d = detectLanguage(NAMES_ONLY);
      expect(d.code).to.equal(null);
      expect(d.evidence).to.equal(0);
    });

    it('never turns a product-name cell into a finding', () => {
      const v = translationVerdict({ text: NAMES_ONLY, expected: 'de' });
      expect(v.verdict).to.equal('uncertain');
      expect(v.reason).to.equal('no-evidence');
    });

    it('counts orthography as evidence, not just function words', () => {
      // Polish announces itself with diacritics rather than with listed function words.
      expect(evidence(TEXT.pl).marks).to.be.greaterThan(0);
    });
  });

  describe('confidence', () => {
    const all = { ...TEXT, GERMAN_WORDS, NAMES_ONLY, blank: '   ' };

    Object.entries(all).forEach(([name, text]) => {
      it(`stays within 0..1 on ${name}`, () => {
        const d = detectLanguage(text);
        expect(d.confidence).to.be.at.least(0);
        expect(d.confidence).to.be.at.most(1);
        const v = translationVerdict({ text, expected: 'de' });
        expect(v.confidence).to.be.at.least(0);
        expect(v.confidence).to.be.at.most(1);
      });
    });

    it('is weaker on a two-word string than on a paragraph of the same language', () => {
      // Margin alone would call both certain; strength is what separates them.
      expect(detectLanguage('Der Bericht').confidence)
        .to.be.below(detectLanguage(TEXT.de).confidence);
    });
  });

  describe('translationVerdict', () => {
    it('calls a still-English page under an expected de untranslated', () => {
      const v = translationVerdict({ text: TEXT.en, expected: 'de' });
      expect(v.verdict).to.equal('untranslated');
      expect(v.reason).to.equal('still-english');
      expect(v.detected).to.equal('en');
    });

    it('accepts a real German page under an expected de', () => {
      const v = translationVerdict({ text: TEXT.de, expected: 'de' });
      expect(v.verdict).to.equal('translated');
      expect(v.detected).to.equal('de');
    });

    it('is uncertain on empty and whitespace input, and never throws', () => {
      expect(() => translationVerdict({ text: '', expected: 'de' })).to.not.throw();
      expect(translationVerdict({ text: '', expected: 'de' }).verdict).to.equal('uncertain');
      expect(translationVerdict({ text: '   \n\t ', expected: 'de' }).verdict).to.equal('uncertain');
      expect(translationVerdict({ text: null, expected: 'de' }).verdict).to.equal('uncertain');
      expect(translationVerdict().verdict).to.equal('uncertain');
      expect(() => detectLanguage(undefined)).to.not.throw();
      expect(detectLanguage(undefined).code).to.equal(null);
    });

    it('refuses to judge a string too short to carry a margin', () => {
      const v = translationVerdict({ text: 'Der Bericht', expected: 'de' });
      expect(v.verdict).to.equal('uncertain');
      expect(v.reason).to.equal('too-short');
    });

    it('sends a third language to a human instead of calling it untranslated', () => {
      // Portuguese and Spanish share too much for this to be a safe failure.
      const v = translationVerdict({ text: TEXT.pt, expected: 'es' });
      expect(v.verdict).to.equal('uncertain');
      expect(v.reason).to.equal('other-language');
      expect(v.detected).to.equal('pt');
    });

    it('does not contradict Han-only text on a Han-script or Japanese locale', () => {
      expect(translationVerdict({ text: '従業員数 4,000 人', expected: 'ja' }).verdict)
        .to.equal('translated');
      expect(translationVerdict({ text: TEXT['zh-cn'], expected: 'zh-cn' }).verdict)
        .to.equal('translated');
    });

    it('surfaces Simplified text on a Traditional page for a human', () => {
      const v = translationVerdict({ text: TEXT['zh-cn'], expected: 'zh-tw' });
      expect(v.verdict).to.equal('uncertain');
      expect(v.reason).to.equal('han-variant');
    });

    it('flags CJK text on a Latin locale', () => {
      const v = translationVerdict({ text: TEXT['zh-tw'], expected: 'de' });
      expect(v.verdict).to.equal('uncertain');
      expect(v.reason).to.equal('other-language');
    });

    it('says so when the expected locale is not a locale', () => {
      const v = translationVerdict({ text: TEXT.de, expected: 'xx' });
      expect(v.verdict).to.equal('uncertain');
      expect(v.reason).to.equal('no-locale');
    });
  });

  describe('numbers', () => {
    it('reads a grouped figure in the locale that wrote it', () => {
      expect(extractNumbers('176.000+ Seiten', 'de')[0].value).to.equal(176000);
      expect(extractNumbers('176,000+ pages')[0].value).to.equal(176000);
      expect(extractNumbers('1,5 Prozent', 'de')[0].value).to.equal(1.5);
      expect(extractNumbers('1.5 percent')[0].value).to.equal(1.5);
    });

    it('handles the no-break spaces French and Polish group with', () => {
      expect(extractNumbers('12\u00a0345,6', 'pl')[0].value).to.equal(12345.6);
      expect(extractNumbers('12\u202f345,6', 'fr')[0].value).to.equal(12345.6);
    });

    it('tells a spelled-out figure from a missing one', () => {
      expect(spelledOut(10, 'einer der zehn größten Beiträge', 'de')).to.equal('zehn');
      expect(spelledOut(3, '三つの言語で公開', 'ja')).to.equal('三');
      // The English word on a German page is not the German spelling of the figure.
      expect(spelledOut(10, 'ten of them', 'de')).to.equal(null);
      expect(spelledOut(13, 'dreizehn', 'de')).to.equal(null);
    });

    it('knows a format and a numeral list for every registry locale', () => {
      ALL_LOCALES.forEach((code) => {
        expect(NUMBER_FORMATS[code], code).to.be.an('object');
        expect(NUMBER_WORDS[code], code).to.have.lengthOf(13);
      });
    });
  });

  describe('quote conventions', () => {
    it('counts straight quotes against the locale convention', () => {
      const text = 'Er sagte „das stimmt" und dann "this is a long straight quote".';
      const q = quoteStyleCheck(text, 'de');
      expect(q.straight).to.equal(1);
      expect(q.correct).to.equal(1);
      expect(q.inconsistent).to.be.true;
    });

    it('says nothing about a locale with no recorded convention', () => {
      expect(quoteStyleCheck('anything at all', 'en')).to.equal(null);
    });
  });

  describe('the verdict vocabulary stays spellable by the status model', () => {
    /*
     * DRIFT GUARD. `detect.js` deliberately imports only `locales.js` — coupling the
     * detector to the status model would mean a change to the funnel could change what
     * counts as evidence of a language. The price of that independence is one shared
     * STRING: an `untranslated` verdict is written straight into the
     * `translation-status` column, so if `stages.js` ever renames that value the
     * pipeline would write a status nothing recognises and the pair would classify at
     * `previewed` with an "unknown translation-status" warning instead of landing in
     * the retranslate queue. Asserted from the enum rather than restated, so the rename
     * fails here rather than in production.
     */
    it('emits an untranslated verdict that stages.js can store', () => {
      const stored = TRANSLATION_STATUSES.map((s) => s.value);
      const v = translationVerdict({
        text: 'The community meetup is open to everyone who wants to attend and learn '
          + 'about the platform, and we would love to see you there this year.',
        expected: 'de',
      });
      expect(v.verdict).to.equal('untranslated');
      expect(stored).to.contain(v.verdict);
      // And the queue it implies is the one a reviewer is actually shown.
      expect(TRANSLATION_STATUSES.find((s) => s.value === v.verdict).queue).to.equal('retranslate');
    });

    it('keeps its other two verdicts OUT of the stored vocabulary', () => {
      // `translated` and `uncertain` are the detector's own words, not statuses. If one
      // ever collided with a stored value, a verdict would silently become a status.
      const stored = TRANSLATION_STATUSES.map((s) => s.value);
      expect(stored).to.not.contain('translated');
      expect(stored).to.not.contain('uncertain');
    });
  });
});
