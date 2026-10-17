/**
 * Spoken-language helpers shared by the speech pipeline and the LLM prompts.
 *
 * Whisper and Azure both report the language they detected; these helpers
 * normalise that report, restrict it to the languages the user expects in the
 * interview, fall back to a text heuristic when no report is available, and
 * decide whether an utterance is a question worth answering.
 */

const LANGUAGE_NAMES = {
  en: 'English',
  fr: 'French',
  ar: 'Arabic'
};

// Azure needs full locales for auto-detection; Whisper uses bare codes.
const AZURE_LOCALES = {
  en: 'en-US',
  fr: 'fr-FR',
  ar: 'ar-MA'
};

const DEFAULT_SPOKEN_LANGUAGES = ['en', 'fr', 'ar'];

function normalizeLanguageCode(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }
  const lower = value.trim().toLowerCase();
  if (!lower) {
    return null;
  }
  const byName = Object.entries(LANGUAGE_NAMES).find(([, name]) => name.toLowerCase() === lower);
  if (byName) {
    return byName[0];
  }
  // "fr-FR", "ar_MA" -> "fr", "ar"
  return lower.split(/[-_]/)[0];
}

/** Parse "en,fr,ar" (or an array) into a de-duplicated list of codes. */
function parseLanguageList(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(/[\s,;]+/);
  const codes = [];
  for (const item of items) {
    const code = normalizeLanguageCode(item);
    if (code && !codes.includes(code)) {
      codes.push(code);
    }
  }
  return codes.length ? codes : [...DEFAULT_SPOKEN_LANGUAGES];
}

function languageName(code) {
  return LANGUAGE_NAMES[code] || (code ? code.toUpperCase() : 'the speaker\'s language');
}

function toAzureLocale(code) {
  return AZURE_LOCALES[code] || null;
}

const FRENCH_MARKERS = /\b(je|tu|vous|nous|est|êtes|suis|avez|avons|pourquoi|comment|quel(le)?s?|qu'est|c'est|les|des|une|dans|pour|avec|votre|vos|notre|parlez|pouvez|expliquez|décrivez|merci|bonjour|oui|non)\b/gi;
const ENGLISH_MARKERS = /\b(the|you|your|are|is|what|why|how|which|tell|can|could|would|have|has|do|does|did|about|with|this|that|please|explain|describe|hello|thanks|yes|no)\b/gi;

/**
 * Best-effort language guess from the transcript itself, used when the speech
 * provider did not report a language (e.g. the Whisper CLI fallback).
 */
function guessLanguageFromText(text, allowed = DEFAULT_SPOKEN_LANGUAGES) {
  const sample = String(text || '');
  if (!sample.trim()) {
    return null;
  }
  const letters = sample.replace(/[^\p{L}]/gu, '');
  const arabic = (sample.match(/[؀-ۿݐ-ݿࢠ-ࣿ]/g) || []).length;
  if (allowed.includes('ar') && letters.length && arabic / letters.length > 0.3) {
    return 'ar';
  }
  const fr = (sample.match(FRENCH_MARKERS) || []).length + (sample.match(/[éèêàçùûôîœ]/gi) || []).length * 0.5;
  const en = (sample.match(ENGLISH_MARKERS) || []).length;
  if (allowed.includes('fr') && fr > en) {
    return 'fr';
  }
  if (allowed.includes('en') && en > 0) {
    return 'en';
  }
  return allowed[0] || null;
}

/**
 * Pick the language for an utterance: trust the provider when its answer is
 * one of the expected languages, otherwise fall back to the text heuristic.
 */
function resolveUtteranceLanguage(reported, text, allowed = DEFAULT_SPOKEN_LANGUAGES) {
  const code = normalizeLanguageCode(reported);
  if (code && allowed.includes(code)) {
    return code;
  }
  return guessLanguageFromText(text, allowed);
}

