/**
 * EventBus - Central decoupled publish/subscribe event communication layer.
 * All modules communicate via window.AppBus without direct imports or cross-references.
 */
(function () {
  'use strict';

  const listenersMap = new Map();

  const AppBus = {
    /**
     * Subscribe to an event with a callback.
     * @param {string} event Event name
     * @param {Function} callback Handler function
     * @returns {Function} Unsubscribe function
     */
    on(event, callback) {
      if (typeof event !== 'string' || typeof callback !== 'function') {
        console.warn('[AppBus] Invalid on() arguments:', { event, callback });
        return () => {};
      }

      if (!listenersMap.has(event)) {
        listenersMap.set(event, new Set());
      }
      listenersMap.get(event).add(callback);

      return () => this.off(event, callback);
    },

    /**
     * Subscribe to an event once. Automatically unregisters after first trigger.
     * @param {string} event Event name
     * @param {Function} callback Handler function
     * @returns {Function} Unsubscribe function
     */
    once(event, callback) {
      if (typeof event !== 'string' || typeof callback !== 'function') {
        console.warn('[AppBus] Invalid once() arguments:', { event, callback });
        return () => {};
      }

      const wrapper = (payload) => {
        this.off(event, wrapper);
        callback(payload);
      };
      return this.on(event, wrapper);
    },

    /**
     * Unsubscribe from an event.
     * If callback is omitted, all listeners for the event are removed.
     * @param {string} event Event name
     * @param {Function} [callback] Specific handler to remove
     */
    off(event, callback) {
      if (typeof event !== 'string') return;

      if (!listenersMap.has(event)) return;

      if (!callback) {
        listenersMap.delete(event);
      } else {
        const set = listenersMap.get(event);
        set.delete(callback);
        if (set.size === 0) {
          listenersMap.delete(event);
        }
      }
    },

    /**
     * Emit an event to all registered listeners.
     * Wrapped in try/catch to isolate individual listener exceptions.
     * @param {string} event Event name
     * @param {any} [payload] Event payload
     */
    emit(event, payload) {
      if (typeof event !== 'string' || !listenersMap.has(event)) return;

      const handlers = Array.from(listenersMap.get(event));
      for (let i = 0; i < handlers.length; i++) {
        const fn = handlers[i];
        try {
          fn(payload);
        } catch (err) {
          console.error(`[AppBus] Error in listener for event "${event}":`, err, {
            handler: fn,
            payload,
          });
        }
      }
    },

    /**
     * Remove all listeners for all events.
     */
    clear() {
      listenersMap.clear();
    },

    /**
     * List all currently registered events and listener counts.
     */
    debug() {
      const summary = {};
      listenersMap.forEach((set, key) => {
        summary[key] = set.size;
      });
      return summary;
    },
  };

  window.AppBus = AppBus;
})();
