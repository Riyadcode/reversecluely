// Tests for the arlclue additions: prep documents, language detection,
// question detection, audio mixing and the LLM context injection.
// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const language = require('../src/core/language');
const { PcmMixer } = require('../src/services/system-audio.service');
const { ContextDocsService } = require('../src/services/context-docs.service');

const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function pcm(samples) {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => buf.writeInt16LE(v, i * 2));
  return buf;
}

function samplesOf(buf) {
  const out = [];
  for (let i = 0; i < buf.length; i += 2) out.push(buf.readInt16LE(i));
  return out;
}

const FIXTURES = path.join(__dirname, 'fixtures');

test('question detection works in English, French and Arabic', () => {
  const questions = [
    ['Tell me about yourself', 'en'],
    ['Okay great. So why do you want to join us', 'en'],
    ['How would you design a URL shortener', 'en'],
    ['Parlez-moi de votre dernier projet', 'fr'],
    ["Qu'est-ce qui vous motive dans ce poste", 'fr'],
    ['Bon, pourquoi voulez-vous quitter votre entreprise', 'fr'],
    ['حدثني عن نفسك', 'ar'],
    ['ما هي نقاط قوتك', 'ar'],
    ['هل لديك خبرة في جافا', 'ar'],
    ['Is that clear?', 'en']
  ];
  for (const [text, lang] of questions) {
    assert.equal(language.isLikelyQuestion(text, lang), true, text);
  }

  const statements = [
    ['I worked at Capgemini for two years', 'en'],
    ['ok so', 'en'],
    ["J'ai travaillé chez SAP pendant deux ans", 'fr'],
    ['اشتغلت في شركة كبيرة', 'ar'],
    ['صفحة واحدة فقط من فضلك', 'ar']
  ];
  for (const [text, lang] of statements) {
    assert.equal(language.isLikelyQuestion(text, lang), false, text);
  }
});

test('language is restricted to the expected set', () => {
  const allowed = ['en', 'fr', 'ar'];
  assert.equal(language.resolveUtteranceLanguage('fr', 'bonjour', allowed), 'fr');
  // Whisper sometimes reports Spanish for accented French: fall back to text.
  assert.equal(language.resolveUtteranceLanguage('es', 'Pourquoi voulez-vous ce poste', allowed), 'fr');
  assert.equal(language.resolveUtteranceLanguage(null, 'حدثني عن نفسك', allowed), 'ar');
  assert.equal(language.resolveUtteranceLanguage('en-US', 'hello', allowed), 'en');
  assert.deepEqual(language.parseLanguageList(' EN, fr ;ar-MA '), ['en', 'fr', 'ar']);
  assert.deepEqual(language.parseLanguageList(''), ['en', 'fr', 'ar']);
});

test('answer-language instruction follows the speaker or a fixed choice', () => {
  assert.match(language.buildAnswerLanguageInstruction('fr'), /in French/);
  assert.match(language.buildAnswerLanguageInstruction('ar'), /Modern Standard Arabic/);
  assert.match(language.buildAnswerLanguageInstruction('fr', 'en'), /Always write the answer in English/);
  assert.match(language.buildAnswerLanguageInstruction(null), /same language/);
});

test('PcmMixer sums aligned audio and clips', () => {
  const mixer = new PcmMixer(['mic', 'system']);
  const out = [];
  mixer.on('data', (b) => out.push(...samplesOf(b)));
  mixer.push('mic', pcm([1000, 30000, -30000]));
  assert.equal(out.length, 0, 'waits for the second source');
  mixer.push('system', pcm([1000, 30000, -30000]));
  // 0.8 gain per mix: 2000*0.8=1600; 60000*0.8=48000 -> clipped.
  assert.deepEqual(out, [1600, 32767, -32768]);
});

test('PcmMixer passes a live source through when the other stalls', () => {
  const mixer = new PcmMixer(['mic', 'system'], { maxLagMs: 10 });
  const out = [];
  mixer.on('data', (b) => out.push(...samplesOf(b)));
  // 20 ms of system audio, nothing from the mic (e.g. muted / unplugged).
  mixer.push('system', pcm(new Array(320).fill(1000)));
  assert.equal(out.length, 320);
  assert.equal(out[0], 800);
});

