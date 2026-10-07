// Native bridge injected into the Open Lounge page.
//
// Contract (consumed by the web app's src/lib/session.ts when present):
//
//   window.OpenLoungeNative = {
//     getSession():              Promise<string | null>
//     setSession(json: string):  Promise<void>
//     clearSession():            Promise<void>
//   }
//
// Transport: injectedJavaScriptBeforeContentLoaded defines the object before any page script runs.
// Each call posts {"__ol":1,"id":"<request id>","method":"getSession|setSession|clearSession","value"?:string}
// through window.ReactNativeWebView.postMessage. The app answers by calling
// window.__openLoungeNativeResolve(id, ok, result, error) via injectJavaScript. Calls time out after 10 s
// (rejected), unknown ids are ignored. Only pages on the app's own https hosts get answers.
//
// Extra (optional) message from the page: {"__ol":1,"method":"theme","value":"dark"|"light"} — sent
// automatically by the injected script when <html data-theme> changes; drives the status bar style.

export type BridgeRequest =
  | { __ol: 1; id: string; method: 'getSession' }
  | { __ol: 1; id: string; method: 'setSession'; value: string }
  | { __ol: 1; id: string; method: 'clearSession' }
  | { __ol: 1; method: 'theme'; value: 'dark' | 'light' };

export function parseBridgeMessage(data: string): BridgeRequest | null {
  try {
    const m = JSON.parse(data) as Record<string, unknown>;
    if (!m || m.__ol !== 1 || typeof m.method !== 'string') return null;
    if (m.method === 'theme') return m.value === 'light' || m.value === 'dark' ? (m as BridgeRequest) : null;
    if (typeof m.id !== 'string' || m.id.length > 64) return null;
    if (m.method === 'getSession' || m.method === 'clearSession') return m as BridgeRequest;
    if (m.method === 'setSession' && typeof m.value === 'string') return m as BridgeRequest;
    return null;
  } catch {
    return null;
  }
}

/** JS that resolves/rejects a pending request inside the page. */
export function resolveScript(id: string, ok: boolean, result: unknown, error?: string): string {
  const args = [JSON.stringify(id), ok ? 'true' : 'false', JSON.stringify(result ?? null), JSON.stringify(error ?? null)];
  return `window.__openLoungeNativeResolve&&window.__openLoungeNativeResolve(${args.join(',')});true;`;
}

export function injectedBeforeContentLoaded(platform: string, appVersion: string): string {
  return `(function(){
  try {
    if (window.OpenLoungeNative && window.OpenLoungeNative.__expo) return;
    var pending = {};
    var seq = 0;
    function call(method, value) {
      return new Promise(function (resolve, reject) {
        var bridge = window.ReactNativeWebView;
        if (!bridge || typeof bridge.postMessage !== 'function') { reject(new Error('OpenLoungeNative unavailable')); return; }
        var id = 'ol' + Date.now().toString(36) + '_' + (++seq);
        var timer = setTimeout(function () {
          if (pending[id]) { delete pending[id]; reject(new Error('OpenLoungeNative ' + method + ' timed out')); }
        }, 10000);
        pending[id] = { resolve: resolve, reject: reject, timer: timer };
        var msg = { __ol: 1, id: id, method: method };
        if (value !== undefined) msg.value = value;
        try { bridge.postMessage(JSON.stringify(msg)); }
        catch (e) { clearTimeout(timer); delete pending[id]; reject(e); }
      });
    }
    Object.defineProperty(window, '__openLoungeNativeResolve', {
      configurable: false, enumerable: false, writable: false,
      value: function (id, ok, result, error) {
        var p = pending[id];
        if (!p) return;
        delete pending[id];
        clearTimeout(p.timer);
        if (ok) p.resolve(result); else p.reject(new Error(error || 'OpenLoungeNative error'));
      }
    });
    var api = {
      __expo: true,
      platform: ${JSON.stringify(platform)},
      version: ${JSON.stringify(appVersion)},
      getSession: function () {
        return call('getSession').then(function (v) { return typeof v === 'string' ? v : null; });
      },
      setSession: function (json) {
        if (typeof json !== 'string') return Promise.reject(new TypeError('setSession expects a string'));
        return call('setSession', json).then(function () {});
      },
      clearSession: function () { return call('clearSession').then(function () {}); }
    };
    Object.defineProperty(window, 'OpenLoungeNative', { configurable: false, enumerable: true, writable: false, value: Object.freeze(api) });

    // Report the web app's theme (<html data-theme="dark|light">) so the status bar matches.
    var lastTheme = null;
    function sendTheme() {
      var t = document.documentElement && document.documentElement.getAttribute('data-theme');
      if ((t === 'dark' || t === 'light') && t !== lastTheme && window.ReactNativeWebView) {
        lastTheme = t;
        window.ReactNativeWebView.postMessage(JSON.stringify({ __ol: 1, method: 'theme', value: t }));
      }
    }
    function watchTheme() {
      if (!document.documentElement) return;
      sendTheme();
      new MutationObserver(sendTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }
    if (document.documentElement) watchTheme(); else document.addEventListener('DOMContentLoaded', watchTheme);
    window.addEventListener('pageshow', function () { lastTheme = null; sendTheme(); });
  } catch (e) {}
})();
true;`;
}
