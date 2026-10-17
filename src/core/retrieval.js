/**
 * Small local retrieval for long prep documents (interview guides, technical
 * notes). Sending a 100k-character guide with every question is slow and
 * costly, so long documents are split into chunks and only the chunks that
 * match the current question are sent. BM25 keyword scoring, no network, no
 * embeddings: fast enough to run on every question.
 */

const STOPWORDS = new Set([
  // French
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'd', 'l', 'et', 'ou', 'a', 'au', 'aux', 'en', 'dans',
  'par', 'pour', 'sur', 'avec', 'sans', 'ce', 'ces', 'cet', 'cette', 'qui', 'que', 'qu', 'quoi', 'dont',
  'il', 'elle', 'ils', 'elles', 'on', 'je', 'j', 'tu', 'nous', 'vous', 'me', 'm', 'te', 't', 'se', 's',
  'mon', 'ma', 'mes', 'ton', 'ta', 'tes', 'son', 'sa', 'ses', 'notre', 'nos', 'votre', 'vos', 'leur',
  'leurs', 'est', 'sont', 'etre', 'ete', 'etait', 'ai', 'as', 'avez', 'avons', 'ont', 'avoir', 'fait',
  'faire', 'plus', 'moins', 'tres', 'bien', 'pas', 'ne', 'n', 'y', 'si', 'mais', 'donc', 'alors', 'comme',
  'tout', 'tous', 'toute', 'toutes', 'aussi', 'peu', 'un', 'peut', 'pouvez', 'est-ce', 'c', 'ca', 'cela',
  'euh', 'bon', 'ok', 'okay', 'oui', 'non', 'quand', 'comment', 'pourquoi', 'quel', 'quelle', 'quels',
  'quelles', 'parlez', 'moi', 'dites', 'aimerais', 'voudrais',
  // English
  'the', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'at', 'by', 'from', 'is', 'are', 'was',
  'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these', 'those', 'you', 'your', 'i', 'me', 'my', 'we',
  'our', 'they', 'their', 'he', 'she', 'what', 'why', 'how', 'when', 'which', 'who', 'do', 'does', 'did',
  'can', 'could', 'would', 'will', 'tell', 'about', 'so', 'just', 'like', 'some', 'any', 'have', 'has',
  // Arabic
  'في', 'من', 'على', 'إلى', 'الى', 'عن', 'مع', 'هذا', 'هذه', 'ذلك', 'التي', 'الذي', 'هو', 'هي', 'أن', 'ان',
  'ما', 'ماذا', 'كيف', 'لماذا', 'هل', 'و', 'أو', 'او', 'لا', 'نعم', 'كان', 'كانت'
]);

// Interview intents rarely share words with the prepared answer
// ("parlez-moi de vous" vs "Ton pitch"), so common phrasings are expanded.
const QUERY_EXPANSIONS = [
  [/(parlez|parle|parliez|parler)\b.*\bde (vous|toi)\b|presentez[ -]vous|presente[ -]toi|vous presenter|votre parcours|tell me about yourself|introduce yourself|walk me through your (background|cv|resume)|قدم نفسك|عرف بنفسك|حدثني عن نفسك/, 'pitch presentation parcours profil version francaise'],
  [/pourquoi (nous|consap|notre (entreprise|cabinet|societe))|why (us|our company|this company)|why do you want/, 'pourquoi nous motivations projet pro consap'],
  [/motivation|motive|motivated|why sap|pourquoi sap/, 'motivations projet pro fil rouge'],
  [/(5|cinq|five) ans|five years|dans quelques annees|where do you see/, 'projet pro evolution carriere'],
  [/defaut|faiblesse|weakness|point faible/, 'defaut faiblesse axe amelioration'],
  [/qualite|strength|point fort|forces/, 'qualites forces points forts'],
  [/challenge|difficulte|difficult|obstacle|conflit|conflict|echec|failure|mistake|erreur/, 'challenge difficulte obstacle star situation'],
  [/questions? (pour|a poser)|any questions|des questions/, 'questions a poser fin entretien'],
  [/salaire|salary|remuneration|gratification/, 'salaire gratification remuneration'],
  [/disponib|availability|start date|commencer quand/, 'disponibilite janvier pfe'],
  [/anglais|english/, 'anglais english'],
  [/hps|hygiene|essaouira|facturation|invoic/, 'hps facturation go-live erp'],
  [/cooperative|freelance|mrp|inventaire|nomenclature/, 'cooperatives freelance inventaire mrp'],
  [/ditralog|power bi|power query|portnet/, 'ditralog power bi tableaux de bord'],
  [/certif|c_ts4fi|c_iee2e|credly/, 'certifications c ts4fi c iee2e']
];

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[ً-ْ]/g, ''); // Arabic diacritics
}

function stem(token) {
  if (/^[؀-ۿ]+$/.test(token)) {
    return token.replace(/^(وال|بال|كال|فال|ال)/, '');
  }
  if (token.length > 4 && /[sx]$/.test(token)) {
    return token.slice(0, -1);
  }
  return token;
}

