// content.js — Ducky 3.2 · puente entre la página y la extensión
// El audio lo maneja engine.js dentro de la página. Este script lee los
// ajustes guardados, se los pasa al motor, reenvía el medidor al popup y
// pide a background.js el permiso CORS para videos de otro dominio.

(() => {
  "use strict";

  if (window.__duckyBridge32__) return;
  window.__duckyBridge32__ = true;

  const IS_TOP = window.top === window;
  const SITE = topHost();
  const KEY = `site:${SITE}`;

  let settings = null;
  let dead = false;

  // Los iframes (p. ej. un reproductor incrustado) usan el ajuste del sitio
  // que estás viendo, no el del dominio del iframe.
  function topHost() {
    if (IS_TOP) return location.hostname || "local";
    const ao = location.ancestorOrigins;
    if (ao && ao.length) {
      try {
        return new URL(ao[ao.length - 1]).hostname || "local";
      } catch (e) {}
    }
    try {
      return window.top.location.hostname || "local";
    } catch (e) {
      return location.hostname || "local";
    }
  }

  // La extensión se recargó o actualizó: este script quedó huérfano.
  function alive() {
    if (dead) return false;
    try {
      if (chrome.runtime && chrome.runtime.id) return true;
    } catch (e) {}
    dead = true;
    return false;
  }

  function send(msg, cb) {
    if (!alive()) return false;
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        const err = chrome.runtime.lastError;
        if (cb) cb(err ? null : res);
      });
      return true;
    } catch (e) {
      if (cb) cb(null);
      return false;
    }
  }

  // ------------------------------------------------------- motor ⇄ puente

  function toEngine(msg) {
    window.dispatchEvent(new CustomEvent("ducky:cmd", { detail: JSON.stringify(msg) }));
  }

  window.addEventListener("ducky:evt", (e) => {
    let m;
    try {
      m = JSON.parse(e.detail);
    } catch (err) {
      return;
    }
    if (!m) return;

    if (m.t === "hello") {
      if (settings) toEngine({ t: "settings", s: settings });
    } else if (m.t === "status") {
      // Frames sin medios (anuncios, widgets) no envían nada.
      if (!IS_TOP && !m.total) return;
      send({
        type: "METER",
        peak: Number(m.peak) || 0,
        total: m.total | 0,
        ok: m.ok | 0,
        failed: m.failed | 0,
      });
    } else if (m.t === "cors" && typeof m.origin === "string" && typeof m.host === "string") {
      // Solo para el origen real de este frame.
      if (m.origin !== location.origin) {
        toEngine({ t: "reply", id: m.id, ok: false });
        return;
      }
      const sent = send({ type: "CORS", origin: location.origin, host: m.host, site: SITE }, (res) =>
        toEngine({ t: "reply", id: m.id, ok: !!(res && res.ok) })
      );
      if (!sent) toEngine({ t: "reply", id: m.id, ok: false });
    }
  });

  // ------------------------------------------------------------ ajustes

  function setSettings(saved) {
    settings = { gain: 1, boost: 0, limiter: true, ...(saved || {}) };
    toEngine({ t: "settings", s: settings });
    if (IS_TOP) send({ type: "BADGE", gain: Number(settings.gain) || 0 });
  }

  try {
    chrome.storage.local.get(KEY, (data) => {
      if (chrome.runtime.lastError || !data) return;
      setSettings(data[KEY]);
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[KEY] || !alive()) return;
      setSettings(changes[KEY].newValue);
    });

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || !alive()) return;
      if (msg.type === "METER_ON") {
        toEngine({ t: "meter" });
        sendResponse({ ok: true });
      }
    });
  } catch (e) {
    dead = true;
  }
})();
