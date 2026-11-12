/**
 * CleanVid — connection to the offscreen audio engine.
 *
 * Used by the content script and extension pages. Asks the service worker to
 * start the engine, opens a long-lived port, and reconnects automatically if
 * the engine restarts. Exposes CleanVid.EngineClient.
 */
(() => {
  const NS = (globalThis.CleanVid = globalThis.CleanVid || {});
  if (NS.EngineClient) return;

  const PORT_NAME = 'cleanvid-engine';

  function create({ onMessage, onConnect, onDisconnect } = {}) {
    let port = null;
    let connecting = null;
    let closed = false;
    let retries = 0;
    let retryTimer = null;
    const queue = [];

    function ensureEngine() {
      return new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({ type: 'engine-ensure' }, (response) => {
            void chrome.runtime.lastError;
            resolve(Boolean(response && response.ok));
          });
        } catch {
          resolve(false);
        }
      });
    }

    async function connect() {
      if (port || closed) return port;
      if (connecting) return connecting;
      connecting = (async () => {
        const ok = await ensureEngine();
        if (!ok || closed) return null;
        let next;
        try {
          next = chrome.runtime.connect({ name: PORT_NAME });
        } catch {
          return null;
        }
        port = next;
        const openedAt = Date.now();
        next.onMessage.addListener((message) => {
          retries = 0;
          if (onMessage) onMessage(message);
        });
        next.onDisconnect.addListener(() => {
          void chrome.runtime.lastError;
          if (port === next) port = null;
          if (onDisconnect) onDisconnect();
          if (closed) return;
          // Extension reloaded: stop trying.
          try {
            if (!chrome.runtime || !chrome.runtime.id) return;
          } catch {
            return;
          }
          const quick = Date.now() - openedAt < 1500;
          retries = quick ? retries + 1 : 0;
          clearTimeout(retryTimer);
          retryTimer = setTimeout(connect, Math.min(15000, 400 * 2 ** Math.min(retries, 5)));
        });
        if (onConnect) onConnect();
        while (queue.length && port) {
          try {
            port.postMessage(queue.shift());
          } catch {
            break;
          }
        }
        return next;
      })().finally(() => {
        connecting = null;
      });
      return connecting;
    }

    function post(message, { queueIfOffline = true } = {}) {
      if (port) {
        try {
          port.postMessage(message);
          return true;
        } catch {
          port = null;
        }
      }
      if (queueIfOffline) {
        queue.push(message);
        if (queue.length > 400) queue.splice(0, queue.length - 400);
      }
      connect();
      return false;
    }

    return {
      connect,
      post,
      get connected() {
        return Boolean(port);
      },
      close() {
        closed = true;
        clearTimeout(retryTimer);
        try {
          if (port) port.disconnect();
        } catch {
          /* ignore */
        }
        port = null;
      },
    };
  }

  NS.EngineClient = { create };
})();