function tokenize(text) {
  const tokens = normalize(text).match(/[\p{L}\p{N}_/]+/gu) || [];
  const out = [];
  for (const raw of tokens) {
    // Keep SAP codes like s/4hana, c_ts4fi, ck11n intact and also split them.
    const parts = raw.includes('/') || raw.includes('_') ? [raw, ...raw.split(/[/_]/)] : [raw];
    for (const part of parts) {
      if (part.length < 2 || STOPWORDS.has(part)) continue;
      out.push(stem(part));
    }
  }
  return out;
}

function expandQuery(query) {
  const norm = normalize(query);
  const extra = QUERY_EXPANSIONS.filter(([re]) => re.test(norm)).map(([, words]) => words);
  return extra.length ? `${query} ${extra.join(' ')}` : query;
}

// A line that opens a new unit: a question, or a section heading such as
// "ÉTAPE 3" / "Ton pitch" (short, no final full stop).
// Guides often glue a tag to the end of a question line: "…terrain ?Fréquent",
// "…how you overcame it. (exemple 1 : adoption)EN".
const LINE_TAGS = '(fréquent|frequent|piège|piege|important|en|fr|ar)';
const QUESTION_LINE = new RegExp(`([?؟]\\s*${LINE_TAGS}?|\\)\\s*${LINE_TAGS})\\s*$`, 'i');

function isQuestionLine(line) {
  return line.length < 300 && QUESTION_LINE.test(line);
}

function isSectionLine(line) {
  return /^(étape|etape|partie|section|chapitre|step|module)\s+\d+/i.test(line);
}

/**
 * Split a document into retrieval chunks. Each chunk starts at a question or
 * section heading and keeps the current section title as a prefix, so an
 * answer is never separated from the question it answers.
 */
function chunkDocument(text, { maxChars = 1600 } = {}) {
  const lines = String(text || '').split('\n').map((l) => l.trim());
  const chunks = [];
  let section = '';
  let current = [];
  let size = 0;

  const flush = () => {
    const body = current.join('\n').trim();
    if (body.length > 40) {
      chunks.push({ section, text: body });
    }
    current = [];
    size = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) {
      if (current.length) current.push('');
      continue;
    }
    if (isSectionLine(line)) {
      flush();
      // "ÉTAPE 3" is usually followed by its title on the next line.
      const next = lines[i + 1] && lines[i + 1].length < 90 ? lines[i + 1] : '';
      section = next ? `${line} · ${next}` : line;
      if (next) i++;
      continue;
    }
    if (isQuestionLine(line) && size > 0) {
      flush();
    }
    if (size + line.length > maxChars && size > 0) {
      flush();
    }
    current.push(line);
    size += line.length + 1;
  }
  flush();
  return chunks;
}

/** BM25 index over chunks from several documents. */
class ChunkIndex {
  constructor(entries, { k1 = 1.4, b = 0.75 } = {}) {
    this.k1 = k1;
    this.b = b;
    this.entries = entries.map((entry) => {
      const terms = tokenize(`${entry.section || ''} ${entry.text}`);
      const tf = new Map();
      for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1);
      return { ...entry, tf, length: terms.length };
    });
    this.df = new Map();
    for (const e of this.entries) {
      for (const t of e.tf.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
    }
    const total = this.entries.reduce((sum, e) => sum + e.length, 0);
    this.avgLength = this.entries.length ? total / this.entries.length : 0;
  }

  /**
   * Best chunks for a query within a character budget. With neighbors, the
   * chunk following each of the top hits is added too: a hit is often the
   * start of a section ("Ton pitch") whose content continues in the next one.
   */
  search(query, { limit = 6, maxChars = 9000, neighbors = 0 } = {}) {
    const terms = [...new Set(tokenize(expandQuery(query)))];
    if (!terms.length || !this.entries.length) return [];
    const n = this.entries.length;
    const scored = [];
    for (const e of this.entries) {
      let score = 0;
      for (const t of terms) {
        const f = e.tf.get(t);
        if (!f) continue;
        const df = this.df.get(t) || 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += idf * (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * e.length / (this.avgLength || 1)));
      }
      if (score > 0) scored.push({ entry: e, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const picked = [];
    const seen = new Set();
    let used = 0;
    const take = (entry, score) => {
      const key = `${entry.doc}#${entry.seq}`;
      if (seen.has(key) || (used + entry.text.length > maxChars && picked.length)) return;
      seen.add(key);
      picked.push({ ...entry, score });
      used += entry.text.length;
    };
    for (const { entry, score } of scored) {
      if (picked.length >= limit) break;
      take(entry, score);
    }
    if (neighbors > 0) {
      const bySeq = new Map(this.entries.map((e) => [`${e.doc}#${e.seq}`, e]));
      for (const hit of picked.slice(0, neighbors)) {
        const next = bySeq.get(`${hit.doc}#${hit.seq + 1}`);
        if (next) take(next, 0);
      }
    }
    return picked;
  }
}

module.exports = { tokenize, chunkDocument, ChunkIndex, expandQuery };
