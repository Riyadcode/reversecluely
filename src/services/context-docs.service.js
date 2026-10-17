const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../core/logger').createServiceLogger('CONTEXT_DOCS');

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
// Per-document and total caps keep the system prompt within a comfortable
// budget for the flash models while still fitting a multi-page resume.
const MAX_DOC_CHARS = 40000;
const MAX_CONTEXT_CHARS = 60000;

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.text', '.csv', '.json', '.rtf']);
const SUPPORTED_EXTENSIONS = new Set([...TEXT_EXTENSIONS, '.pdf', '.docx']);

class ContextDocsService {
  constructor() {
    this.dir = null;
    this.indexPath = null;
    this.docs = [];
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
    return this.docs.map((doc) => ({
      id: doc.id,
      name: doc.name,
      kind: doc.kind,
      kindLabel: KIND_LABELS[doc.kind] || KIND_LABELS.other,
      enabled: doc.enabled,
      chars: doc.text.length,
      truncated: doc.truncated,
      addedAt: doc.addedAt,
      preview: doc.text.slice(0, 160)
    }));
  }

  async addFile(filePath, kind) {
    const ext = path.extname(filePath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      throw new Error(`Unsupported file type ${ext || '(none)'}. Use PDF, DOCX, TXT or MD.`);
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
    const doc = this.docs.find((d) => d.id === id);
    if (!doc) {
      throw new Error('Document not found');
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
    const before = this.docs.length;
    this.docs = this.docs.filter((d) => d.id !== id);
    if (this.docs.length !== before) {
      this._save();
    }
    return this.list();
  }

  hasEnabledDocuments() {
    return this.docs.some((d) => d.enabled);
  }

  /**
   * Build the block appended to every system instruction. Resumes come first
   * because they matter most for "tell me about yourself"-style questions.
   */
  buildContextBlock() {
    const order = { resume: 0, job: 1, notes: 2, other: 3 };
    const enabled = this.docs
      .filter((d) => d.enabled)
      .sort((a, b) => (order[a.kind] ?? 3) - (order[b.kind] ?? 3));
    if (enabled.length === 0) {
      return '';
    }

    let remaining = MAX_CONTEXT_CHARS;
    const sections = [];
    for (const doc of enabled) {
      if (remaining <= 0) {
        break;
      }
      const body = doc.text.slice(0, remaining);
      remaining -= body.length;
      const label = KIND_LABELS[doc.kind] || KIND_LABELS.other;
      sections.push(`### ${label}: ${doc.name}\n${body}`);
    }

    return `# Candidate background (loaded before the interview)

The candidate prepared the documents below. Use them as the source of truth about the candidate's own experience, projects, skills, education and goals:
- When a question is about the candidate (experience, motivation, strengths, "tell me about yourself", a project on the resume), answer in the first person using these facts.
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
    if (/(note|prep)/.test(lower)) return 'notes';
    return 'other';
  }

  async _extractText(filePath, ext) {
    if (ext === '.pdf') {
      // Require the library entry directly: pdf-parse's index.js runs a debug
      // self-test that reads a bundled sample PDF when it thinks it is the
      // main module, which breaks inside a packaged Electron app.
      const pdfParse = require('pdf-parse/lib/pdf-parse.js');
      const result = await pdfParse(fs.readFileSync(filePath));
      return result.text || '';
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
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, documents: this.docs }, null, 2));
    fs.renameSync(tmp, this.indexPath);
  }
}

module.exports = new ContextDocsService();
module.exports.ContextDocsService = ContextDocsService;
