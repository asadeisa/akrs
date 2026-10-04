// A minimal CDP client. The transport contract is { send(text), onMessage(handler), onClose(handler), close() }; the
// client correlates ids, delivers events and bounds every wait. It never touches a process or a file.
import { Buffer } from 'node:buffer';

export class CdpError extends Error {
  constructor(message, code, method) {
    super(`${method}: ${message}`);
    this.name = 'CdpError';
    this.code = code;
    this.method = method;
  }
}

export class CdpTimeoutError extends Error {
  constructor(method, ms) {
    super(`${method}: no answer within ${ms} ms`);
    this.name = 'CdpTimeoutError';
    this.method = method;
  }
}

const defaultSchedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

export class CdpConnection {
  // options: { timeoutMs, schedule(fn, ms) -> cancel }
  constructor(transport, { timeoutMs = 30000, schedule = defaultSchedule } = {}) {
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this.schedule = schedule;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    transport.onMessage((text) => this.#receive(text));
    transport.onClose(() => this.#closed());
  }

  #receive(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message === null || typeof message !== 'object') return;
    if (typeof message.id === 'number') {
      const call = this.pending.get(message.id);
      if (call === undefined) return;
      this.pending.delete(message.id);
      call.cancel();
      if (message.error !== undefined) call.reject(new CdpError(message.error.message ?? 'protocol error', message.error.code ?? null, call.method));
      else call.resolve(message.result ?? {});
    } else if (typeof message.method === 'string') {
      for (const listener of [...this.listeners]) listener({ method: message.method, params: message.params ?? {}, sessionId: message.sessionId });
    }
  }

  #closed() {
    this.closed = true;
    for (const [id, call] of this.pending) {
      this.pending.delete(id);
      call.cancel();
      call.reject(new Error(`${call.method}: the browser connection closed`));
    }
  }

  send(method, params = {}, { sessionId, timeoutMs = this.timeoutMs } = {}) {
    if (this.closed) return Promise.reject(new Error(`${method}: the browser connection is closed`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const cancel = this.schedule(() => {
        this.pending.delete(id);
        reject(new CdpTimeoutError(method, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, cancel, method });
      try {
        this.transport.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
      } catch (error) {
        this.pending.delete(id);
        cancel();
        reject(error);
      }
    });
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  waitForEvent(predicate, timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      const stop = () => {
        cancel();
        off();
      };
      const cancel = this.schedule(() => {
        off();
        reject(new CdpTimeoutError('event', timeoutMs));
      }, timeoutMs);
      const off = this.onEvent((event) => {
        if (predicate(event)) {
          stop();
          resolve(event);
        }
      });
    });
  }

  close() {
    this.transport.close();
  }
}

// --remote-debugging-pipe: NUL-delimited UTF-8 JSON. `write` is the stream the browser reads (its fd 3), `read` the one it writes (fd 4).
export function pipeTransport({ write, read }) {
  let onMessage = () => {};
  let onClose = () => {};
  let buffered = Buffer.alloc(0);
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    onClose();
  };
  read.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    for (let end = buffered.indexOf(0); end !== -1; end = buffered.indexOf(0)) {
      const frame = buffered.subarray(0, end).toString('utf8');
      buffered = buffered.subarray(end + 1);
      if (frame !== '') onMessage(frame);
    }
  });
  read.on('end', finish);
  read.on('close', finish);
  read.on('error', finish);
  write.on('error', () => {});
  return {
    send(text) {
      write.write(`${text}\0`);
    },
    onMessage(handler) {
      onMessage = handler;
    },
    onClose(handler) {
      onClose = handler;
    },
    close() {
      try {
        write.end();
      } catch {
        // already closed
      }
      read.destroy();
      finish();
    },
  };
}

// The built-in WebSocket (Node >= 22.4): the port-mode transport. `socket` is a connected-or-connecting WebSocket.
export function webSocketTransport(socket) {
  let onMessage = () => {};
  let onClose = () => {};
  socket.addEventListener('message', (event) => onMessage(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8')));
  socket.addEventListener('close', () => onClose());
  socket.addEventListener('error', () => onClose());
  return {
    send(text) {
      socket.send(text);
    },
    onMessage(handler) {
      onMessage = handler;
    },
    onClose(handler) {
      onClose = handler;
    },
    close() {
      try {
        socket.close();
      } catch {
        // already closed
      }
    },
  };
}
