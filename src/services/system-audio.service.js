const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const logger = require('../core/logger').createServiceLogger('SYSTEM_AUDIO');

// 16 kHz mono 16-bit PCM: 2 bytes/sample, 32 bytes/ms.
const BYTES_PER_MS = 32;

/**
 * Mixes two 16 kHz mono s16le PCM streams (microphone + system audio) into
 * one, so the existing single-stream VAD/Whisper pipeline hears both the
 * candidate and the interviewer.
 *
 * Samples are summed and clipped once both sources have delivered audio for
 * the same span. If one source stalls (device unplugged, nothing playing and
 * the backend stops sending), the other is passed through padded with
 * silence so transcription never waits on a dead source.
 */
class PcmMixer extends EventEmitter {
  constructor(sources, { maxLagMs = 250 } = {}) {
    super();
    this.queues = new Map(sources.map((name) => [name, Buffer.alloc(0)]));
    this.maxLagBytes = maxLagMs * BYTES_PER_MS;
    this.gain = sources.length > 1 ? 0.8 : 1;
  }

  push(source, chunk) {
    if (!this.queues.has(source) || !chunk || !chunk.length) {
      return;
    }
    this.queues.set(source, Buffer.concat([this.queues.get(source), chunk]));
    this._drain();
  }

  flush() {
    this._drain(true);
  }

  _drain(force = false) {
    const lengths = [...this.queues.values()].map((b) => b.length);
    const longest = Math.max(...lengths);
    let span = Math.min(...lengths);
    // A source that has fallen far behind is treated as silent for that span.
    if (force || longest - span > this.maxLagBytes) {
      span = longest;
    }
    span -= span % 2;
    if (span <= 0) {
      return;
    }

    const out = Buffer.alloc(span);
    for (let offset = 0; offset < span; offset += 2) {
      let sum = 0;
      for (const queue of this.queues.values()) {
        if (offset + 1 < queue.length) {
          sum += queue.readInt16LE(offset);
        }
      }
      sum = Math.round(sum * this.gain);
      out.writeInt16LE(Math.max(-32768, Math.min(32767, sum)), offset);
    }
    for (const [name, queue] of this.queues) {
      this.queues.set(name, queue.length > span ? queue.subarray(span) : Buffer.alloc(0));
    }
    this.emit('data', out);
  }
}

/**
 * Captures what the computer is playing (the interviewer's voice in your
 * headphones) on Linux by recording the default sink's monitor source through
 * PulseAudio or PipeWire's Pulse compatibility layer.
 *
 * Windows and macOS capture system audio in the renderer instead (see
 * main-window.js), because Electron's loopback support lives there.
 */
class LinuxSystemAudioCapture extends EventEmitter {
  constructor() {
    super();
    this.child = null;
  }

  static isSupported() {
    if (process.platform !== 'linux') {
      return false;
    }
    return LinuxSystemAudioCapture._findRecorder() !== null;
  }

  static _findRecorder() {
    for (const bin of ['parec', 'parecord']) {
      try {
        const probe = spawnSync('which', [bin], { timeout: 3000 });
        if (probe.status === 0) {
          return bin;
        }
      } catch (_) { /* keep looking */ }
    }
    return null;
  }

  start() {
    const bin = LinuxSystemAudioCapture._findRecorder();
    if (!bin) {
      throw new Error('System audio capture on Linux needs `parec` (sudo apt install pulseaudio-utils). It works with both PulseAudio and PipeWire.');
    }

    const args = [
      '--device=@DEFAULT_MONITOR@',
      '--format=s16le',
      '--rate=16000',
      '--channels=1',
      '--latency-msec=100'
    ];
    if (bin === 'parecord') {
      args.push('--raw');
    }

    this.child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    this.child.stdout.on('data', (chunk) => this.emit('data', chunk));
    this.child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    this.child.on('error', (error) => {
      logger.error('System audio recorder failed to start', { error: error.message });
      this.emit('error', error);
    });
    this.child.on('close', (code, signal) => {
      const expected = signal === 'SIGTERM' || this.child === null;
      this.child = null;
      if (!expected && code !== 0) {
        const message = stderr.trim() || `${bin} exited with code ${code}`;
        logger.error('System audio recorder exited', { code, message });
        this.emit('error', new Error(message));
      }
    });
    logger.info('Linux system audio capture started', { recorder: bin });
  }

  stop() {
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        child.kill('SIGTERM');
      } catch (_) { /* already gone */ }
    }
  }
}

module.exports = { PcmMixer, LinuxSystemAudioCapture, BYTES_PER_MS };
