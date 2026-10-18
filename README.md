# arlclue

A desktop AI interview assistant. arlclue is a fork of [OpenCluely](https://github.com/TechyCSR/OpenCluely) (Apache-2.0) with three additions:

1. **Prep documents.** Load your resume, the job description and your notes before the interview. Every answer uses them, so "tell me about yourself" or "describe a project you led" gets an answer built from your real experience.
2. **Automatic language detection (English, French, Arabic).** Each question's language is detected as it is spoken, and the answer comes back in that language. You can also pin answers to one language.
3. **Hears the interviewer through your earphones.** arlclue can capture the computer's audio output (the call you hear in your earphones) as well as, or instead of, your microphone. It also detects which utterances are questions, so it answers the interviewer's questions rather than everything that is said.

Everything else from OpenCluely is unchanged: the overlay that screen sharing does not capture (macOS/Windows), screenshot analysis with Gemini, local Whisper or Azure speech, session memory and the shortcuts.

## Quick start

```bash
git clone https://github.com/riyadcode/reversecluely.git
cd reversecluely
./setup.sh
```

`setup.sh` installs dependencies, creates `.env`, sets up a local Whisper environment and launches the app. On first launch, paste a Gemini API key from [Google AI Studio](https://aistudio.google.com/) into Settings.

On Windows, run `setup.sh` from Git Bash. macOS has no pre-built download (the app is unsigned), so run it from source.

## Before the interview

Open **Settings** (`Cmd/Ctrl + ,`):

**Built-in documents: the `prep/` folder.** Copy your resume, guides and notes into the `prep/` folder of the app (Settings → **Prep folder** opens it). Every file there is loaded at each start, so arlclue knows it from the first question. The folder is git-ignored, so these files are never committed or pushed. After adding a file while the app is open, click **Reload**.

Short documents (a resume) are sent whole with each question. Long ones (a 100-page interview or technical guide) are searched, and only the passages that match the question are sent, along with the previous question for short follow-ups like "Comment ?". The model knows the whole guide without a huge prompt slowing every answer down.

**Interview Prep Documents**
- **Add resume** picks a PDF, DOCX, HTML, TXT or MD file and files it as your resume.
- **Drag and drop** works too: drop one or more files from Explorer/Finder onto the section.
- **Add documents** adds more files. The type (job description, notes, other) is guessed from the file name and can be changed in the list.
- **Write notes** is for typing notes directly: STAR stories, figures to remember, questions to ask.
- Untick a document to keep it without using it. Documents are stored in the app's data folder (`prep-documents/`). Their text is sent to Gemini with each question.

**Interview Audio & Languages**

| Setting | Options | Use |
|---|---|---|
| Listen to | Microphone + computer audio (default), Computer audio only, Microphone only | With earphones, pick one of the first two so the interviewer is heard |
| Spoken languages | `en,fr,ar` | Detection only considers these, which stops accented French from being read as Spanish |
| Answer language | Same as the question, Always English/French/Arabic | |
| Answer | Questions only (default), Every sentence | "Questions only" ignores small talk and your own answers; they stay in the conversation history as context. Polite requests such as "j'aimerais que vous me parliez de vous" count as questions. If one is missed, click **Answer anyway** under it in the chat |

Then press `Alt + R` to start listening.

### Hearing the interviewer through earphones

| OS | How system audio is captured | Setup |
|---|---|---|
| Windows | Electron loopback capture of the default output | Nothing to install |
| Linux | The default sink's monitor, through `parec` (PulseAudio, or PipeWire's Pulse layer) | `sudo apt install pulseaudio-utils` |
| macOS | A virtual loopback device (Electron 29 has no native system-audio capture on macOS) | `brew install blackhole-2ch`. In *Audio MIDI Setup*, create a **Multi-Output Device** with your earphones and BlackHole, and select it as the output. arlclue finds BlackHole (or Loopback, Soundflower) on its own. |

If system audio is unavailable, arlclue shows a warning in the chat and falls back to the microphone.

"Microphone + computer audio" is meant for earphones. On loudspeakers the microphone also picks up the interviewer, so choose **Computer audio only** there.

### Faster answers

- The answer window sizes itself to the whole answer: it grows to the answer's measured height, widens for long answers, and only shrinks the text (never below 60%) when an answer is taller than the screen. It always opens on the first line; `Alt + ↓` / `Alt + ↑` scroll it if ever needed.

- Answers start with one bold sentence you can say straight away, then a few bullet points for the follow-up "comment ?".
- A fragment that is clearly a question is sent after 0.25 s instead of 0.8 s.
- The Whisper model stays loaded for the whole listening session instead of unloading after a minute of silence.
- Transcription is the slowest step without an NVIDIA GPU. If it lags, set **Whisper Model** to `base`, or use Azure Speech, which transcribes while the interviewer is still speaking.

### How language detection works

- **Whisper:** the persistent worker runs Whisper's language identification, keeps only your spoken languages, and transcribes with the most likely one. With the CLI fallback, the language reported by Whisper is checked against the same list.
- **Azure:** continuous language identification across `en-US`, `fr-FR` and `ar-MA`.
- If the engine reports a language outside the list, a text heuristic decides (Arabic script, French/English function words).
- Each transcript in the chat shows its language (`EN`/`FR`/`AR`) and a `?` when it was detected as a question.
- Arabic answers display right-to-left. Code blocks stay left-to-right.

Keep **Whisper Language** set to `auto` for detection. It switches language from one sentence to the next, and leans towards the language already being spoken when a short phrase is ambiguous. Setting a fixed code (for example `fr`) turns detection off.

If an answer fails, the chat says why (missing or rejected Gemini key, quota, no connection) instead of showing a canned reply.

## Configuration

The settings above are stored in `.env`:

```bash
GEMINI_API_KEY=...
SPEECH_PROVIDER=whisper        # or azure
WHISPER_LANGUAGE=auto          # keep auto for language detection
AUDIO_SOURCE=both              # mic | system | both
SPOKEN_LANGUAGES=en,fr,ar
ANSWER_LANGUAGE=match          # match | en | fr | ar
QUESTION_MODE=questions        # questions | all
```

See `env.example` for every option.

## Keyboard shortcuts

| Action | Shortcut |
|---|---|
| Screenshot and analyze | `Cmd/Ctrl + Shift + S` |
| Start/stop listening | `Alt + R` |
| Show/hide all windows | `Cmd/Ctrl + Shift + V` |
| Toggle click-through | `Cmd/Ctrl + Shift + I` or `Alt + A` |
| Scroll the answer window (no mouse) | `Alt + ↓` / `Alt + ↑` |
| Open chat | `Cmd/Ctrl + Shift + C` |
| Settings | `Cmd/Ctrl + ,` |

## Development

```bash
npm install
npm start      # run the app
npm test       # unit tests for the arlclue additions
```

New code:
- `src/services/context-docs.service.js`: prep document storage, text extraction (pdf-parse, mammoth) and the prompt block
- `src/core/language.js`: language resolution and EN/FR/AR question detection
- `src/services/system-audio.service.js`: Linux monitor capture and the PCM mixer
- `scripts/whisper_worker.py`: language identification restricted to the allowed languages

## Limitations

- Screen-capture invisibility only works on macOS and Windows. Electron has no equivalent on Linux, so the overlay is visible in a Linux screen share.
- HTML files are read as text (scripts, styles and layout are dropped). A page saved from a website that loads its content with JavaScript may contain little text; copy the text into **Write notes** instead.
- Scanned PDFs (images only) contain no text to extract. Export them with OCR first.
- Question detection uses heuristics (question marks, interrogative words, prompts such as "tell me about"). If one is missed, switch **Answer** to "Every sentence" or type the question into the chat.

## Responsible use

Many companies forbid AI assistance during interviews. You are responsible for following the rules of any interview you take.

## License and credits

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Based on [OpenCluely](https://github.com/TechyCSR/OpenCluely) by [TechyCSR](https://techycsr.dev), which was inspired by [Vysper](https://github.com/varun-singhh/Vysper). Uses Google Gemini, OpenAI Whisper, Azure Speech and Electron.
