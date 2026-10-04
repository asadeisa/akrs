// Shared helpers of the P2-W13 browser tests: an in-memory CDP peer (the fake the unit tests talk to), a manual scheduler
// that makes timeouts deterministic, and a scripted browser that answers the calls a page session makes.

// The transport contract of the CDP client: send(text), onMessage(handler), onClose(handler), close().
export class FakeTransport {
  constructor(respond = () => undefined) {
    this.respond = respond;
    this.sent = [];
    this.closed = false;
    this.messageHandler = () => {};
    this.closeHandler = () => {};
  }

  send(text) {
    const message = JSON.parse(text);
    this.sent.push(message);
    queueMicrotask(() => {
      const reply = this.respond(message, this);
      if (reply !== undefined) this.push(reply);
    });
  }

  onMessage(handler) {
    this.messageHandler = handler;
  }

  onClose(handler) {
    this.closeHandler = handler;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.closeHandler();
  }

  // the browser says something (a reply or an event)
  push(message) {
    this.messageHandler(typeof message === 'string' ? message : JSON.stringify(message));
  }

  event(method, params = {}, sessionId = 'S1') {
    this.push({ method, params, sessionId });
  }
}

// Time that only moves when a test says so: schedule(fn, ms) -> cancel.
export function manualScheduler() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    schedule(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return () => timers.delete(id);
    },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= now && timers.has(id)) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
    pending: () => timers.size,
  };
}

export const flush = () => new Promise((resolve) => setImmediate(resolve));

const AX = (nodes) => ({ nodes });
export const SAMPLE_AX = AX([
  { nodeId: '1', ignored: false, role: { value: 'RootWebArea' }, name: { value: 'Demo' }, childIds: ['2', '3', '4', '5'] },
  { nodeId: '2', ignored: false, role: { value: 'heading' }, name: { value: 'Reservations' }, childIds: ['6'], parentId: '1' },
  { nodeId: '3', ignored: true, role: { value: 'generic' }, name: { value: '' }, childIds: [], parentId: '1' },
  { nodeId: '4', ignored: false, role: { value: 'button' }, name: { value: 'Save' }, childIds: [], parentId: '1' },
  { nodeId: '5', ignored: false, role: { value: 'generic' }, name: { value: '' }, childIds: ['7'], parentId: '1' },
  { nodeId: '6', ignored: false, role: { value: 'StaticText' }, name: { value: 'Reservations' }, childIds: [], parentId: '2' },
  { nodeId: '7', ignored: false, role: { value: 'link' }, name: { value: 'Back' }, childIds: [], parentId: '5' },
]);

// A scripted browser: answers the calls of a page session, emits events at the right moments. `page` shapes the page it shows.
export function fakeBrowser(page = {}) {
  const state = {
    title: 'Demo', url: 'http://localhost:3000/', text: 'Hello reservations', loaderId: 'L1', navigateError: undefined,
    navigation: { responseStart: 12.4, domContentLoadedEventEnd: 80.2, loadEventEnd: 120.7 },
    events: [], ax: SAMPLE_AX, screenshot: Buffer.from('PNG-BYTES').toString('base64'), idle: true, bodyText: undefined, ...page,
  };
  const transport = new FakeTransport((message, peer) => {
    const reply = (result) => ({ id: message.id, ...(message.sessionId === undefined ? {} : { sessionId: message.sessionId }), result });
    switch (message.method) {
      case 'Target.createTarget': return reply({ targetId: 'T1' });
      case 'Target.attachToTarget': return reply({ sessionId: 'S1' });
      case 'Page.navigate':
        setTimeout(() => {
          peer.event('Page.lifecycleEvent', { name: 'networkIdle', loaderId: 'about-blank-loader', frameId: 'F1' });
          for (const [method, params] of state.events) peer.event(method, params);
          if (state.idle) {
            peer.event('Page.loadEventFired', {});
            peer.event('Page.lifecycleEvent', { name: 'networkIdle', loaderId: state.loaderId, frameId: 'F1' });
          }
        }, 0);
        return reply({ frameId: 'F1', loaderId: state.loaderId, ...(state.navigateError === undefined ? {} : { errorText: state.navigateError }) });
      case 'Runtime.evaluate': {
        const expression = message.params.expression;
        if (expression.includes('getEntriesByType')) return reply({ result: { type: 'string', value: JSON.stringify(state.navigation) } });
        if (expression.includes('location.href')) return reply({ result: { type: 'string', value: JSON.stringify({ title: state.title, url: state.url }) } });
        if (expression.includes('includes(')) {
          return reply({ result: { type: 'boolean', value: (state.bodyText ?? state.text).includes(JSON.parse(expression.match(/includes\((".*")\)/)[1])) } });
        }
        return reply({ result: { type: 'string', value: state.text } });
      }
      case 'Accessibility.getFullAXTree': return reply(state.ax);
      case 'Page.captureScreenshot': return reply({ data: state.screenshot });
      case 'Browser.close': return reply({});
      default: return reply({});
    }
  });
  return { transport, state, methods: () => transport.sent.map(({ method }) => method) };
}