const QUESTION_STARTERS = {
  en: [
    'what', 'whats', "what's", 'why', 'how', 'when', 'where', 'which', 'who', 'whom', 'whose',
    'can you', 'could you', 'would you', 'will you', 'do you', 'did you', 'have you', 'are you',
    'is there', 'is it', 'should', 'tell me', 'walk me', 'explain', 'describe', 'give me',
    'talk about', 'share', 'imagine', 'suppose', 'let\'s say', 'design', 'implement', 'write',
    'solve', 'compare', 'define', 'list', 'show me'
  ],
  fr: [
    'quoi', 'que ', "qu'", 'quel', 'quelle', 'quels', 'quelles', 'pourquoi', 'comment', 'quand',
    'où', 'ou est', 'combien', 'qui', 'lequel', 'laquelle', 'est-ce', 'est ce', 'pouvez-vous',
    'pouvez vous', 'peux-tu', 'peux tu', 'pourriez-vous', 'pourriez vous', 'avez-vous', 'avez vous',
    'as-tu', 'êtes-vous', 'etes-vous', 'parlez-moi', 'parlez moi', 'parle-moi', 'racontez',
    'expliquez', 'explique', 'décrivez', 'decrivez', 'décris', 'donnez', 'citez', 'présentez',
    'presentez', 'présente-toi', 'imaginez', 'supposons', 'concevez', 'écrivez', 'ecrivez',
    'comparez', 'définissez'
  ],
  ar: [
    'ما ', 'ماذا', 'لماذا', 'ليش', 'علاش', 'كيف', 'كيفاش', 'متى', 'فين', 'أين', 'اين', 'من هو',
    'من هي', 'مين', 'شنو', 'واش', 'هل', 'كم', 'أي ', 'اي ', 'أيّ', 'اشرح', 'إشرح', 'وضح',
    'وضّح', 'صف', 'حدثني', 'حدثنا', 'كلمني', 'عرف', 'عرّف', 'قدم', 'قدّم', 'أعطني', 'اعطني',
    'تكلم', 'احكي', 'قارن', 'اكتب', 'صمم'
  ]
};

// Matched anywhere in the utterance. Interviewers often phrase questions as
// polite requests with no question mark ("j'aimerais que vous me parliez de
// vous", "walk me through your last project"), so those are listed too.
// Apostrophes and hyphens are ignored when matching.
const QUESTION_PHRASES = {
  en: [
    'tell me about', 'tell us about', 'tell me more', 'what do you', 'how would you', 'can you explain',
    'what is your', 'why do you', 'what are your', 'do you have', 'any questions',
    'i would like you to', "i'd like you to", 'i would like to know', "i'd like to know",
    'i would like to hear', "i'd like to hear", 'i want to know', 'i want to hear', "i'm curious",
    'i am curious', 'walk me through', 'walk us through', 'take me through', 'talk me through',
    'talk to me about', 'give me an example', 'give us an example', 'introduce yourself',
    'tell me a bit', 'tell me a little'
  ],
  fr: [
    'parlez-moi', 'parle-moi', 'parlez-nous', 'pouvez-vous', 'pourriez-vous', "qu'est-ce que",
    'est-ce que', 'comment vous', 'pourquoi vous', 'quelles sont', 'quel est', 'avez-vous des questions',
    "j'aimerais que vous", "j'aimerais que tu", "j'aimerais savoir", "j'aimerais connaître",
    "j'aimerais comprendre", "j'aimerais entendre", 'je voudrais que vous', 'je voudrais savoir',
    'je voudrais connaître', 'je voudrais comprendre', 'je souhaiterais', 'dites-moi', 'dis-moi',
    'présentez-vous', 'présente-toi', 'racontez-moi', 'raconte-moi', 'expliquez-moi', 'explique-moi',
    'décrivez-moi', 'me parler de', 'me parliez', 'nous parliez', 'me parles', 'me dire', 'me décrire',
    "m'expliquer", 'me présenter', 'vous présenter', 'donnez-moi un exemple', 'un exemple de',
    'vous pouvez me', 'tu peux me'
  ],
  ar: [
    'حدثني', 'حدثنا', 'كلمني', 'ما هو', 'ما هي', 'ما هيا', 'كيف يمكنك', 'لماذا تريد', 'هل يمكنك',
    'هل لديك', 'ما رأيك', 'أريد أن أعرف', 'اريد ان اعرف', 'أود أن أعرف', 'اود ان اعرف', 'أود أن تحدثني',
    'بغيت نعرف', 'بغيت تعاودلي', 'عاودلي', 'عاود لي', 'قوليا', 'گولي', 'قل لي', 'قدم نفسك', 'قدّم نفسك',
    'عرفني', 'عرّفني', 'عرف بنفسك', 'اشرح لي', 'وضح لي', 'أعطني مثال', 'اعطني مثال', 'عطيني مثال'
  ]
};

