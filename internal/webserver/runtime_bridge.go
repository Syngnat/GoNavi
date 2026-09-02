package webserver

func runtimeBridgeScript() string {
	return `(function () {
  if (typeof window === 'undefined') {
    return;
  }

  var apiBase = '` + internalRoutePrefix + `';
  var existingRuntime = window.runtime || {};
  var listeners = new Map();
  var eventSource = null;

  var dispatch = function (eventName, args) {
    var callbacks = listeners.get(eventName);
    if (!callbacks || callbacks.size === 0) {
      return;
    }
    callbacks.forEach(function (callback) {
      try {
        if (!Array.isArray(args) || args.length === 0) {
          callback();
          return;
        }
        if (args.length === 1) {
          callback(args[0]);
          return;
        }
        callback.apply(null, args);
      } catch (error) {
        console.error('[GoNavi Web Runtime] event callback failed', error);
      }
    });
  };

  var ensureEventSource = function () {
    if (eventSource || typeof EventSource === 'undefined') {
      return;
    }
    eventSource = new EventSource(apiBase + '/events');
    eventSource.addEventListener('gonavi', function (event) {
      try {
        var payload = JSON.parse(event.data || '{}');
        dispatch(String(payload.name || ''), Array.isArray(payload.args) ? payload.args : []);
      } catch (error) {
        console.error('[GoNavi Web Runtime] failed to parse server event', error);
      }
    });
    eventSource.onerror = function () {
      if (!eventSource) {
        return;
      }
      try {
        eventSource.close();
      } catch (_) {}
      eventSource = null;
      window.setTimeout(ensureEventSource, 1500);
    };
  };

  var addListener = function (eventName, callback) {
    var key = String(eventName || '').trim();
    if (!key || typeof callback !== 'function') {
      return function () {};
    }
    ensureEventSource();
    if (!listeners.has(key)) {
      listeners.set(key, new Set());
    }
    listeners.get(key).add(callback);
    return function () {
      var callbacks = listeners.get(key);
      if (!callbacks) {
        return;
      }
      callbacks.delete(callback);
      if (callbacks.size === 0) {
        listeners.delete(key);
      }
    };
  };

  var removeListeners = function () {
    Array.prototype.slice.call(arguments).forEach(function (eventName) {
      listeners.delete(String(eventName || '').trim());
    });
  };

  var clearListeners = function () {
    listeners.clear();
    if (eventSource) {
      try {
        eventSource.close();
      } catch (_) {}
      eventSource = null;
    }
  };

  var buildAbortError = function (dispatchState) {
    var error = new Error('Web RPC request was aborted');
    error.name = 'AbortError';
    error.code = 'WEB_RPC_ABORTED';
    error.dispatchState = dispatchState;
    return error;
  };

  var invokeWithOptions = async function (namespace, receiver, method, args, options) {
    options = options || {};
    var signal = options.signal;
    if (signal && signal.aborted) {
      throw buildAbortError('not_started');
    }
    var response;
    var payload;
    try {
      response = await fetch(apiBase + '/api/invoke', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        credentials: 'same-origin',
        signal: signal,
        body: JSON.stringify({
          namespace: namespace,
          receiver: receiver,
          method: method,
          args: Array.isArray(args) ? args : []
        })
      });
      payload = await response.json().catch(function (error) {
        if ((signal && signal.aborted) || (error && error.name === 'AbortError')) {
          throw error;
        }
        return {};
      });
    } catch (error) {
      if ((signal && signal.aborted) || (error && error.name === 'AbortError')) {
        throw buildAbortError('possibly_dispatched');
      }
      throw error;
    }
    if (!response.ok || payload.error) {
      throw new Error(payload.error || ('invoke failed with status ' + response.status));
    }
    if (payload.requestId) {
      var requestId = String(payload.requestId);
      window.__GONAVI_LAST_REQUEST_ID__ = requestId;
      if (payload.result && typeof payload.result === 'object' && !Array.isArray(payload.result)) {
        try {
          Object.defineProperty(payload.result, '__gonaviRequestId', {
            value: requestId,
            configurable: true
          });
        } catch (_) {}
      }
    }
    return payload.result;
  };

  var invoke = function (namespace, receiver, method, args) {
    return invokeWithOptions(namespace, receiver, method, args, {});
  };

  var buildServiceProxy = function (namespace, receiver) {
    return new Proxy({}, {
      get: function (_target, property) {
        if (typeof property !== 'string') {
          return undefined;
        }
        return function () {
          return invoke(namespace, receiver, property, Array.prototype.slice.call(arguments));
        };
      }
    });
  };

  var detectPlatform = function () {
    var value = '';
    if (navigator.userAgentData && navigator.userAgentData.platform) {
      value = navigator.userAgentData.platform;
    } else if (navigator.platform) {
      value = navigator.platform;
    } else if (navigator.userAgent) {
      value = navigator.userAgent;
    }
    value = String(value || '').toLowerCase();
    if (value.indexOf('win') >= 0) return 'windows';
    if (value.indexOf('mac') >= 0) return 'darwin';
    if (value.indexOf('linux') >= 0) return 'linux';
    return '';
  };

  var environment = function () {
    return Promise.resolve({
      platform: detectPlatform(),
      buildType: 'web',
      capabilities: {
        nativeWindow: false,
        fileDialog: false,
        clipboard: typeof navigator !== 'undefined' && !!navigator.clipboard
      }
    });
  };

  var openExternal = function (url) {
    if (!url) return;
    window.open(String(url), '_blank', 'noopener,noreferrer');
  };

  var clipboardGetText = async function () {
    if (navigator.clipboard && navigator.clipboard.readText) {
      return navigator.clipboard.readText();
    }
    return '';
  };

  var clipboardSetText = async function (value) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(String(value || ''));
    }
  };

  var fullscreen = async function () {
    if (document.documentElement && document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen().catch(function () { return undefined; });
    }
  };

  var unfullscreen = async function () {
    if (document.exitFullscreen) {
      await document.exitFullscreen().catch(function () { return undefined; });
    }
  };

  var getSize = function () {
    return Promise.resolve({ w: window.innerWidth || 0, h: window.innerHeight || 0 });
  };

  var getPosition = function () {
    return Promise.resolve({ x: window.screenX || 0, y: window.screenY || 0 });
  };

  var existingGo = window.go || {};
  window.__GONAVI_WEB_RUNTIME__ = {
    buildType: 'web',
    capabilities: {
      nativeWindow: false,
      fileDialog: false,
      clipboard: typeof navigator !== 'undefined' && !!navigator.clipboard
    }
  };
  window.__GONAVI_WEB_RPC__ = {
    invoke: invoke,
    invokeWithOptions: invokeWithOptions
  };
  window.go = {
    ...existingGo,
    app: {
      ...(existingGo.app || {}),
      App: buildServiceProxy('app', 'App')
    },
    aiservice: {
      ...(existingGo.aiservice || {}),
      Service: buildServiceProxy('aiservice', 'Service')
    }
  };

  window.runtime = {
    ...existingRuntime,
    LogPrint: function (message) { console.log(message); },
    LogTrace: function (message) { console.debug(message); },
    LogDebug: function (message) { console.debug(message); },
    LogInfo: function (message) { console.info(message); },
    LogWarning: function (message) { console.warn(message); },
    LogError: function (message) { console.error(message); },
    LogFatal: function (message) { console.error(message); },
    EventsOnMultiple: function (eventName, callback) { return addListener(eventName, callback); },
    EventsOff: removeListeners,
    EventsOffAll: clearListeners,
    EventsEmit: function (eventName) {
      dispatch(String(eventName || '').trim(), Array.prototype.slice.call(arguments, 1));
    },
    WindowReload: function () { window.location.reload(); },
    WindowReloadApp: function () { window.location.reload(); },
    WindowSetAlwaysOnTop: function () { return Promise.resolve(); },
    WindowCenter: function () { return Promise.resolve(); },
    WindowSetTitle: function (title) {
      if (typeof title === 'string' && title.trim()) {
        document.title = title;
      }
      return Promise.resolve();
    },
    BrowserOpenURL: openExternal,
    Environment: environment,
    WindowFullscreen: fullscreen,
    WindowUnfullscreen: unfullscreen,
    WindowIsFullscreen: function () { return Promise.resolve(!!document.fullscreenElement); },
    WindowIsMaximised: function () { return Promise.resolve(false); },
    WindowIsMinimised: function () { return Promise.resolve(false); },
    WindowIsNormal: function () { return Promise.resolve(!document.fullscreenElement); },
    WindowMaximise: function () { return Promise.resolve(); },
    WindowMinimise: function () { return Promise.resolve(); },
    WindowUnmaximise: function () { return Promise.resolve(); },
    WindowUnminimise: function () { return Promise.resolve(); },
    WindowToggleMaximise: function () {
      if (document.fullscreenElement) {
        return unfullscreen();
      }
      return fullscreen();
    },
    WindowGetSize: getSize,
    WindowGetPosition: getPosition,
    WindowSetSize: function (width, height) {
      try { window.resizeTo(Number(width) || window.innerWidth, Number(height) || window.innerHeight); } catch (_) {}
      return Promise.resolve();
    },
    WindowSetMaxSize: function () { return Promise.resolve(); },
    WindowSetMinSize: function () { return Promise.resolve(); },
    WindowSetPosition: function (x, y) {
      try { window.moveTo(Number(x) || 0, Number(y) || 0); } catch (_) {}
      return Promise.resolve();
    },
    WindowHide: function () { return Promise.resolve(); },
    WindowShow: function () { return Promise.resolve(); },
    ScreenGetAll: function () { return Promise.resolve([]); },
    WindowSetSystemDefaultTheme: function () { return Promise.resolve(); },
    WindowSetDarkTheme: function () { return Promise.resolve(); },
    WindowSetLightTheme: function () { return Promise.resolve(); },
    Quit: function () {
      try { window.close(); } catch (_) {}
      return Promise.resolve();
    },
    Hide: function () { return Promise.resolve(); },
    Show: function () { return Promise.resolve(); },
    ClipboardGetText: clipboardGetText,
    ClipboardSetText: clipboardSetText,
    OnFileDrop: function () { return function () {}; },
    OnFileDropOff: function () { return Promise.resolve(); },
    CanResolveFilePaths: function () { return Promise.resolve(false); },
    ResolveFilePaths: function (files) { return Promise.resolve(Array.isArray(files) ? files : []); }
  };
})();`
}
