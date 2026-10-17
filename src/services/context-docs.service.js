const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../core/logger').createServiceLogger('CONTEXT_DOCS');
const { chunkDocument, ChunkIndex } = require('../core/retrieval');

/**
 * Interview prep documents (resume, job description, personal notes).
 *
 * Documents are loaded before the interview, converted to plain text once, and
 * stored under the app's user-data folder. Every LLM request then receives the
 * enabled documents as background context, so answers are grounded in the
 * candidate's real experience instead of generic examples.
 *
 * The service has no Electron dependency: main.js calls init() with the
 * storage directory, which keeps it usable from plain Node for testing.
 */

const KINDS = ['resume', 'job', 'notes', 'other'];
const KIND_LABELS = {
  resume: 'Resume / CV',
  job: 'Job description',
  notes: 'Prep notes',
  other: 'Reference document'
};

const MAX_FILE_BYTES = 15 * 1024 * 1024;
// Short documents (a resume, notes) are sent whole with every question. Long
// ones (interview guides, technical notes) are indexed, and only the passages
// relevant to the current question are sent: the model knows all of it
// without a 100k-character prompt slowing every answer down.
const MAX_DOC_CHARS = 400000;
const FULL_DOC_CHARS = 15000;
const MAX_FULL_CHARS = 30000;
const EXCERPT_CHARS = 9000;

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.text', '.csv', '.json', '.rtf']);
const HTML_EXTENSIONS = new Set(['.html', '.htm', '.xhtml']);
const SUPPORTED_EXTENSIONS = new Set([...TEXT_EXTENSIONS, ...HTML_EXTENSIONS, '.pdf', '.docx']);

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  hellip: '…', laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  bull: '•', middot: '·', euro: '€', copy: '©', reg: '®', deg: '°', times: '×',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', aacute: 'á', agrave: 'à', acirc: 'â',
  ccedil: 'ç', icirc: 'î', iuml: 'ï', ocirc: 'ô', ouml: 'ö', ugrave: 'ù', ucirc: 'û',
  uuml: 'ü', oelig: 'œ', Eacute: 'É', Egrave: 'È', Agrave: 'À', Ccedil: 'Ç'
};

/**
 * Plain text from an HTML page (a resume exported as a web page, a saved
 * job posting, notes from an editor). Scripts, styles and markup are
 * dropped; block elements become line breaks so structure survives.
 */
function htmlToText(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(td|th)\b[^>]*>/gi, ' ')
    .replace(/<\/?(p|div|section|article|header|footer|main|aside|nav|h[1-6]|li|tr|table|ul|ol|dl|dt|dd|blockquote|pre|hr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => safeCodePoint(parseInt(hex, 16), m))
    .replace(/&#(\d+);/g, (m, dec) => safeCodePoint(parseInt(dec, 10), m))
    .replace(/&([a-z]+);/gi, (m, name) => (name in NAMED_ENTITIES ? NAMED_ENTITIES[name] : m))
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n');
}

// The PDF parser runs in a worker thread with clean globals. The speech
// service installs a fake browser `window` for the Azure SDK, and pdf.js
// then takes its browser path and fails ("HTMLElement is not defined").
// The library entry is required directly: pdf-parse's index.js runs a debug
// self-test that reads a bundled sample PDF when it thinks it is the main
// module, which breaks inside a packaged Electron app.
const PDF_WORKER_SOURCE = `
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
require(workerData.parser)(fs.readFileSync(workerData.file))
  .then((result) => parentPort.postMessage({ text: result.text || '' }))
  .catch((error) => parentPort.postMessage({ error: error.message || String(error) }));
`;

function extractPdfText(filePath, { timeoutMs = 30000 } = {}) {
  const { Worker } = require('worker_threads');
  // In a packaged app the parser is unpacked next to app.asar (see
  // asarUnpack in package.json) so the worker can load it from disk.
  const parser = require.resolve('pdf-parse/lib/pdf-parse.js')
    .replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  return new Promise((resolve, reject) => {
    const worker = new Worker(PDF_WORKER_SOURCE, { eval: true, workerData: { parser, file: filePath } });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('Reading the PDF took too long'));
    }, timeoutMs);
    const finish = (fn, value) => {
      clearTimeout(timer);
      worker.terminate();
      fn(value);
    };
    worker.once('message', (msg) => (msg.error ? finish(reject, new Error(msg.error)) : finish(resolve, msg.text)));
    worker.once('error', (error) => finish(reject, error));
  });
}