// Openers stripped before checking how a sentence starts.
const LEADING_FILLERS = /^((and|but|so|okay|ok|well|right|alright|great|perfect|alors|donc|bon|et|euh|mais|bien|très bien|parfait|d'accord|ok alors|طيب|إذن|اذن|و|ولكن|لكن|زوين|مزيان)\s+)+/;

/** Lowercase and drop apostrophes/hyphens so "j'aimerais", "j aimerais" and "parlez moi" all match. */
function foldForMatch(value) {
  return ` ${String(value).toLowerCase().replace(/['’`\-]/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

/** Prefix match on whole words, so "صف" (describe) does not match "صفحة" (page). */
function startsWithWord(sentence, starter) {
  if (!sentence.startsWith(starter)) {
    return false;
  }
  if (/[\s']$/.test(starter) || sentence.length === starter.length) {
    return true;
  }
  return /[\s\-]/.test(sentence[starter.length]);
}

/**
 * Decide whether an utterance is a question (or an interview prompt phrased
 * as an instruction, like "Tell me about yourself"). Works on EN/FR/AR and
 * does not depend on Whisper emitting a question mark.
 */
function isLikelyQuestion(text, language = null) {
  const raw = String(text || '').trim();
  if (!raw) {
    return false;
  }
  if (/[?？؟]/.test(raw)) {
    return true;
  }

  const lower = raw.toLowerCase().replace(/[’`]/g, "'");
  const words = lower.split(/\s+/).filter(Boolean);
  // Two-word fragments like "okay so" are almost never a real interview question.
  if (words.length < 3) {
    return false;
  }

  const languages = language && QUESTION_STARTERS[language]
    ? [language, ...Object.keys(QUESTION_STARTERS).filter((l) => l !== language)]
    : Object.keys(QUESTION_STARTERS);

  // Check the start of each sentence, since an interviewer often says
  // "Okay, great. So why do you want this job" in a single utterance.
  const sentences = lower.split(/[.!;:,،\n]+/).map((s) => s.trim()).filter(Boolean);
  const folded = foldForMatch(lower);
  for (const lang of languages) {
    for (const sentence of sentences) {
      const startOf = sentence.replace(LEADING_FILLERS, '');
      if (QUESTION_STARTERS[lang].some((starter) => startsWithWord(startOf, starter))) {
        return true;
      }
    }
    // Whole-word match on the folded text, so "me dire" never matches "me direction".
    if (QUESTION_PHRASES[lang].some((phrase) => folded.includes(foldForMatch(phrase)))) {
      return true;
    }
  }
  return false;
}

/**
 * The instruction appended to LLM prompts so the answer comes back in the
 * right language. `answerLanguage` is "match" or a fixed code.
 */
function buildAnswerLanguageInstruction(spokenLanguage, answerLanguage = 'match') {
  const fixed = normalizeLanguageCode(answerLanguage);
  if (fixed && fixed !== 'match') {
    return `## Answer language\nAlways write the answer in ${languageName(fixed)}, whatever language the question was asked in.`;
  }
  if (!spokenLanguage) {
    return '## Answer language\nAnswer in the same language the question was asked in (English, French or Arabic).';
  }
  let extra = '';
  if (spokenLanguage === 'ar') {
    extra = ' Use clear Modern Standard Arabic; keep technical terms, code and identifiers in English/Latin script.';
  } else if (spokenLanguage === 'fr') {
    extra = ' Keep code, identifiers and well-known technical terms in their usual English form.';
  }
  return `## Answer language\nThe question was spoken in ${languageName(spokenLanguage)}. Write the answer in ${languageName(spokenLanguage)} so the candidate can say it aloud directly.${extra}`;
}

module.exports = {
  LANGUAGE_NAMES,
  DEFAULT_SPOKEN_LANGUAGES,
  normalizeLanguageCode,
  parseLanguageList,
  languageName,
  toAzureLocale,
  guessLanguageFromText,
  resolveUtteranceLanguage,
  isLikelyQuestion,
  buildAnswerLanguageInstruction
};
