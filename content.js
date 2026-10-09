// content.js — Ducky 3.0
// Amplifica <video> y <audio> con Web Audio para pasar del 100 % que permite
// HTML5. Una sola cadena compartida por frame:
//   fuentes → graves → ganancia → limitador → salida (+ analizador)
//
// Cambios frente a 2.0 (causas de errores en sesiones largas):
//  · Ya no se crea un AudioContext en cada iframe ni antes de que el usuario
//    interactúe (avisos "AudioContext was not allowed to start").
//  · No se enrutan medios de otro dominio sin CORS: Chrome los deja mudos y
//    llena la consola con "MediaElementAudioSource outputs zeroes…".
//  · Una cadena compartida en vez de 4 nodos por video: en sitios con scroll
//    infinito los nodos ya no se acumulan sin límite.
//  · Los videos retirados de la página se desconectan y el contexto se
//    suspende cuando no suena nada (CPU en reposo).
//  · Sin MutationObserver sobre todo el documento.
//  · Se detecta "Extension context invalidated" (extensión recargada o
//    actualizada) y el script deja de llamar a la API de Chrome.
//  · Los iframes (p. ej. un YouTube incrustado) usan el ajuste del sitio que
//    estás viendo, no el del dominio del iframe.

(() => {
  "use strict";

  if (window.__ducky3__) return;
  window.__ducky3__ = true;

  const DEFAULTS = { gain: 1, boost: 0, limiter: true };
  const IS_TOP = window.top === window;
  const SITE = topHost();
  const KEY = `site:${SITE}`;

  const state = { ...DEFAULTS };

  let ctx = null;
  let chain = null; // nodos compartidos
  const sourceOf = new WeakMap(); // elemento → MediaElementAudioSourceNode
  const connected = new Set(); // elementos cuya fuente está conectada a la cadena
  const blocked = new WeakSet(); // elementos que no se pueden enrutar
  const listening = new WeakSet(); // elementos con oyentes propios
  let sweepTimer = null;
  let idleTimer = null;
  let meterTimer = null;
  let meterUntil = 0;
  let dead = false;

  // ------------------------------------------------------------ utilidades

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
    shutdown();
    return false;
  }

  function shutdown() {
    dead = true;
    clearInterval(meterTimer);
    clearInterval(sweepTimer);
    clearTimeout(idleTimer);
    meterTimer = sweepTimer = idleTimer = null;
  }

  const needsGraph = () => state.gain > 1.005 || state.boost > 0;
  const mediaList = () => document.querySelectorAll("video, audio");

  function hasActivation() {
    try {
      if (navigator.getAutoplayPolicy &&
          navigator.getAutoplayPolicy("audiocontext") === "allowed") return true;
    } catch (e) {}
    const ua = navigator.userActivation;
    return ua ? ua.hasBeenActive : true;
  }

  // true: se puede enrutar · false: nunca · null: aún no se sabe (sin src)
  function routable(el) {
    if (el.srcObject) return true;
    const src = el.currentSrc || el.src;
    if (!src) return null;
    if (/^(blob|data|mediastream):/i.test(src)) return true;
    try {
      const u = new URL(src, location.href);
      if (u.origin === location.origin) return true;
    } catch (e) {
      return false;
    }
    // Otro dominio: solo funciona si el elemento pidió CORS (y cargó).
    return el.hasAttribute("crossorigin");
  }

  // ---------------------------------------------------------------- audio

  function ensureCtx() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
    } catch (e) {
      return null;
    }

    const bass = ctx.createBiquadFilter();
    bass.type = "lowshelf";
    bass.frequency.value = 180;

    const gain = ctx.createGain();

    const comp = ctx.createDynamicsCompressor();
    comp.knee.value = 0;
    comp.attack.value = 0.003;
    comp.release.value = 0.12;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;

    bass.connect(gain);
    gain.connect(comp);
    comp.connect(ctx.destination);
    comp.connect(analyser);

    chain = { bass, gain, comp, analyser, buf: new Float32Array(analyser.fftSize) };
    tune(true);

    sweepTimer = setInterval(sweep, 20000);
    return ctx;
  }

  function tune(instant) {
    if (!chain) return;
    const t = ctx.currentTime;
    const g = state.gain;
    const b = state.boost;
    if (instant) {
      chain.gain.gain.value = g;
      chain.bass.gain.value = b;
    } else {
      chain.gain.gain.setTargetAtTime(g, t, 0.03);
      chain.bass.gain.setTargetAtTime(b, t, 0.05);
    }
    // Con todo en reposo el compresor queda neutro: el audio pasa intacto.
    const limit = state.limiter && needsGraph();
    chain.comp.threshold.value = limit ? -3 : 0;
    chain.comp.ratio.value = limit ? 20 : 1;
  }

  function wake() {
    clearTimeout(idleTimer);
    idleTimer = null;
    if (ctx && ctx.state === "suspended" && hasActivation()) {
      ctx.resume().catch(() => {});
    }
  }

  // Suspende el contexto si no suena nada durante un rato.
  function scheduleIdle() {
    if (!ctx || idleTimer) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      for (const el of connected) if (!el.paused) return;
      if (ctx && ctx.state === "running") ctx.suspend().catch(() => {});
    }, 15000);
  }

  function watch(el) {
    if (listening.has(el)) return;
    listening.add(el);
    // Oyentes en el propio elemento: funcionan aunque esté fuera del DOM.
    el.addEventListener("play", () => { reconnect(el); wake(); });
    el.addEventListener("pause", scheduleIdle);
    el.addEventListener("ended", scheduleIdle);
  }

  function reconnect(el) {
    const src = sourceOf.get(el);
    if (!src || connected.has(el) || !chain) return;
    try {
      src.connect(chain.bass);
      connected.add(el);
    } catch (e) {}
  }

  // Engancha un elemento a la cadena. Devuelve true si quedó enrutado.
  function hook(el) {
    if (sourceOf.has(el)) {
      reconnect(el);
      return true;
    }
    if (blocked.has(el)) return false;

    const ok = routable(el);
    if (ok === false) {
      blocked.add(el);
      return false;
    }
    if (ok === null) return false; // se reintenta al reproducir
    // Sin interacción previa el contexto nacería suspendido y el video se
    // quedaría mudo: mejor dejarlo sonar normal hasta el primer gesto.
    if (!hasActivation()) return false;

    const c = ensureCtx();
    if (!c) return false;

    try {
      const src = c.createMediaElementSource(el);
      src.connect(chain.bass);
      sourceOf.set(el, src);
      connected.add(el);
      watch(el);
      wake();
      return true;
    } catch (e) {
      // InvalidStateError: la propia página ya enruta este elemento.
      blocked.add(el);
      return false;
    }
  }

  // Libera elementos que ya no están en la página y no suenan.
  function sweep() {
    for (const el of connected) {
      if (!el.isConnected && el.paused) {
        try {
          sourceOf.get(el).disconnect();
        } catch (e) {}
        connected.delete(el);
      }
    }
    let playing = false;
    for (const el of connected) if (!el.paused) playing = true;
    if (!playing) scheduleIdle();
  }

  function apply() {
    if (needsGraph()) {
      mediaList().forEach((el) => {
        if (!el.paused || sourceOf.has(el)) hook(el);
      });
    }
    tune(false);
  }

  function onPlay(e) {
    const el = e.target;
    if (!el || (el.tagName !== "VIDEO" && el.tagName !== "AUDIO")) return;
    if (needsGraph() || sourceOf.has(el)) hook(el);
    wake();
  }
  document.addEventListener("play", onPlay, true);
  document.addEventListener("playing", onPlay, true);

  // Primer gesto del usuario: ahora sí se puede crear/reanudar el contexto.
  function onGesture() {
    if (needsGraph()) apply();
    wake();
  }
  ["pointerdown", "keydown"].forEach((ev) =>
    window.addEventListener(ev, onGesture, { capture: true, passive: true })
  );

  // ----------------------------------------------------------- medición

  function status() {
    let total = 0;
    let ok = 0;
    let failed = 0;
    mediaList().forEach((el) => {
      total++;
      if (connected.has(el)) ok++;
      else if (blocked.has(el) || routable(el) === false) failed++;
    });
    return { total, ok, failed };
  }

  function peak() {
    if (!chain || !ctx || ctx.state !== "running") return 0;
    let playing = false;
    for (const el of connected) if (!el.paused && !el.muted) playing = true;
    if (!playing) return 0;
    chain.analyser.getFloatTimeDomainData(chain.buf);
    let max = 0;
    for (let i = 0; i < chain.buf.length; i += 2) {
      const d = Math.abs(chain.buf[i]);
      if (d > max) max = d;
    }
    return Math.min(max, 1);
  }

  function send(msg) {
    if (!alive()) return false;
    try {
      chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
      return true;
    } catch (e) {
      return false;
    }
  }

  function startMeter() {
    meterUntil = Date.now() + 2500;
    if (meterTimer) return;
    meterTimer = setInterval(() => {
      const s = status();
      // Frames sin medios (anuncios, widgets) no envían nada.
      if (Date.now() > meterUntil || (!IS_TOP && s.total === 0) ||
          !send({ type: "METER", peak: peak(), ...s })) {
        clearInterval(meterTimer);
        meterTimer = null;
      }
    }, 120);
  }

  // ------------------------------------------------------------ ajustes

  function setState(saved) {
    Object.assign(state, DEFAULTS, saved || {});
    state.gain = Math.max(0, Math.min(6, Number(state.gain) || 0));
    apply();
    if (IS_TOP) send({ type: "BADGE", gain: state.gain });
  }

  function load() {
    if (!alive()) return;
    try {
      chrome.storage.local.get(KEY, (data) => {
        if (chrome.runtime.lastError || !data) return;
        setState(data[KEY]);
      });
    } catch (e) {
      shutdown();
    }
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[KEY] || !alive()) return;
      setState(changes[KEY].newValue);
    });

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || !alive()) return;
      if (msg.type === "METER_ON") {
        startMeter();
        sendResponse({ ok: true });
      }
    });
  } catch (e) {
    shutdown();
  }

  load();
})();