function safeCodePoint(code, fallback) {
  try {
    return String.fromCodePoint(code);
  } catch (_) {
    return fallback;
  }
}

class ContextDocsService {
  constructor() {
    this.dir = null;
    this.indexPath = null;
    this.docs = [];
    // Built-in documents come from the prep folder on every start and are
    // never written to index.json; only their on/off state is remembered.
    this.builtIns = [];
    this.builtInDir = null;
    this.builtInState = {};
    this._chunkIndex = null;
  }

  _allDocs() {
    return [...this.builtIns, ...this.docs];
  }

  _invalidateIndex() {
    this._chunkIndex = null;
  }

  /**
   * Load every supported file of a folder as built-in documents. Used for the
   * app's prep/ folder, so a resume and guides dropped there are known from
   * the first launch without adding them in Settings.
   */
  async loadFolder(folder) {
    this.builtInDir = folder;
    this.builtIns = [];
    this._invalidateIndex();
    if (!folder || !fs.existsSync(folder)) {
      return this.list();
    }
    const files = fs.readdirSync(folder)
      .filter((name) => SUPPORTED_EXTENSIONS.has(path.extname(name).toLowerCase()))
      .filter((name) => !/^readme\./i.test(name))
      .sort();
    for (const name of files) {
      const filePath = path.join(folder, name);
      try {
        if (!fs.statSync(filePath).isFile() || fs.statSync(filePath).size > MAX_FILE_BYTES) continue;
        const text = await this._extractText(filePath, path.extname(name).toLowerCase());
        if (!text.trim()) continue;
        const id = `builtin:${crypto.createHash('sha1').update(name).digest('hex').slice(0, 12)}`;
        const doc = {
          id,
          name,
          kind: this._guessKind(name),
          enabled: this.builtInState[id] !== false,
          builtIn: true,
          addedAt: fs.statSync(filePath).mtime.toISOString(),
          text: '',
          truncated: false
        };
        this._setText(doc, text);
        this.builtIns.push(doc);
      } catch (error) {
        logger.warn('Could not read built-in prep document', { name, error: error.message });
      }
    }
    logger.info('Built-in prep documents loaded', { folder, count: this.builtIns.length });
    return this.list();
  }

  init(storageDir) {
    this.dir = storageDir;
    this.indexPath = path.join(storageDir, 'index.json');
    fs.mkdirSync(storageDir, { recursive: true });
    this._load();
    logger.info('Prep documents loaded', { count: this.docs.length, dir: storageDir });
  }

  getSupportedExtensions() {
    return [...SUPPORTED_EXTENSIONS].map((ext) => ext.slice(1));
  }

  /** Metadata only; the full text stays in the main process. */
  list() {
    return this._allDocs().map((doc) => ({
      id: doc.id,
      name: doc.name,
      kind: doc.kind,
      kindLabel: KIND_LABELS[doc.kind] || KIND_LABELS.other,
      enabled: doc.enabled,
      chars: doc.text.length,
      truncated: doc.truncated,
      builtIn: !!doc.builtIn,
      // Long documents are searched per question instead of sent whole.
      mode: doc.text.length > FULL_DOC_CHARS ? 'excerpts' : 'full',
      addedAt: doc.addedAt,
      preview: doc.text.slice(0, 160)
    }));
  }

