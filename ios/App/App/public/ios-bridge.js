// iOS Native Bridge & Platform Adapter for "Игры для двоих"
// Handles Capacitor plugins, Apple Taptic Engine haptics, Safe Areas, Status Bar, Keyboard, and WebSocket server routing.

(function (window) {
  'use strict';

  const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  const plugins = window.Capacitor?.Plugins || {};
  const { Haptics, StatusBar, SplashScreen, Keyboard, Share, App } = plugins;

  // Default server settings
  const STORAGE_KEY_SERVER = 'twop_server_url';
  
  // If running in browser, location.origin is the server. If running in native iOS container,
  // we check localStorage or fallback to production server / prompt.
  function getDefaultServer() {
    if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
      return window.location.origin;
    }
    return localStorage.getItem(STORAGE_KEY_SERVER) || '';
  }

  const Bridge = {
    isNative,

    // Initialize native features (Status Bar, Splash Screen, Keyboard listeners)
    async init() {
      // Configure Status Bar on iOS
      if (StatusBar) {
        try {
          await StatusBar.setStyle({ style: 'DARK' });
          await StatusBar.setOverlaysWebView({ overlay: true });
        } catch (e) {
          console.warn('[iOS Bridge] StatusBar error:', e);
        }
      }

      // Hide Splash screen smoothly after initial DOM render
      if (SplashScreen) {
        try {
          setTimeout(async () => {
            await SplashScreen.hide({ fadeOutDuration: 300 });
          }, 400);
        } catch (e) {
          console.warn('[iOS Bridge] SplashScreen error:', e);
        }
      }

      // App state listener for iOS background/foreground transitions
      if (App) {
        try {
          App.addListener('appStateChange', ({ isActive }) => {
            if (isActive) {
              window.dispatchEvent(new CustomEvent('app:resume'));
            } else {
              window.dispatchEvent(new CustomEvent('app:pause'));
            }
          });
        } catch (e) {
          console.warn('[iOS Bridge] App listener error:', e);
        }
      }

      // Keyboard listeners for iOS WKWebView
      if (Keyboard) {
        try {
          Keyboard.addListener('keyboardWillShow', info => {
            document.body.classList.add('keyboard-open');
            document.documentElement.style.setProperty('--keyboard-height', `${info.keyboardHeight}px`);
          });
          Keyboard.addListener('keyboardWillHide', () => {
            document.body.classList.remove('keyboard-open');
            document.documentElement.style.setProperty('--keyboard-height', '0px');
          });
        } catch (e) {
          console.warn('[iOS Bridge] Keyboard error:', e);
        }
      }
    },

    // Apple Taptic Engine & Haptic feedback
    haptics: {
      async impactLight() {
        if (Haptics) {
          try { await Haptics.impact({ style: 'LIGHT' }); return; } catch (_) {}
        }
        if (navigator.vibrate) navigator.vibrate(10);
      },
      async impactMedium() {
        if (Haptics) {
          try { await Haptics.impact({ style: 'MEDIUM' }); return; } catch (_) {}
        }
        if (navigator.vibrate) navigator.vibrate(20);
      },
      async impactHeavy() {
        if (Haptics) {
          try { await Haptics.impact({ style: 'HEAVY' }); return; } catch (_) {}
        }
        if (navigator.vibrate) navigator.vibrate(35);
      },
      async notificationSuccess() {
        if (Haptics) {
          try { await Haptics.notification({ type: 'SUCCESS' }); return; } catch (_) {}
        }
        if (navigator.vibrate) navigator.vibrate([15, 60, 25]);
      },
      async notificationWarning() {
        if (Haptics) {
          try { await Haptics.notification({ type: 'WARNING' }); return; } catch (_) {}
        }
        if (navigator.vibrate) navigator.vibrate([30, 50, 30]);
      },
      async notificationError() {
        if (Haptics) {
          try { await Haptics.notification({ type: 'ERROR' }); return; } catch (_) {}
        }
        if (navigator.vibrate) navigator.vibrate([40, 60, 40, 60]);
      },
      async selectionChanged() {
        if (Haptics) {
          try { await Haptics.selectionChanged(); return; } catch (_) {}
        }
        if (navigator.vibrate) navigator.vibrate(8);
      }
    },

    // Server configuration & resolution
    server: {
      get() {
        return localStorage.getItem(STORAGE_KEY_SERVER) || getDefaultServer();
      },
      set(url) {
        let cleaned = (url || '').trim().replace(/\/+$/, '');
        if (cleaned && !cleaned.startsWith('http://') && !cleaned.startsWith('https://') && !cleaned.startsWith('ws://') && !cleaned.startsWith('wss://')) {
          cleaned = 'https://' + cleaned;
        }
        localStorage.setItem(STORAGE_KEY_SERVER, cleaned);
        return cleaned;
      },
      getWsUrl() {
        const raw = this.get();
        if (!raw) {
          // If running directly on a web host:
          if (window.location.protocol === 'https:') return 'wss://' + window.location.host;
          if (window.location.protocol === 'http:') return 'ws://' + window.location.host;
          return null;
        }
        if (raw.startsWith('wss://') || raw.startsWith('ws://')) return raw;
        if (raw.startsWith('https://')) return raw.replace(/^https:\/\//, 'wss://');
        if (raw.startsWith('http://')) return raw.replace(/^http:\/\//, 'ws://');
        return 'wss://' + raw;
      },
      getWebShareUrl(roomCode) {
        const raw = this.get();
        let base = raw;
        if (!base || base.startsWith('ws://') || base.startsWith('wss://')) {
          if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
            base = window.location.origin + window.location.pathname;
          } else {
            base = (raw || '').replace(/^wss?:\/\//, 'https://');
          }
        }
        if (!base.endsWith('/')) base += '/';
        return base + (roomCode ? '?room=' + encodeURIComponent(roomCode) : '');
      }
    },

    // Native iOS Share Sheet
    async shareRoom(roomCode) {
      const url = this.server.getWebShareUrl(roomCode);
      const title = 'Игры для двоих';
      const text = `Сыграем в игры для двоих? Код комнаты: ${roomCode}`;

      if (Share) {
        try {
          await Share.share({ title, text, url, dialogTitle: 'Поделиться комнатой' });
          return true;
        } catch (e) {
          if (e.message && e.message.includes('canceled')) return true;
        }
      }

      if (navigator.share) {
        try {
          await navigator.share({ title, text, url });
          return true;
        } catch (e) {
          if (e.name === 'AbortError') return true;
        }
      }

      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url);
        return 'copied';
      }

      return false;
    }
  };

  window.IOSBridge = Bridge;

  // Auto-init on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => Bridge.init());
  } else {
    Bridge.init();
  }

})(window);

