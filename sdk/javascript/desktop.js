import { DESKTOP_GUEST } from './desktop-guest.js';

const encoder = new TextEncoder();
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const pythonJson = value => `__import__('json').loads(${JSON.stringify(JSON.stringify(value))})`;
const bootstrap = `exec(${JSON.stringify(DESKTOP_GUEST)})\n`;

function decode(result, ErrorType) {
  if (result?.error) {
    const code = /^desktop_[a-z_]+$/.test(result.error.message) ? result.error.message : 'desktop_command_failed';
    throw new ErrorType(code);
  }
  const item = result?.results?.find(value => value.mimeType === 'application/json');
  if (result?.outputTruncated || !item) throw new ErrorType('invalid_desktop_response');
  try { return JSON.parse(item.data); } catch { throw new ErrorType('invalid_desktop_response'); }
}

async function closeContext(context) {
  try { await context.close(); } catch (error) {
    if (error.code !== 'code_context_not_found') {
      error.contextId = context.id; error.cleanupUnconfirmed = true; throw error;
    }
  }
}

function validatePng(bytes, width, height, ErrorType) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  const ending = [0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130];
  if (bytes.length < 45 || signature.some((value, index) => bytes[index] !== value)
    || ending.some((value, index) => bytes[bytes.length - 12 + index] !== value)) throw new ErrorType('invalid_desktop_screenshot');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452
    || view.getUint32(16) !== width || view.getUint32(20) !== height) throw new ErrorType('invalid_desktop_screenshot');
}

// Desktop tools are guest-dependent SDK helpers. They reuse the existing
// generation-fenced interpreter and file APIs, with no new network listener.
export function desktopTools(sandbox, ErrorType) {
  return {
    async probe() {
      const context = await sandbox.code.create();
      try {
        const result = decode(await context.run(bootstrap + 'DesktopGuest.probe()', { timeoutMs: 15_000 }), ErrorType);
        if (typeof result?.supported !== 'boolean' || !result.tools
          || ['Xvfb', 'xdpyinfo', 'xdotool', 'import'].some(name => typeof result.tools[name] !== 'boolean')
          || result.supported !== Object.values(result.tools).every(Boolean)) throw new ErrorType('invalid_desktop_response');
        return result;
      } finally { await closeContext(context); }
    },
    async start({ width = 1280, height = 720 } = {}) {
      if (!Number.isInteger(width) || width < 320 || width > 1920
        || !Number.isInteger(height) || height < 240 || height > 1080) throw new ErrorType('invalid_desktop_options');
      const context = await sandbox.code.create();
      try {
        const info = decode(await context.run(bootstrap + `_mb_desktop = DesktopGuest(${width}, ${height})\n_mb_desktop.info()`, { timeoutMs: 20_000 }), ErrorType);
        if (info?.width !== width || info.height !== height || !/^:[0-9]{1,5}$/.test(info.display)
          || !/^\/tmp\/mainbrella-desktop-[a-z0-9_]{8}$/.test(info.directory)) throw new ErrorType('invalid_desktop_response');
        return new DesktopSession(sandbox, context, info, ErrorType);
      } catch (error) {
        try { await closeContext(context); } catch { error.cleanupUnconfirmed = true; }
        error.contextId = context.id;
        throw error;
      }
    },
  };
}

export class DesktopSession {
  #sandbox; #context; #directory; #ErrorType; #queue = Promise.resolve(); #closed = false; #closing = false;
  constructor(sandbox, context, info, ErrorType) {
    this.#sandbox = sandbox; this.#context = context; this.#directory = info.directory; this.#ErrorType = ErrorType;
    this.contextId = context.id; this.expiresAt = context.expiresAt;
    this.width = info.width; this.height = info.height; this.display = info.display;
  }
  #serialize(operation) {
    const pending = this.#queue.then(operation);
    this.#queue = pending.catch(() => {});
    return pending;
  }
  #check(valid, code) { if (!valid) throw new this.#ErrorType(code); }
  #action(payload) {
    this.#check(!this.#closed && !this.#closing, 'desktop_closed');
    return this.#serialize(() => this.#call(payload));
  }
  async #call(payload) {
    const result = decode(await this.#context.run(`_mb_desktop.call(${pythonJson(payload)})`, { timeoutMs: 15_000 }), this.#ErrorType);
    if (!result || typeof result !== 'object' || Array.isArray(result)
      || payload.action === 'launch' && (!Number.isSafeInteger(result.pid) || result.pid <= 1)
      || !['launch', 'screenshot'].includes(payload.action) && result.ok !== true) throw new this.#ErrorType('invalid_desktop_response');
    return result;
  }
  move(x, y) {
    this.#check(Number.isInteger(x) && x >= 0 && x < this.width && Number.isInteger(y) && y >= 0 && y < this.height, 'invalid_desktop_coordinates');
    return this.#action({ action: 'move', x, y });
  }
  click(button = 1) {
    this.#check(Number.isInteger(button) && button >= 1 && button <= 5, 'invalid_desktop_button');
    return this.#action({ action: 'click', button });
  }
  press(keys) {
    this.#check(typeof keys === 'string' && keys.length <= 128 && /^[A-Za-z0-9_]+(?:\+[A-Za-z0-9_]+)*$/.test(keys), 'invalid_desktop_keys');
    return this.#action({ action: 'press', keys });
  }
  type(text) {
    this.#check(typeof text === 'string' && !text.includes('\0') && encoder.encode(text).length <= 2048, 'invalid_desktop_text');
    return this.#action({ action: 'type', text });
  }
  launch(argv) {
    this.#check(Array.isArray(argv) && argv.length >= 1 && argv.length <= 64 && argv[0]
      && argv.every(arg => typeof arg === 'string' && !arg.includes('\0'))
      && argv.reduce((sum, arg) => sum + encoder.encode(arg).length, 0) <= 2048, 'invalid_desktop_argv');
    return this.#action({ action: 'launch', argv });
  }
  screenshot() {
    this.#check(!this.#closed && !this.#closing, 'desktop_closed');
    return this.#serialize(async () => {
      const path = this.#directory + '/screenshot.png';
      let reader;
      try {
        const result = await this.#call({ action: 'screenshot' });
        this.#check(result.path === path && Number.isSafeInteger(result.size) && result.size >= 45 && result.size <= MAX_SCREENSHOT_BYTES, 'invalid_desktop_screenshot');
        reader = (await this.#sandbox.files.download(path)).getReader();
        const bytes = new Uint8Array(result.size);
        let received = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          this.#check(value instanceof Uint8Array && received + value.byteLength <= bytes.length, 'invalid_desktop_screenshot');
          bytes.set(value, received); received += value.byteLength;
        }
        this.#check(received === bytes.length, 'invalid_desktop_screenshot');
        validatePng(bytes, this.width, this.height, this.#ErrorType);
        return bytes;
      } finally {
        await reader?.cancel().catch(() => {});
        try { await this.#sandbox.files.remove(path); } catch (error) { if (error.code !== 'file_not_found') throw error; }
      }
    });
  }
  close() {
    this.#closing = true;
    return this.#serialize(async () => {
      if (this.#closed) return { closed: true };
      // Try to remove temporary images and stop children gracefully first.
      // Context deletion always follows and confirms process-group cleanup.
      try { await this.#context.run('_mb_desktop.close()', { timeoutMs: 10_000 }); } catch {}
      try { await closeContext(this.#context); }
      catch (error) { error.contextId = this.contextId; error.cleanupUnconfirmed = true; throw error; }
      this.#closed = true;
      return { closed: true };
    });
  }
}
