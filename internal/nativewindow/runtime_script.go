package nativewindow

func detachedRuntimeBridgeScript() string {
	return `(function () {
  if (typeof window === 'undefined') return;

  var existingGo = window.go || {};
  var nativeNamespace = existingGo.nativewindow || {};
  var bridge = nativeNamespace.Bridge;
  var control = nativeNamespace.Control;
  if (
    !bridge
    || typeof bridge.Invoke !== 'function'
    || typeof bridge.WindowID !== 'function'
    || typeof bridge.OpenWindow !== 'function'
    || typeof bridge.FocusWindow !== 'function'
    || typeof bridge.HideWindow !== 'function'
    || typeof bridge.CloseWindow !== 'function'
    || typeof bridge.CloseOwnedWindows !== 'function'
  ) {
    console.error('[GoNavi Detached] native bridge is unavailable');
    return;
  }

  var invoke = function (namespace, receiver, method, args) {
    return bridge.Invoke(namespace, receiver, method, Array.isArray(args) ? args : []);
  };
  var isPromiseAdapter = function (property) {
    return property === 'then' || property === 'catch' || property === 'finally';
  };
  var buildServiceProxy = function (namespace, receiver) {
    return new Proxy({}, {
      get: function (_target, property) {
        // 与 Web 桥一致：不能让 then/catch/finally 变成 RPC，否则服务对象
        // 会被 Promise 当成 thenable，设置页加载会一直转圈。
        if (typeof property !== 'string' || isPromiseAdapter(property)) return undefined;
        return function () {
          return invoke(namespace, receiver, property, Array.prototype.slice.call(arguments));
        };
      }
    });
  };
  var parentWindowManager = {
    Open: function (request) {
      return bridge.OpenWindow(request || {});
    },
    Focus: function (id) {
      return bridge.FocusWindow(String(id || ''));
    },
    Hide: function (id) {
      return bridge.HideWindow(String(id || ''));
    },
    Close: function (id) {
      return bridge.CloseWindow(String(id || ''));
    },
    CloseAll: function () {
      return bridge.CloseOwnedWindows();
    }
  };
  nativeNamespace = {
    ...nativeNamespace,
    Manager: parentWindowManager
  };

  window.go = {
    ...existingGo,
    nativewindow: nativeNamespace,
    app: {
      ...(existingGo.app || {}),
      App: buildServiceProxy('app', 'App')
    },
    aiservice: {
      ...(existingGo.aiservice || {}),
      Service: buildServiceProxy('aiservice', 'Service')
    }
  };

  var detached = {
    active: true,
    bootstrap: null,
    bootstrapPromise: null,
    loadBootstrap: function () {
      if (!detached.bootstrapPromise) {
        detached.bootstrapPromise = bridge.Bootstrap().then(function (payload) {
          detached.bootstrap = payload;
          return payload;
        });
      }
      return detached.bootstrapPromise;
    },
    present: function () {
      if (!control || typeof control.Present !== 'function') {
        return Promise.reject(new Error('native window present control is unavailable'));
      }
      return control.Present();
    },
    action: function (action, payload) {
      return bridge.Action(String(action || ''), payload || {});
    }
  };
  window.__GONAVI_DETACHED__ = detached;
  window.__GONAVI_DETACHED_RUNTIME__ = {
    buildType: 'desktop-detached',
    capabilities: { nativeWindow: true, sharedBackend: true }
  };

  var detachedWindowIDPromise = Promise.resolve(bridge.WindowID()).then(function (windowID) {
    return String(windowID || '');
  });
  var requestGracefulClose = function (reason) {
    window.dispatchEvent(new CustomEvent('` + GracefulCloseRequestEventName + `', {
      detail: { reason: String(reason || '') }
    }));
  };
  var visibilityRevisionOf = function (command) {
    var value = Number(command && command.payload && command.payload.visibilityRevision);
    return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
  };
  var requestGracefulHide = function (command) {
    window.dispatchEvent(new CustomEvent('` + GracefulHideRequestEventName + `', {
      detail: { visibilityRevision: visibilityRevisionOf(command) }
    }));
  };

  var runtime = window.runtime || {};
  if (typeof runtime.EventsOnMultiple === 'function') {
    runtime.EventsOnMultiple('` + CommandEventName + `', function (command) {
      detachedWindowIDPromise.then(function (windowID) {
        if (!command || String(command.id || '') !== windowID) return;
        if (command.action === 'close') {
          requestGracefulClose(command.reason);
        } else if (command.action === 'hide') {
          requestGracefulHide(command);
        } else if (command.action === 'focus' && control) {
          if (typeof control.FocusRevision === 'function') {
            control.FocusRevision(visibilityRevisionOf(command));
          } else if (typeof control.Focus === 'function') {
            control.Focus();
          }
        }
      });
    }, -1);
  }
})();`
}
