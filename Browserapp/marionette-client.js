'use strict';

const net = require('net');

class MarionetteClient {
  constructor(port, host = '127.0.0.1') {
    this.port = Number(port); this.host = host; this.socket = null; this.buffer = Buffer.alloc(0);
    this.nextId = 1; this.pending = new Map(); this.hello = null; this.sessionId = null; this.currentUrl = null;
  }

  async open(timeoutMs = 8000) {
    if (this.socket && !this.socket.destroyed) return this;
    this.hello = new Promise((resolve, reject) => { this.resolveHello = resolve; this.rejectHello = reject; });
    this.socket = net.connect({ host: this.host, port: this.port });
    this.socket.on('data', (chunk) => this.onData(chunk));
    this.socket.on('error', (error) => this.fail(error));
    this.socket.on('close', () => this.fail(new Error('Marionette connection closed')));
    const timer = setTimeout(() => this.rejectHello?.(new Error('Marionette greeting timeout')), timeoutMs);
    await this.hello.finally(() => clearTimeout(timer));
    const session = await this.command('WebDriver:NewSession', { strictFileInteractability: true }, timeoutMs);
    this.sessionId = session?.sessionId || null;
    const current = await this.command('WebDriver:GetCurrentURL', {}, timeoutMs).catch(() => null);
    this.currentUrl = typeof current?.value === 'string' ? current.value : null;
    return this;
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    while (this.buffer.length) {
      const colon = this.buffer.indexOf(58);
      if (colon < 0) return;
      const sizeText = this.buffer.subarray(0, colon).toString('ascii');
      if (!/^\d+$/.test(sizeText)) return this.fail(new Error('Invalid Marionette packet prefix'));
      const size = Number(sizeText); const start = colon + 1;
      if (this.buffer.length < start + size) return;
      const body = this.buffer.subarray(start, start + size).toString('utf8');
      this.buffer = this.buffer.subarray(start + size);
      let message; try { message = JSON.parse(body); } catch (error) { this.fail(error); continue; }
      if (!Array.isArray(message)) { this.resolveHello?.(message); this.resolveHello = null; this.rejectHello = null; continue; }
      if (message[0] !== 1) continue;
      const pending = this.pending.get(message[1]); if (!pending) continue; this.pending.delete(message[1]);
      if (message[2]) pending.reject(new Error(message[2].message || message[2].error || 'Marionette command failed'));
      else pending.resolve(message[3] || {});
    }
  }

  command(name, params = {}, timeoutMs = 8000) {
    if (!this.socket || this.socket.destroyed) return Promise.reject(new Error('Marionette is not connected'));
    const id = this.nextId++; const payload = Buffer.from(JSON.stringify([0, id, name, params]), 'utf8');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`Marionette timeout: ${name}`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.socket.write(Buffer.concat([Buffer.from(String(payload.length) + ':', 'ascii'), payload]));
    });
  }

  execute(script, args = []) {
    return this.command('WebDriver:ExecuteScript', { script, args, newSandbox: true, sandbox: 'default', line: 0, filename: 'aibrowser-sync' });
  }

  async navigate(url) {
    const destination = String(url);
    if (this.currentUrl === destination) return { value: null, skipped: true };
    const result = await this.command('WebDriver:Navigate', { url: destination }, 15000);
    this.currentUrl = destination;
    return result;
  }

  async close() {
    const socket = this.socket; this.socket = null;
    if (socket && !socket.destroyed && this.sessionId) {
      this.socket = socket;
      await this.command('WebDriver:DeleteSession', {}, 1500).catch(() => {});
      this.socket = null;
    }
    try { socket?.destroy(); } catch (_) {}
    this.sessionId = null; this.currentUrl = null;
    this.fail(new Error('Marionette client closed'));
  }

  fail(error) {
    this.rejectHello?.(error); this.resolveHello = null; this.rejectHello = null;
    for (const pending of this.pending.values()) pending.reject(error); this.pending.clear();
  }
}

module.exports = { MarionetteClient };
