// A SCPI client for HAROGIC spectrum analyzers (SA / NX / PX series), spoken
// over TCP to the SCPI service built into SAStudio4.
//
// Everything here is about the wire. None of it knows what SoundBase is, so it
// can be tested on its own against driver/fake-harogic.js, and swapping the
// transport would touch only this file.
//
// Two things about HAROGIC's SCPI that shape this client:
//
//   - A *setting* (`FREQ:STAR 470000000`) sends no reply at all, while a
//     *query* (`FREQ:STAR?`) sends exactly one line. So `write()` must not
//     queue a waiter, or every later reply would be matched to the wrong
//     command. `settle()` writes and then queries back, which is also how we
//     learn what the instrument actually accepted.
//   - Trace data comes back as one very long line. The guide's prose says the
//     ASC8 format is comma separated and its own example shows semicolons, so
//     this splits on either.
//
// Reference: HAROGIC Spectrum Analyzer SCPI Application Guide V4.55.64.

import net from 'node:net';

const CONNECT_TIMEOUT_MS = 4_000;
const REPLY_TIMEOUT_MS = 10_000;

/** HAROGIC quotes some replies (`"AUTO"`); the value is what is inside. */
const unquote = (s) => s.replace(/^"(.*)"$/s, '$1');

export class HarogicClient {
  #socket = null;
  #buffered = '';
  #pending = [];

  constructor({ host, port, replyTimeoutMs = REPLY_TIMEOUT_MS }) {
    this.host = host;
    this.port = port;
    this.replyTimeoutMs = replyTimeoutMs;
    /** set by the adapter; called when the transport dies unprompted */
    this.onFatal = null;
  }

  async connect() {
    this.#socket = await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new Error(
            `${this.host}:${this.port} did not accept a connection in ` +
              `${CONNECT_TIMEOUT_MS / 1000}s — check that the analyzer is on ` +
              `the same network and that SCPI is enabled under System > SCPI`
          )
        );
      }, CONNECT_TIMEOUT_MS);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.setNoDelay(true);
        resolve(socket);
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    this.#socket.setEncoding('utf8');
    this.#socket.on('data', (chunk) => this.#consume(chunk));

    // The case that matters is the transport dying while nobody is waiting on
    // it: the analyzer is unplugged or its battery runs out between sweeps.
    // Reject anything in flight, then tell the adapter, so a dead device stops
    // claiming to be healthy.
    const die = (err) => {
      const reason =
        err ?? new Error(`connection to ${this.host}:${this.port} closed`);
      for (const { reject } of this.#pending.splice(0)) reject(reason);
      this.onFatal?.(reason);
    };
    this.#socket.on('error', die);
    this.#socket.on('close', () => die(null));
  }

  #consume(chunk) {
    this.#buffered += chunk;
    let index;
    while ((index = this.#buffered.indexOf('\n')) >= 0) {
      const line = this.#buffered.slice(0, index).trim();
      this.#buffered = this.#buffered.slice(index + 1);
      if (line === '') continue;
      const waiter = this.#pending.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(line);
      }
    }
  }

  #assertOpen() {
    if (!this.#socket || this.#socket.destroyed) {
      throw new Error(`not connected to ${this.host}:${this.port}`);
    }
  }

  /** A setting. Sends no reply, so nothing is awaited. */
  async write(line) {
    this.#assertOpen();
    this.#socket.write(`${line}\n`);
  }

  /** A query. Resolves with the single line that comes back. */
  async query(line) {
    this.#assertOpen();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // drop the waiter, so a late reply is not matched to the next query
        const i = this.#pending.findIndex((p) => p.timer === timer);
        if (i >= 0) this.#pending.splice(i, 1);
        reject(
          new Error(`no reply to "${line}" within ${this.replyTimeoutMs}ms`)
        );
      }, this.replyTimeoutMs);
      this.#pending.push({ resolve, reject, timer });
      this.#socket.write(`${line}\n`);
    });
  }

  /** `FREQ:STAR` + 470000000 -> set it, then report what the unit holds. */
  async settle(command, value) {
    await this.write(`${command} ${value}`);
    return unquote(await this.query(`${command}?`));
  }

  /** As `settle`, for the many parameters that are plain numbers. */
  async settleNumber(command, value) {
    return Number(await this.settle(command, value));
  }

  async number(command) {
    return Number(unquote(await this.query(`${command}?`)));
  }

  /**
   * `*IDN?` -> "HTRA,Hardware,<serial>,A:0_55_89,F:…,M:…".
   *
   * Note that HAROGIC puts a literal "Hardware" where most instruments put a
   * model name, so there is nothing here to tell a PXN-45 from a PXN-90. The
   * adapter measures the tuning range instead of trusting this.
   */
  async identify() {
    const reply = unquote(await this.query('*IDN?'));
    const [manufacturer, model, serial, ...firmware] = reply.split(',');
    return {
      manufacturer: manufacturer?.trim(),
      model: model?.trim(),
      serial: serial?.trim(),
      firmware: firmware.join(',').trim(),
    };
  }

  /** One completed trace, in dBm, ordered from start to stop frequency. */
  async trace() {
    return parseArray(await this.query('TRAC:DATA?'), 'TRAC:DATA?');
  }

  /** The frequency axis, in Hz. Used to check the axis, not to draw it. */
  async frequencies() {
    return parseArray(await this.query('TRAC:X:DATA?'), 'TRAC:X:DATA?');
  }

  close() {
    this.onFatal = null; // a close we asked for is not a fatal error
    for (const { timer } of this.#pending.splice(0)) clearTimeout(timer);
    this.#socket?.destroy();
    this.#socket = null;
  }
}

/**
 * "-9E+01;-8.672E+01;…" or the same with commas -> [-90, -86.72, …]
 *
 * A PXN-45 running 4.55.64 wraps the whole array in one pair of quotes, so the
 * first and last values come out of the split still carrying one. The values
 * are numeric, so dropping every quote character is both the simplest fix and
 * the one that survives whatever a different firmware decides to quote.
 */
function parseArray(reply, what) {
  const parts = reply
    .replace(/"/g, '')
    .split(/[;,]/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (parts.length === 0) throw new Error(`${what} returned no values`);
  const values = parts.map(Number);
  const bad = values.findIndex((v) => !Number.isFinite(v));
  if (bad >= 0) {
    throw new Error(`${what} returned a non-numeric value: "${parts[bad]}"`);
  }
  return values;
}

/**
 * Is there a HAROGIC analyzer at this address? Used by discovery, so it must
 * be quick and must never throw: an address with nothing on it is a normal,
 * empty result, and users type addresses that are wrong.
 */
export async function probe({ host, port }) {
  const client = new HarogicClient({ host, port, replyTimeoutMs: 2_000 });
  try {
    await client.connect();
    const identity = await client.identify();
    return identity.manufacturer ? identity : null;
  } catch {
    return null;
  } finally {
    client.close();
  }
}