  async addFile(filePath, kind) {
    const ext = path.extname(filePath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      throw new Error(`Unsupported file type ${ext || '(none)'}. Use PDF, DOCX, HTML, TXT or MD.`);
    }
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error('File is larger than 15 MB');
    }

    const text = await this._extractText(filePath, ext);
    if (!text.trim()) {
      throw new Error('No readable text found in this file (scanned PDFs need OCR first)');
    }
    return this._addDocument({
      name: path.basename(filePath),
      kind: kind || this._guessKind(path.basename(filePath)),
      text
    });
  }

  addText(name, text, kind = 'notes') {
    const clean = String(text || '').trim();
    if (!clean) {
      throw new Error('Notes are empty');
    }
    return this._addDocument({
      name: String(name || '').trim() || 'Notes',
      kind,
      text: clean
    });
  }

  update(id, changes = {}) {
    const doc = this._allDocs().find((d) => d.id === id);
    if (!doc) {
      throw new Error('Document not found');
    }
    this._invalidateIndex();
    if (doc.builtIn) {
      // Built-ins mirror their file; only switching them off is remembered.
      if (typeof changes.enabled === 'boolean') {
        doc.enabled = changes.enabled;
        this.builtInState[doc.id] = changes.enabled;
        this._save();
      }
      return this.list();
    }
    if (typeof changes.enabled === 'boolean') {
      doc.enabled = changes.enabled;
    }
    if (KINDS.includes(changes.kind)) {
      doc.kind = changes.kind;
    }
    if (typeof changes.name === 'string' && changes.name.trim()) {
      doc.name = changes.name.trim();
    }
    if (typeof changes.text === 'string' && changes.text.trim()) {
      this._setText(doc, changes.text);
    }
    this._save();
    return this.list();
  }

  remove(id) {
    const builtIn = this.builtIns.find((d) => d.id === id);
    if (builtIn) {
      throw new Error(`"${builtIn.name}" comes from the prep folder. Delete it from ${this.builtInDir} to remove it, or untick it.`);
    }
    this._invalidateIndex();
    const before = this.docs.length;
    this.docs = this.docs.filter((d) => d.id !== id);
    if (this.docs.length !== before) {
      this._save();
    }
    return this.list();
  }

  hasEnabledDocuments() {
    return this._allDocs().some((d) => d.enabled);
  }

  _getChunkIndex() {
    if (!this._chunkIndex) {
      const entries = [];
      for (const doc of this._allDocs()) {
        if (!doc.enabled || doc.text.length <= FULL_DOC_CHARS) continue;
        chunkDocument(doc.text).forEach((chunk, seq) => {
          entries.push({ ...chunk, doc: doc.id, docName: doc.name, seq });
        });
      }
      this._chunkIndex = new ChunkIndex(entries);
    }
    return this._chunkIndex;
  }

  /**
   * Build the block appended to every system instruction: short documents in
   * full (resume first), then the passages of long documents that match the
   * question. Without a query only the short documents are included.
   */
  buildContextBlock({ query = '' } = {}) {
    const order = { resume: 0, job: 1, notes: 2, other: 3 };
    const enabled = this._allDocs()
      .filter((d) => d.enabled)
      .sort((a, b) => (order[a.kind] ?? 3) - (order[b.kind] ?? 3));
    if (enabled.length === 0) {
      return '';
    }

    let remaining = MAX_FULL_CHARS;
    const sections = [];
    for (const doc of enabled) {
      if (doc.text.length > FULL_DOC_CHARS || remaining <= 0) {
        continue;
      }
      const body = doc.text.slice(0, remaining);
      remaining -= body.length;
      const label = KIND_LABELS[doc.kind] || KIND_LABELS.other;
      sections.push(`### ${label}: ${doc.name}\n${body}`);
    }

    const hits = String(query || '').trim()
      ? this._getChunkIndex().search(query, { limit: 6, maxChars: EXCERPT_CHARS, neighbors: 2 })
      : [];
    if (hits.length) {
      // Keep each document's passages together and in their original order.
      hits.sort((a, b) => (a.docName === b.docName ? a.seq - b.seq : a.docName.localeCompare(b.docName)));
      const excerpts = hits.map((hit) => {
        const where = hit.section ? `${hit.docName} — ${hit.section}` : hit.docName;
        return `#### ${where}\n${hit.text}`;
      });
      sections.push(`### Relevant passages from the candidate's prep guides\n${excerpts.join('\n\n')}`);
    }

    if (!sections.length) {
      return '';
    }

    return `# Candidate background (loaded before the interview)

The candidate prepared the documents below. Use them as the source of truth about the candidate's own experience, projects, skills, education and goals:
- When a question is about the candidate (experience, motivation, strengths, "tell me about yourself", a project on the resume), answer in the first person using these facts.
- The prep guides are coaching notes written to the candidate ("tu"). When they contain a prepared answer for the question, reuse it closely, in the first person, as the candidate would say it.
- For technical questions, prefer the definitions, accounts and SAP transactions given in the guides.
- Never invent employers, dates, degrees, numbers or projects that are not in these documents. If something is missing, keep the answer general rather than fabricating details.
- Use the job description, when present, to emphasise the most relevant experience.
- Follow any instructions the candidate wrote in their notes.

${sections.join('\n\n')}`;
  }

  _addDocument({ name, kind, text }) {
    const doc = {
      id: crypto.randomUUID(),
      name,
      kind: KINDS.includes(kind) ? kind : 'other',
      enabled: true,
      addedAt: new Date().toISOString(),
      text: '',
      truncated: false
    };
    this._setText(doc, text);
    this.docs.push(doc);
    this._invalidateIndex();
    this._save();
    logger.info('Prep document added', { name: doc.name, kind: doc.kind, chars: doc.text.length });
    return this.list();
  }

  _setText(doc, text) {
    const normalized = String(text)
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    doc.truncated = normalized.length > MAX_DOC_CHARS;
    doc.text = normalized.slice(0, MAX_DOC_CHARS);
  }

  _guessKind(fileName) {
    const lower = fileName.toLowerCase();
    if (/(resume|résumé|cv|curriculum)/.test(lower)) return 'resume';
    if (/(job|offer|offre|poste|description|jd)/.test(lower)) return 'job';
    if (/(note|prep|guide|entretien|interview|antis[eè]che|cheat)/.test(lower)) return 'notes';
    return 'other';
  }

  async _extractText(filePath, ext) {
    if (ext === '.pdf') {
      return extractPdfText(filePath);
    }
    if (HTML_EXTENSIONS.has(ext)) {
      return htmlToText(fs.readFileSync(filePath, 'utf8'));
    }
    if (ext === '.docx') {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value || '';
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    if (ext === '.rtf') {
      return raw
        .replace(/\\par[d]?/g, '\n')
        .replace(/\{\\\*[^}]*\}/g, '')
        .replace(/\\[a-z]+-?\d* ?/gi, '')
        .replace(/[{}]/g, '');
    }
    return raw;
  }

  _load() {
    try {
      if (!fs.existsSync(this.indexPath)) {
        this.docs = [];
        return;
      }
      const parsed = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
      this.docs = Array.isArray(parsed.documents)
        ? parsed.documents.filter((d) => d && d.id && typeof d.text === 'string')
        : [];
      this.builtInState = parsed.builtInState && typeof parsed.builtInState === 'object' ? parsed.builtInState : {};
    } catch (error) {
      logger.error('Failed to read prep documents; starting empty', { error: error.message });
      this.docs = [];
    }
  }

  _save() {
    if (!this.indexPath) {
      return;
    }
    const tmp = `${this.indexPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, documents: this.docs, builtInState: this.builtInState }, null, 2));
    fs.renameSync(tmp, this.indexPath);
  }
}

module.exports = new ContextDocsService();
module.exports.ContextDocsService = ContextDocsService;
module.exports.htmlToText = htmlToText;
