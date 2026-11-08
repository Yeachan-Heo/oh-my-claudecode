import { describe, it, expect, afterEach } from 'vitest';
import {
  detectThinkKeyword,
  detectUltrathinkKeyword,
  createThinkModeHook,
  isThinkModeActive,
  clearThinkModeState,
} from '../index.js';

/**
 * Word-boundary behaviour for the multilingual think keywords.
 *
 * Split out of index.test.ts, which the added matrix pushed past the 800-line
 * maximum in src/AGENTS.md. The boundary cases are the part that keeps growing
 * -- every new anchored stem, prefix and normalisation form lands here -- so
 * they get their own module rather than continuing to expand the suite that
 * also covers the switcher, the state machine and the hook factory.
 */
describe('think-mode detector - multilingual keyword boundaries', () => {
  afterEach(() => {
    clearThinkModeState('compound-overthink');
    clearThinkModeState('compound-counterthink');
    clearThinkModeState('compound-strapens');
    clearThinkModeState('compound-negative');
  });

  it.each([
    'Can you compensate for the timezone offset?',
    'We need compensation logic in the reducer',
    'What is the expense of this API call?',
    'Please dispense with the boilerplate',
    'Use a dispenser pattern for the factory',
    'The release is in suspense until CI passes',
  ])(
    'should not treat an English word containing a keyword as think: %s',
    (text) => {
      expect(detectThinkKeyword(text)).toBe(false);
    },
  );

  it('should match a Latin keyword that carries a suffix', () => {
    // MULTILINGUAL_KEYWORDS stores stems, and the agglutinative Latin-script
    // languages only ever write them with a suffix attached, so a trailing
    // boundary would stop them matching at all.
    expect(
      detectThinkKeyword('l\u00fctfen bunu d\u00fc\u015f\u00fcn\u00fcn'),
    ).toBe(true);
    expect(detectThinkKeyword('derinlemesine d\u00fc\u015f\u00fcnelim')).toBe(
      true,
    );
    expect(detectThinkKeyword('mieti ja ajattelen t\u00e4t\u00e4')).toBe(true);
    expect(detectThinkKeyword('gondolkodjunk ezen a probl\u00e9m\u00e1n')).toBe(
      true,
    );
    expect(detectThinkKeyword('pensaremos nisso')).toBe(true);
    expect(detectThinkKeyword('das ist nachdenkenswert')).toBe(true);
  });

  it('should match common Latin keywords with attached prefixes', () => {
    expect(detectThinkKeyword('Bitte überdenken Sie diese Architektur')).toBe(
      true,
    );
    expect(detectThinkKeyword('Il faut repenser cette interface')).toBe(true);
    expect(detectThinkKeyword('Devemos repensar isso')).toBe(true);
    expect(detectThinkKeyword('Dobbiamo ripensare questo')).toBe(true);
    expect(detectThinkKeyword('Strapensaci prima di rispondere')).toBe(true);
  });

  it('should match the explicit malpensar verb without matching common adjectives', () => {
    expect(
      detectThinkKeyword('Intenta malpensar un poco antes de responder'),
    ).toBe(true);
    expect(
      detectThinkKeyword('Eres muy malpensado, siempre dudas de todos'),
    ).toBe(false);
    expect(detectThinkKeyword('Qué malpensada eres')).toBe(false);
    expect(detectThinkKeyword('un giornale malpensante')).toBe(false);
    expect(detectThinkKeyword('los malpensados siempre sospechan')).toBe(false);
  });

  it('should match the sobre and contra compounds before an anchored stem', () => {
    expect(detectThinkKeyword('Não sobrepense isso demais')).toBe(true);
    expect(detectThinkKeyword('Intenta contrapensar esta propuesta')).toBe(
      true,
    );
  });

  it('should still match the separated sobre forms, which need no prefix allowance', () => {
    expect(detectThinkKeyword('Pense sobre isso')).toBe(true);
    expect(detectThinkKeyword('Vamos sobre pensar nisso')).toBe(true);
  });

  it('should not let the new prefixes admit ordinary English words', () => {
    expect(detectThinkKeyword('the fruit ripens quickly')).toBe(false);
    expect(detectThinkKeyword('Submit the expense report')).toBe(false);
    expect(detectThinkKeyword('the soap dispenser broke')).toBe(false);
    expect(detectThinkKeyword('offer fair recompense')).toBe(false);
  });

  it('should activate think mode for the compounds through the hook itself', () => {
    // detectThinkKeyword is the matcher; createThinkModeHook is what Claude Code
    // actually calls, so the prefixes are exercised through extractPromptText and
    // the session state rather than against the matcher alone.
    const prompts = [
      { prompt: 'Não sobrepense isso demais', sessionId: 'compound-overthink' },
      {
        prompt: 'Intenta contrapensar esta propuesta',
        sessionId: 'compound-counterthink',
      },
      {
        prompt: 'Strapensaci prima di rispondere',
        sessionId: 'compound-strapens',
      },
    ];
    for (const { prompt, sessionId } of prompts) {
      const hook = createThinkModeHook();
      const state = hook.processChatParams(sessionId, {
        parts: [{ type: 'text', text: prompt }],
        message: {},
      });
      expect(state.requested).toBe(true);
      expect(isThinkModeActive(sessionId)).toBe(true);
    }
  });

  it('should leave think mode inactive through the hook for English collisions', () => {
    const hook = createThinkModeHook();
    const state = hook.processChatParams('compound-negative', {
      parts: [
        {
          type: 'text',
          text: 'Submit the expense report, the fruit ripens quickly',
        },
      ],
      message: {},
    });
    expect(state.requested).toBe(false);
    expect(isThinkModeActive('compound-negative')).toBe(false);
  });

  it('should match finite forms of prefixed Latin keywords', () => {
    expect(detectThinkKeyword('Repense cette interface')).toBe(true);
    expect(detectThinkKeyword('Repiensa esta solución')).toBe(true);
    expect(detectThinkKeyword('Ripensa questa soluzione')).toBe(true);
    expect(detectThinkKeyword('Bitte überdenke das')).toBe(true);
  });

  it('should not fire on accented keywords embedded in a Latin word', () => {
    // Both normalization forms. NFC 'é' is U+00E9 and NFD is 'e' + U+0301, so the
    // two spellings render identically and the pair reads as a duplicate; it is not.
    const text = 'dépenser';
    expect(detectThinkKeyword(text.normalize('NFC'))).toBe(false);
    expect(detectThinkKeyword(text.normalize('NFD'))).toBe(false);
  });

  it('should classify combining overlays by their base grapheme', () => {
    // NFD decomposes U+2260 into '=' plus U+0338. That overlay belongs to a symbol,
    // so it must not make the following think stem look embedded in a word.
    const text = '≠Pense profondément';
    expect(detectThinkKeyword(text)).toBe(true);
    expect(detectThinkKeyword(text.normalize('NFD'))).toBe(true);
  });

  it('should treat non-Latin script transitions as boundaries around anchored stems', () => {
    expect(detectThinkKeyword('请pense一下')).toBe(true);
    expect(detectThinkKeyword('これpensaして')).toBe(true);
    expect(detectThinkKeyword('пpense')).toBe(true);
  });

  it('should keep digit adjacency script-agnostic for anchored stems', () => {
    // The script-transition fix narrowed the predecessor to Latin letters. Digits must
    // stay \p{Nd}: a decimal digit beside a stem is word adjacency in any script, and
    // reusing the English lookbehind verbatim narrowed it to ASCII.
    expect(detectThinkKeyword('3pense')).toBe(false);
    expect(detectThinkKeyword('\u0663pense')).toBe(false);
    expect(detectThinkKeyword('\u0969pense')).toBe(false);
    expect(detectThinkKeyword('\uff13pense')).toBe(false);
    // Number-Letter code points remain list markers, not word characters.
    expect(detectThinkKeyword('\u2170pense')).toBe(true);
  });

  it('should treat every variation selector as decorative, not just U+FE00-U+FE0F', () => {
    // The selectors also live at U+180B-U+180D and U+180F (Mongolian) and
    // U+E0100-U+E01EF (VS17-VS256, used by ideographic variation sequences). All of
    // them are \p{M}, so the narrower range suppressed a visible trigger: 'think' plus
    // U+E0100 or U+180B returned false while 'think\uFE0F' returned true.
    expect(detectThinkKeyword('think\uFE0F')).toBe(true);
    expect(detectThinkKeyword('think\u{E0100}')).toBe(true);
    expect(detectThinkKeyword('think\u180B')).toBe(true);
    expect(detectThinkKeyword('think\u180F')).toBe(true);
    expect(detectUltrathinkKeyword('ultrathink\u{E0100}')).toBe(true);
    expect(detectUltrathinkKeyword('ultrathink\u180B')).toBe(true);
  });

  it('should treat a supplementary variation selector as a leading boundary too', () => {
    expect(detectThinkKeyword('1\u{E0100}think')).toBe(true);
    expect(detectThinkKeyword('1\uFE0F\u20E3think')).toBe(true);
  });

  it('should still block a composing mark after the selector widening', () => {
    // The widening must not reach marks that compose a letter.
    expect(detectThinkKeyword('think\u0301')).toBe(false);
    expect(detectThinkKeyword('thinker')).toBe(false);
    expect(detectThinkKeyword('Je dois dépenser moins'.normalize('NFD'))).toBe(
      false,
    );
  });

  it('should still match a Latin keyword delimited by punctuation', () => {
    expect(detectThinkKeyword('(piensa)')).toBe(true);
    expect(detectThinkKeyword('denken, bitte')).toBe(true);
  });

  it('should match a Norwegian keyword behind a productive prefix', () => {
    // 'gruble' is unanchored, so 'begruble' works without modelling 'be-'.
    expect(detectThinkKeyword('Vi m\u00e5 begruble dette grundig')).toBe(true);
    expect(detectThinkKeyword('vi m\u00e5 gruble over dette')).toBe(true);
  });

  it('should match a German keyword behind any productive prefix', () => {
    // 'denken' occurs inside no English word, so it is not anchored and every
    // prefixed form works without a per-prefix list.
    expect(detectThinkKeyword('Bitte bedenken Sie diese Risiken')).toBe(true);
    expect(detectThinkKeyword('Bitte umdenken und neu entwerfen')).toBe(true);
  });

  it('should reject an English word that embeds an anchored stem', () => {
    // The word-initial Romance-prefix allowance does not reach these: the 're' in
    // "prepense" and "recompense" is not itself at a word start.
    expect(detectThinkKeyword('a prepense plan')).toBe(false);
    expect(detectThinkKeyword('a fair recompense for the work')).toBe(false);
    expect(detectThinkKeyword('the dispensary is closed')).toBe(false);
  });

  it('should match a German keyword behind a prefix, including finite forms', () => {
    // 'denk' is deliberately not anchored. Anchoring it would reject these
    // everyday imperatives to exclude one rare word ("goldenknop"), which is the
    // wrong trade.
    expect(detectThinkKeyword('Bitte bedenke das')).toBe(true);
    expect(detectThinkKeyword('Er bedenkt die Risiken')).toBe(true);
    expect(detectThinkKeyword('Bitte umdenke das')).toBe(true);
  });

  it('should treat the dropped pré- prefix identically in NFC and NFD', () => {
    // The prefix allowance deliberately carries no accented alternative. An accented
    // one is not normalization-safe: 'Prépenser'.normalize('NFD') decomposes é into
    // 'e' + U+0301, so a literal 'pré' alternative stops matching and one prompt
    // would detect in NFC but not in NFD. Dropping it makes the two forms agree,
    // which is what this pins. 'prépenser' is archaic, so rejecting it costs nothing.
    const text = 'Prépenser les cas limites en amont';
    expect(detectThinkKeyword(text)).toBe(false);
    expect(detectThinkKeyword(text.normalize('NFC'))).toBe(false);
    expect(detectThinkKeyword(text.normalize('NFD'))).toBe(false);
  });

  it('should match every conjugated form of surpenser', () => {
    // 'surpens' is listed as a stem, not as the infinitive. Listing the infinitive
    // only matched the forms built on it -- the infinitive itself plus the future
    // and conditional -- and left the present, imperative, participles and imperfect
    // unmatched, because the embedded 'pense'/'penser' stems are anchored and the
    // preceding 'sur' blocks them. The stem covers the paradigm in one entry.
    const accepted = [
      'surpenser', // infinitive
      'surpense', // present 1s/3s, imperative 2s
      'surpenses', // present 2s
      'surpensons', // present 1p, imperative 1p
      'surpensez', // present 2p, imperative 2p
      'surpensent', // present 3p
      'surpens\u00e9', // past participle
      'surpensant', // present participle
      'surpensais', // imperfect 1s
      'surpensait', // imperfect 3s
      'surpensions', // imperfect 1p
      'surpensaient', // imperfect 3p
      'surpensera', // future 3s
      'surpenserait', // conditional 3s
      'surpenseront', // future 3p
    ];
    for (const form of accepted) {
      expect(detectThinkKeyword(`Il faut ${form} cette d\u00e9cision`)).toBe(
        true,
      );
    }
  });

  it('should match the finite surpense in both normalization forms', () => {
    // The review's case. 'surpens' carries no accent, so the stem is byte-identical
    // in NFC and NFD; only the surrounding words decompose.
    const text = 'Surpense cette d\u00e9cision';
    expect(detectThinkKeyword(text)).toBe(true);
    expect(detectThinkKeyword(text.normalize('NFC'))).toBe(true);
    expect(detectThinkKeyword(text.normalize('NFD'))).toBe(true);
    const infinitive = 'Arr\u00eate de surpenser cette d\u00e9cision';
    expect(detectThinkKeyword(infinitive)).toBe(true);
    expect(detectThinkKeyword(infinitive.normalize('NFD'))).toBe(true);
  });

  it('should not let the surpens stem widen the English collisions', () => {
    // The stem is only safe because 'sur' disambiguates it: measured against the
    // system word list, no English word contains 'surpens' anywhere, while 35 contain
    // 'pense'. These are the words the anchor exists for; they stay rejected, in both
    // normalization forms.
    const rejected = [
      'a prepense plan',
      'prepensely odd',
      'the dispensary is closed',
      'a fair recompense for the work',
      'Use a dispenser pattern for the factory',
      'we must compensate for that',
      'his pension fund',
      'd\u00e9penser',
      'compenser',
      'r\u00e9compenser',
    ];
    for (const phrase of rejected) {
      expect(detectThinkKeyword(phrase)).toBe(false);
      expect(detectThinkKeyword(phrase.normalize('NFD'))).toBe(false);
    }
  });

  it('should still reject the words the anchor exists for', () => {
    // English collisions the anchor suppresses.
    expect(detectThinkKeyword('a prepense plan')).toBe(false);
    expect(detectThinkKeyword('prepensely odd')).toBe(false);
    expect(detectThinkKeyword('a fair recompense for the work')).toBe(false);
    // French words that embed a stem but do not mean "think". 'dé' is excluded from
    // the prefix allowance for exactly this reason.
    expect(detectThinkKeyword('d\u00e9penser')).toBe(false);
    expect(detectThinkKeyword('compenser')).toBe(false);
    expect(detectThinkKeyword('r\u00e9compenser')).toBe(false);
  });

  it('should match Romance conjugations behind a re/ri prefix', () => {
    expect(detectThinkKeyword('Devemos repensamos isso')).toBe(true);
    expect(detectThinkKeyword('Repiensa esta solución')).toBe(true);
  });

  it('documents the residual false positives this design accepts', () => {
    // A word start is the only anchor, so an English word that *begins* with a
    // keyword cannot be excluded ('grubless' -> 'gruble', 'pensacola' -> 'pensa'),
    // and 'denk' is left unanchored on purpose ('goldenknop'). Requiring a
    // trailing boundary would break every stem that takes a suffix, which is a
    // far larger regression than these three rare words.
    expect(detectThinkKeyword('a grubless afternoon')).toBe(true);
    expect(detectThinkKeyword('pensacola is a city')).toBe(true);
    expect(detectThinkKeyword('the goldenknop flower')).toBe(true);
    // 'gruble' and 'denk' are not anchored at all: their only English collisions
    // begin with the stem, so an anchor could not exclude them and would only cost
    // the ordinary prefixed forms below.
  });

  it('should treat a non-Latin combining mark as an English word boundary', () => {
    // Script_Extensions=Latin excludes marks belonging to other scripts, so an
    // unspaced prompt keeps triggering on the English keyword.
    expect(
      detectThinkKeyword(
        '\u0915\u0943\u092a\u092f\u093ethink\u0915\u0930\u0947\u0902',
      ),
    ).toBe(true);
    expect(
      detectThinkKeyword(
        '\u0e19\u0e35\u0e48think\u0e43\u0e2b\u0e49\u0e25\u0e36\u0e01\u0e46',
      ),
    ).toBe(true);
    expect(detectThinkKeyword('\u304cthink\u3057\u3066'.normalize('NFD'))).toBe(
      true,
    );
    expect(detectThinkKeyword('\u2764\ufe0fthink')).toBe(true);
  });

  it('should treat a Latin-associated separator or punctuation as a boundary', () => {
    // Script_Extensions=Latin also covers separators and punctuation merely
    // associated with Latin, so these are not word characters even though the
    // property matches them.
    expect(detectThinkKeyword('Please\u202Fthink')).toBe(true);
    expect(detectThinkKeyword('think\u00b7deeply')).toBe(true);
    expect(detectUltrathinkKeyword('Please\u202Fultrathink')).toBe(true);
  });

  it('should treat an NFD non-Latin grapheme as a boundary', () => {
    // Combining marks are Script=Inherited and take their base's script, so NFD
    // 'ά' is alpha + U+0301 and NFD 'й' is и + U+0306. Classifying the mark alone
    // would read it as Latin adjacency and let normalization disable think mode.
    expect(detectThinkKeyword('\u03acthink'.normalize('NFD'))).toBe(true);
    expect(detectThinkKeyword('\u0439think'.normalize('NFD'))).toBe(true);
    // The composed forms behave the same way.
    expect(detectThinkKeyword('\u03acthink')).toBe(true);
    expect(detectThinkKeyword('\u0439think')).toBe(true);
  });

  it('should treat a Latin-script number and an enclosing mark as boundaries', () => {
    // U+2170 is Script=Latin but \p{Nl}, a list marker rather than a letter, so the
    // English adjacency check must look for a Latin *letter*.
    expect(detectThinkKeyword('\u2170think about this')).toBe(true);
    // U+20DD COMBINING ENCLOSING CIRCLE is \p{Me} like the keycap, so a decorated
    // number must not read as word adjacency.
    expect(detectThinkKeyword('1\u20ddthink')).toBe(true);
    expect(detectThinkKeyword('1\u20ddPense')).toBe(true);
  });

  it('should treat an enclosed or letter number as a boundary', () => {
    // A decimal digit beside a stem is word adjacency, but Number-Other and
    // Number-Letter code points are list markers.
    expect(detectThinkKeyword('\u2460Pense profundamente')).toBe(true);
    expect(detectThinkKeyword('\u2170pense')).toBe(true);
    expect(detectThinkKeyword('\u2460think')).toBe(true);
    // A real digit still counts as adjacency.
    expect(detectThinkKeyword('1pense')).toBe(false);
  });

  it('should treat an emoji presentation mark as a boundary', () => {
    // Variation selectors and the enclosing keycap belong to the emoji, not to a
    // letter. Traversing them would find the ASCII '1' inside a keycap, or read
    // U+FE0F itself as a word character before an anchored stem.
    expect(detectThinkKeyword('1\ufe0f\u20e3think about this')).toBe(true);
    expect(detectThinkKeyword('#\ufe0f\u20e3think')).toBe(true);
    expect(detectThinkKeyword('\u2764\ufe0fthink')).toBe(true);
    expect(detectThinkKeyword('\u2764\ufe0fpense profundamente')).toBe(true);
    expect(detectThinkKeyword('\u26a0\ufe0fpenser vite')).toBe(true);
    expect(detectThinkKeyword('think\ufe0f')).toBe(true);
    expect(detectThinkKeyword('think\u20dd')).toBe(true);
    expect(detectUltrathinkKeyword('ultrathink\ufe0f')).toBe(true);
    expect(detectUltrathinkKeyword('ultrathink\u20dd')).toBe(true);
  });

  it('should still treat an adjacent Latin grapheme as a word character', () => {
    // Same shape, Latin base: NFD 'é' is e + U+0301, which is Latin adjacency.
    expect(detectThinkKeyword('e\u0301think')).toBe(false);
    expect(detectThinkKeyword('\u00e9think')).toBe(false);
    // A trailing mark attaches to the final letter, making a different word.
    expect(detectThinkKeyword('think\u0301')).toBe(false);
  });

  it('should still treat an adjacent Latin letter or mark as a word character', () => {
    expect(detectThinkKeyword('rethinking the schema')).toBe(false);
    expect(detectThinkKeyword('e\u0301think')).toBe(false);
    expect(detectThinkKeyword('think2')).toBe(false);
  });

  it('should keep matching keywords that carry an attached clitic or affix', () => {
    // Arabic definite article: ال + تفكير
    expect(detectThinkKeyword('يرجى التفكير بعمق')).toBe(true);
    // Hebrew conjunction: ו + לחשוב
    expect(detectThinkKeyword('ולחשוב על זה')).toBe(true);
    // Russian prefix: об + думать
    expect(detectThinkKeyword('надо обдумать это')).toBe(true);
    // Hindi suffix: सोच + ना
    expect(detectThinkKeyword('इसके बारे में सोचना चाहिए')).toBe(true);
  });
});