test('prep documents: notes, markdown and PDF are stored and injected', async () => {
  const dir = tmpDir('arlclue-docs-');
  const docs = new ContextDocsService();
  docs.init(dir);

  docs.addText('STAR stories', 'Led the migration to SAP S/4HANA, cut close time by 30%.');
  const md = path.join(dir, 'Riyad_CV.md');
  fs.writeFileSync(md, '# Riyad\n\nSAP FI consultant, 3 years.\n');
  await docs.addFile(md);
  // Real PDF (printed by Chromium) so the actual pdf-parse path runs.
  await docs.addFile(path.join(FIXTURES, 'job-description.pdf'));

  const list = docs.list();
  assert.equal(list.length, 3);
  assert.equal(list.find((d) => d.name === 'Riyad_CV.md').kind, 'resume');
  assert.equal(list.find((d) => d.name === 'job-description.pdf').kind, 'job');

  const block = docs.buildContextBlock();
  assert.match(block, /Candidate background/);
  assert.match(block, /Junior SAP consultant in Casablanca/);
  // Resume comes before the job description and notes.
  assert.ok(block.indexOf('Resume / CV') < block.indexOf('Job description'));
  assert.ok(block.indexOf('Job description') < block.indexOf('Prep notes'));

  // Disabled documents are kept but left out of the prompt.
  const notes = list.find((d) => d.kind === 'notes');
  docs.update(notes.id, { enabled: false });
  assert.doesNotMatch(docs.buildContextBlock(), /S\/4HANA/);

  // Persisted across restarts.
  const reloaded = new ContextDocsService();
  reloaded.init(dir);
  assert.equal(reloaded.list().length, 3);
  assert.equal(reloaded.list().find((d) => d.id === notes.id).enabled, false);

  reloaded.remove(notes.id);
  assert.equal(reloaded.list().length, 2);
  await assert.rejects(() => reloaded.addFile(path.join(dir, 'index.json.exe')), /Unsupported file type/);
});

test('LLM requests carry the prep documents and answer language exactly once', () => {
  const contextDocs = require('../src/services/context-docs.service');
  contextDocs.init(tmpDir('arlclue-llm-'));
  contextDocs.addText('Resume', 'Riyad - SAP FI consultant', 'resume');

  const llm = require('../src/services/llm.service');
  const request = { contents: [], systemInstruction: { parts: [{ text: 'skill prompt' }] } };
  llm.applyCandidateContext(request, { spokenLanguage: 'ar' });
  llm.applyCandidateContext(request); // executor call must not duplicate
  assert.equal(request.systemInstruction.parts.length, 2);
  const added = request.systemInstruction.parts[1].text;
  assert.match(added, /Riyad - SAP FI consultant/);
  assert.match(added, /spoken in Arabic/);

  const bare = { contents: [] };
  llm.applyCandidateContext(bare, { text: 'Pourquoi voulez-vous ce poste ?' });
  assert.match(bare.systemInstruction.parts[0].text, /in French/);
});

test('speech service tags transcripts with a restricted language', () => {
  const speech = require('../src/services/speech.service');
  const seen = [];
  const onTranscription = (text, meta) => seen.push({ text, meta });
  speech.on('transcription', onTranscription);
  speech._emitTranscription('Pourquoi voulez-vous ce poste', 'es');
  speech._emitTranscription('حدثني عن نفسك', 'ar');
  speech.removeListener('transcription', onTranscription);

  assert.equal(seen[0].meta.language, 'fr');
  assert.equal(seen[1].meta.language, 'ar');
  assert.equal(speech.getAudioSource(), process.env.AUDIO_SOURCE || 'both');
  speech.shutdown();
});

test('Linux: system audio from the Pulse/PipeWire monitor reaches the pipeline', { skip: process.platform !== 'linux' }, async () => {
  // A fake `parec` that checks it was asked for the default monitor in the
  // pipeline's format, then emits 100 ms of PCM.
  const bin = tmpDir('arlclue-bin-');
  const fake = path.join(bin, 'parec');
  fs.writeFileSync(fake, `#!/bin/sh
case "$*" in *--device=@DEFAULT_MONITOR@*--format=s16le*--rate=16000*--channels=1*) ;; *) echo "bad args: $*" >&2; exit 2;; esac
head -c 3200 /dev/zero
sleep 5
`);
  fs.chmodSync(fake, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  process.env.AUDIO_SOURCE = 'system';

  const speech = require('../src/services/speech.service');
  const received = [];
  const saved = { provider: speech.provider, ingest: speech._ingestWhisperAudio };
  try {
    speech.provider = 'whisper';
    speech.isRecording = true;
    speech._ingestWhisperAudio = (chunk) => received.push(chunk.length);
    speech._startAudioSources();
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.ok(speech.systemAudioCapture, 'system capture started');
    assert.equal(received.reduce((a, b) => a + b, 0), 3200);
  } finally {
    speech.isRecording = false;
    speech._stopAudioSources();
    speech.provider = saved.provider;
    speech._ingestWhisperAudio = saved.ingest;
    process.env.PATH = originalPath;
    delete process.env.AUDIO_SOURCE;
    speech.shutdown();
  }
});
