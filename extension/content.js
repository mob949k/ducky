// content.js — Ducky 3.5 · puente entre la página y la extensión
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
  let meterUntil = 0; // el popup pidió el medidor hace poco
  let lastCors = 0;
  let corsCount = 0;
  const MAX_CORS = 20; // pedidos de permiso por frame

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

  // Este canal también lo puede usar la página, así que todo lo que llega
  // se valida y se limita.
  window.addEventListener("ducky:evt", (e) => {
    const d = e.detail;
    if (typeof d !== "string" || d.length > 1000 || dead) return;
    let m;
    try {
      m = JSON.parse(d);
    } catch (err) {
      return;
    }
    if (!m || typeof m !== "object") return;

    if (m.t === "hello") {
      if (settings) toEngine({ t: "settings", s: settings });
    } else if (m.t === "status") {
      // Solo mientras el popup está abierto; frames sin medios no envían nada.
      if (Date.now() > meterUntil) return;
      if (!IS_TOP && !m.total) return;
      send({
        type: "METER",
        peak: Number(m.peak) || 0,
        total: m.total | 0,
        ok: m.ok | 0,
        failed: m.failed | 0,
      });
    } else if (m.t === "cors" && typeof m.origin === "string" && typeof m.host === "string") {
      // Solo para el origen real de este frame, solo si estás amplificando
      // y con un límite de pedidos para que la página no pueda abusar.
      const now = Date.now();
      const amped = settings && (settings.gain > 1.005 || settings.boost > 0);
      if (m.origin !== location.origin || !amped || corsCount >= MAX_CORS ||
          now - lastCors < 300 || !/^[a-z0-9.-]{1,253}$/i.test(m.host)) {
        toEngine({ t: "reply", id: m.id, ok: false });
        return;
      }
      lastCors = now;
      corsCount++;
      const sent = send({ type: "CORS", origin: location.origin, host: m.host, site: SITE }, (res) =>
        toEngine({ t: "reply", id: m.id, ok: !!(res && res.ok) })
      );
      if (!sent) toEngine({ t: "reply", id: m.id, ok: false });
    }
  });

  // ------------------------------------------------------------ ajustes

  function setSettings(saved) {
    const s = saved && typeof saved === "object" ? saved : {};
    settings = {
      gain: Math.max(0, Math.min(6, Number(s.gain ?? 1) || 0)),
      boost: Math.max(0, Math.min(12, Number(s.boost) || 0)),
      limiter: s.limiter !== false,
    };
    toEngine({ t: "settings", s: settings });
    if (IS_TOP) send({ type: "BADGE", gain: settings.gain });
  }

  try {
    // "pinned" (mismo volumen en todos los sitios) tiene prioridad sobre
    // el ajuste de cada sitio.
    let site = null;
    let pin = null;
    const refresh = () => setSettings(pin || site);

    chrome.storage.local.get([KEY, "pinned"], (data) => {
      if (chrome.runtime.lastError || !data) return;
      site = data[KEY] || null;
      pin = data.pinned || null;
      refresh();
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !alive()) return;
      if (!changes[KEY] && !changes.pinned) return;
      if (changes[KEY]) site = changes[KEY].newValue || null;
      if (changes.pinned) pin = changes.pinned.newValue || null;
      refresh();
    });

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || !alive()) return;
      if (msg.type === "METER_ON") {
        meterUntil = Date.now() + 3000;
        toEngine({ t: "meter" });
        sendResponse({ ok: true });
      }
    });
  } catch (e) {
    dead = true;
  }
})();
