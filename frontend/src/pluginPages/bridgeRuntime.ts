/**
 * Runs inside the opaque-origin frame before any page markup. The frame cannot reach host
 * storage, bindings or the network; this script is its only door back, and the host still
 * re-validates the frame token, identity, method, size, rate and concurrency on every message.
 */
import { sanitizeHostPalette, serializeHostPreferences, type PluginHostPreferences } from './hostPreferences';
import { sanitizeHostAppearance } from './hostAppearance';

export function createPageBridgeRuntime(token: string, preferences?: PluginHostPreferences): string {
  const tokenLiteral = JSON.stringify(String(token));
  return [
    '(function () {',
    '  if (window.gonavi && window.gonavi.__gonaviBridge) return;',
    '  var token = ' + tokenLiteral + ';',
    '  var sanitizeHostPalette = ' + sanitizeHostPalette.toString() + ';',
    '  var sanitizeHostAppearance = ' + sanitizeHostAppearance.toString() + ';',
    preferences ? '  window.gonaviHostPrefs = ' + serializeHostPreferences(preferences) + ';' : '',
    // Bind the door before page scripts run: a page that later rewrites parent or
    // postMessage must not be able to intercept outgoing calls and lift the token.
    '  var parentPost = parent.postMessage.bind(parent);',
    // The token only lives in this closure; remove the inline script so the page DOM
    // cannot read it back and carry it across a navigation.
    '  if (document.currentScript && document.currentScript.parentNode) document.currentScript.parentNode.removeChild(document.currentScript);',
    '  var pending = {};',
    '  var seq = 0;',
    '  function post(payload) { parentPost(payload, "*"); }',
    '  function call(method, args) {',
    '    return new Promise(function (resolve, reject) {',
    '      var id = "r" + (++seq).toString(36);',
    '      pending[id] = { resolve: resolve, reject: reject };',
    '      try {',
    '        post({ type: "gonavi:page-call", token: token, id: id, method: String(method), arguments: args === undefined ? {} : args });',
    '      } catch (error) {',
    '        delete pending[id];',
    '        reject(new Error("gonavi:bridge"));',
    '      }',
    '    });',
    '  }',
    '  function notify(message, type) {',
    '    try {',
    '      post({ type: "gonavi:page-call", token: token, id: "n" + (++seq).toString(36), method: "ui.notify", arguments: { message: String(message), type: type === undefined ? "info" : String(type) } });',
    '    } catch (error) {',
    '      return;',
    '    }',
    '  }',
    '  window.addEventListener("message", function (event) {',
    '    if (event.source !== parent) return;',
    '    var data = event.data;',
    '    if (data && data.type === "gonavi:host-preferences") {',
    '      if (data.token !== token) return;',
    '      var prefs = data.preferences;',
    '      if (!prefs || ["zh-CN", "zh-TW", "en-US", "ja-JP", "de-DE", "ru-RU"].indexOf(prefs.locale) < 0 || (prefs.theme !== "light" && prefs.theme !== "dark")) return;',
    '      var palette = sanitizeHostPalette(prefs.palette);',
    '      window.gonaviHostPrefs = { locale: prefs.locale, theme: prefs.theme };',
    '      if (palette) window.gonaviHostPrefs.palette = palette;',
    '      var appearance = sanitizeHostAppearance(prefs.appearance);',
    '      if (appearance) window.gonaviHostPrefs.appearance = appearance;',
    '      window.dispatchEvent(new CustomEvent("gonavi:host-preferences"));',
    '      return;',
    '    }',
    '    if (!data || data.type !== "gonavi:page-result" || typeof data.id !== "string") return;',
    '    var entry = pending[data.id];',
    '    if (!entry) return;',
    '    delete pending[data.id];',
    '    if (data.ok) entry.resolve(data.value);',
    '    else entry.reject(new Error(typeof data.error === "string" ? data.error : "gonavi:bridge"));',
    '  });',
    '  window.gonavi = { call: call, notify: notify, __gonaviBridge: true };',
    '})();',
  ].join('\n');
}
