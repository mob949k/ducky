// engine.js — Ducky 3.2 · motor de audio (corre en el "mundo" de la página)
//
// Corre dentro de la página para poder ver todos los reproductores:
//  · <video>/<audio> normales, los que están dentro de componentes
//    (shadow DOM, abiertos o cerrados) y los creados con new Audio()
//    sin insertarlos en la página.
//  · Reproductores que usan Web Audio por su cuenta: se intercepta su
//    conexión a los altavoces y se pasa por la cadena de Ducky.
//  · Videos servidos desde otro dominio (CDN de los servicios de
//    reproductores): se recargan en modo CORS, con permiso que añade
//    background.js, para poder amplificarlos sin dejarlos mudos.
//
// Se comunica con content.js (que sí tiene acceso a la API de Chrome)
// mediante eventos "ducky:cmd" / "ducky:evt" con texto JSON.

(() => {
  "use strict";

  const FLAG = Symbol.for("ducky.engine");
  if (window[FLAG]) return;
  try {
    Object.defineProperty(window, FLAG, { value: true });
  } catch (e) {
    return;
  }

  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC || !window.AudioNode || !window.HTMLMediaElement) return;

  // ---- referencias originales (antes de que la página pueda tocarlas) ----
  const OAC = window.OfflineAudioContext;
  const ADN = window.AudioDestinationNode;
  const BAC = (window.BaseAudioContext || AC).prototype;
  const NODE = AudioNode.prototype;
  const MEDIA = HTMLMediaElement.prototype;

  const nConnect = NODE.connect;
  const nDisconnect = NODE.disconnect;
  const nPlay = MEDIA.play;
  const nLoad = MEDIA.load;
  const nAttachShadow = Element.prototype.attachShadow;
  const nAdd = EventTarget.prototype.addEventListener;
  const nDispatch = EventTarget.prototype.dispatchEvent;
  const nCreateGain = BAC.createGain;
  const nCreateBiquad = BAC.createBiquadFilter;
  const nCreateComp = BAC.createDynamicsCompressor;
  const nCreateAnalyser = BAC.createAnalyser;
  const nCreateMES = AC.prototype.createMediaElementSource;
  const getDest = Object.getOwnPropertyDescriptor(BAC, "destination").get;
  const getNodeCtx = Object.getOwnPropertyDescriptor(NODE, "context").get;
  const CE = window.CustomEvent;
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const setT = window.setTimeout.bind(window);
  const clearT = window.clearTimeout.bind(window);
  const setI = window.setInterval.bind(window);
  const clearI = window.clearInterval.bind(window);

  const on = (target, type, fn, opts) => nAdd.call(target, type, fn, opts);

  // ---------------------------------------------------------------- ajustes

  const DEFAULTS = { gain: 1, boost: 0, limiter: true };
  const state = { ...DEFAULTS };
  const needsGraph = () => state.gain > 1.005 || state.boost > 0;

  // ------------------------------------------------------------- cadenas
  // Cada contexto de audio tiene una entrada que, en reposo, va directo a
  // los altavoces (sin coste). Al amplificar se reconecta así:
  //   entrada → graves → ganancia → limitador → altavoces (+ analizador)

  const chains = new Set();

  function makeChain(ctx, page) {
    const c = {
      ctx,
      page,
      used: false,
      active: null,
      input: nCreateGain.call(ctx),
      bass: nCreateBiquad.call(ctx),
      gain: nCreateGain.call(ctx),
      comp: nCreateComp.call(ctx),
      analyser: nCreateAnalyser.call(ctx),
    };
    c.bass.type = "lowshelf";
    c.bass.frequency.value = 180;
    c.comp.knee.value = 0;
    c.comp.attack.value = 0.003;
    c.comp.release.value = 0.12;
    c.analyser.fftSize = 512;
    c.buf = new Float32Array(c.analyser.fftSize);
    nConnect.call(c.bass, c.gain);
    nConnect.call(c.gain, c.comp);
    chains.add(c);
    route(c);
    return c;
  }

  function cut(node) {
    try {
      nDisconnect.call(node);
    } catch (e) {}
  }

  function route(c) {
    const want = needsGraph();
    if (c.active !== want) {
      c.active = want;
      const dest = getDest.call(c.ctx);
      cut(c.input);
      cut(c.comp);
      if (want) {
        nConnect.call(c.input, c.bass);
        nConnect.call(c.comp, dest);
        nConnect.call(c.comp, c.analyser);
      } else {
        nConnect.call(c.input, dest);
        nConnect.call(c.input, c.analyser);
      }
      tune(c, true);
    } else {
      tune(c, false);
    }
  }

  function tune(c, instant) {
    try {
      const t = c.ctx.currentTime;
      if (instant) {
        c.gain.gain.value = state.gain;
        c.bass.gain.value = state.boost;
      } else {
        c.gain.gain.setTargetAtTime(state.gain, t, 0.03);
        c.bass.gain.setTargetAtTime(state.boost, t, 0.05);
      }
      const limit = state.limiter && needsGraph();
      c.comp.threshold.value = limit ? -3 : 0;
      c.comp.ratio.value = limit ? 20 : 1;
    } catch (e) {}
  }

  // --------------------------------- Web Audio de la propia página
  // Lo que la página conecta a los altavoces pasa por su cadena de Ducky.

  const pageChains = new WeakMap();

  function pageChainFor(dest) {
    if (!ADN || !(dest instanceof ADN)) return null;
    const ctx = getNodeCtx.call(dest);
    if (!ctx || (OAC && ctx instanceof OAC) || ctx === own) return null;
    if (getDest.call(ctx) !== dest) return null;
    let c = pageChains.get(ctx);
    if (!c) {
      c = makeChain(ctx, true);
      pageChains.set(ctx, c);
    }
    return c;
  }

  NODE.connect = {
    connect(dest, ...rest) {
      let c = null;
      try {
        c = pageChainFor(dest);
      } catch (e) {}
      if (c) {
        c.used = true;
        nConnect.call(this, c.input, ...rest);
        return dest;
      }
      return nConnect.call(this, dest, ...rest);
    },
  }.connect;

  NODE.disconnect = {
    disconnect(...args) {
      try {
        const d = args[0];
        if (ADN && d instanceof ADN) {
          const c = pageChains.get(getNodeCtx.call(d));
          if (c) args[0] = c.input;
        }
      } catch (e) {}
      return nDisconnect.apply(this, args);
    },
  }.disconnect;

  // ------------------------------------------------- <video> y <audio>

  let own = null; // contexto propio para los elementos
  let ownChain = null;
  let pendingGesture = false;
  let idleTimer = null;

  const seen = new Set(); // elementos vistos reproduciendo
  const watched = new WeakSet();
  const sourceOf = new WeakMap();
  const connected = new Set();
  const viaPage = new WeakSet(); // la página ya los enruta por Web Audio
  const blocked = new WeakSet(); // no se pudieron amplificar
  const hooking = new WeakSet();
  const corsTried = new WeakSet();
  const swapping = new WeakMap(); // recarga en curso en modo CORS
  const corsBusy = new WeakSet(); // desde que se pide el permiso hasta que termina

  async function running() {
    if (!own) {
      try {
        own = new AC();
      } catch (e) {
        return false;
      }
      ownChain = makeChain(own, false);
    }
    if (own.state === "running") return true;
    if (own.state === "closed") return false;
    try {
      await Promise.race([own.resume(), new Promise((r) => setT(r, 400))]);
    } catch (e) {}
    return own.state === "running";
  }

  // true: se puede · false: otro dominio sin CORS · null: aún sin fuente
  function routable(el) {
    if (el.srcObject) return true;
    const src = el.currentSrc || el.src;
    if (!src) return null;
    if (/^(blob|data|mediastream):/i.test(src)) return true;
    try {
      if (new URL(src, location.href).origin === location.origin) return true;
    } catch (e) {
      return false;
    }
    return el.crossOrigin !== null;
  }

  function onMedia(el) {
    if (!(el instanceof HTMLMediaElement)) return;
    seen.add(el);
    watch(el);
    if (sourceOf.has(el)) {
      reconnect(el);
      wake();
    } else if (needsGraph()) {
      hook(el);
    }
  }

  function watch(el) {
    if (watched.has(el)) return;
    watched.add(el);
    // En el propio elemento: funciona aunque esté en un shadow DOM o fuera
    // de la página.
    on(el, "playing", () => onMedia(el));
    on(el, "pause", scheduleIdle);
    on(el, "ended", scheduleIdle);
  }

  async function hook(el) {
    if (sourceOf.has(el) || viaPage.has(el) || blocked.has(el) || hooking.has(el)) return;
    const rec = swapping.get(el);
    if (rec && !rec.ok) return;

    const r = routable(el);
    if (r === null) return; // se reintenta con "playing"
    if (r === false) {
      corsify(el);
      return;
    }

    hooking.add(el);
    try {
      if (!(await running())) {
        pendingGesture = true; // se reintenta tras el primer clic o tecla
        return;
      }
      if (sourceOf.has(el)) return;
      const src = nCreateMES.call(own, el);
      nConnect.call(src, ownChain.input);
      sourceOf.set(el, src);
      connected.add(el);
      wake();
    } catch (e) {
      // InvalidStateError: la página ya conectó este elemento a su propio
      // Web Audio, que ya pasa por la cadena de Ducky.
      if (e && e.name === "InvalidStateError") viaPage.add(el);
      else blocked.add(el);
    } finally {
      hooking.delete(el);
    }
  }

  function reconnect(el) {
    const src = sourceOf.get(el);
    if (!src || connected.has(el) || !ownChain) return;
    try {
      nConnect.call(src, ownChain.input);
      connected.add(el);
    } catch (e) {}
  }

  // ------------------------------------------- videos de otro dominio
  // Se pide a background.js permiso CORS para este origen y se recarga el
  // video en modo CORS, conservando la posición. Durante la recarga se
  // ocultan al reproductor los eventos intermedios para que no parpadee.
  // Si falla, se vuelve al modo normal y el video suena sin amplificar.

  const SWAP_EVENTS = [
    "abort", "emptied", "loadstart", "error", "waiting", "stalled", "suspend",
    "durationchange", "loadedmetadata", "loadeddata", "canplay",
    "canplaythrough", "seeking", "seeked", "timeupdate", "pause", "play",
    "playing", "ratechange", "progress",
  ];
  const guarded = new WeakSet(); // eventos ya atendidos en window

  function corsify(el) {
    if (corsBusy.has(el)) return; // ya en curso
    if (corsTried.has(el) || el.crossOrigin !== null || location.origin === "null") {
      blocked.add(el);
      return;
    }
    corsTried.add(el);
    corsBusy.add(el);
    let host = "";
    try {
      host = new URL(el.currentSrc || el.src, location.href).hostname;
    } catch (e) {}
    if (!host) {
      corsBusy.delete(el);
      blocked.add(el);
      return;
    }
    ask("cors", { origin: location.origin, host }).then((ok) => {
      if (ok && !el.error) {
        swap(el);
      } else {
        corsBusy.delete(el);
        blocked.add(el);
      }
    });
  }

  function swap(el) {
    const rec = {
      t: el.currentTime || 0,
      play: !el.paused,
      rate: el.playbackRate || 1,
      phase: "cors",
      ok: false,
      timer: setT(() => endSwap(el), 10000),
    };
    swapping.set(el, rec);

    // Para elementos en shadow DOM o fuera de la página, que window no ve.
    SWAP_EVENTS.forEach((type) =>
      on(el, type, (e) => {
        if (!guarded.has(e)) swapEvent(el, e.type);
      })
    );

    try {
      el.crossOrigin = "use-credentials";
      nLoad.call(el);
    } catch (e) {
      endSwap(el);
      blocked.add(el);
    }
  }

  function swapEvent(el, type) {
    const rec = swapping.get(el);
    if (!rec) return;

    if (type === "error") {
      if (rec.phase === "cors") {
        rec.phase = "revert";
        try {
          el.removeAttribute("crossorigin");
          nLoad.call(el);
        } catch (e) {
          endSwap(el);
        }
      } else {
        endSwap(el);
      }
      return;
    }

    if (type === "loadedmetadata") {
      try {
        if (rec.t) el.currentTime = rec.t;
        el.playbackRate = rec.rate;
      } catch (e) {}
      if (rec.phase === "cors") {
        rec.ok = true;
        hook(el); // se engancha antes de que vuelva a sonar
      } else {
        blocked.add(el);
      }
      if (rec.play) nPlay.call(el).catch(() => {});
      else rec.settle = true;
      return;
    }

    if (type === "playing" || (rec.settle && type === "canplay")) endSwap(el);
  }

  function endSwap(el) {
    const rec = swapping.get(el);
    if (!rec) return;
    clearT(rec.timer);
    swapping.delete(el);
    corsBusy.delete(el);
    if (!rec.ok) blocked.add(el);
  }

  // Se registra antes que cualquier oyente de la página (document_start).
  SWAP_EVENTS.forEach((type) =>
    on(window, type, (e) => {
      const el = e.target;
      if (!swapping.has(el)) return;
      guarded.add(e);
      swapEvent(el, type);
      e.stopImmediatePropagation();
    }, true)
  );

  // ----------------------------------------------- detectar reproducción

  const onPlayEvent = (e) => onMedia(e.target);
  on(window, "play", onPlayEvent, true);
  on(window, "playing", onPlayEvent, true);

  // Componentes con shadow DOM (abiertos o cerrados): sus eventos "play"
  // no salen al documento, así que se escuchan dentro de cada raíz.
  if (nAttachShadow) {
    Element.prototype.attachShadow = {
      attachShadow(init) {
        const root = nAttachShadow.call(this, init);
        try {
          on(root, "play", onPlayEvent, true);
          on(root, "playing", onPlayEvent, true);
        } catch (e) {}
        return root;
      },
    }.attachShadow;
  }

  // new Audio() o elementos que nunca se insertan en la página.
  // Si Ducky recarga el video en modo CORS, el play() que pidió la página
  // se interrumpe. En vez de devolverle un error, se espera a que vuelva a
  // sonar, para que el reproductor no crea que falló.
  MEDIA.play = {
    play() {
      try {
        onMedia(this);
      } catch (e) {}
      const el = this;
      return nPlay.call(el).catch((err) => {
        if (err && err.name === "AbortError" && corsBusy.has(el)) return untilPlaying(el, err);
        throw err;
      });
    },
  }.play;

  function untilPlaying(el, err) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        if (!el.paused && el.readyState > 2) return resolve();
        if (!corsBusy.has(el) || Date.now() - t0 > 12000) {
          return el.paused ? reject(err) : resolve();
        }
        setT(tick, 100);
      };
      tick();
    });
  }

  // Primer gesto: ahora el navegador deja arrancar el audio.
  const onGesture = () => {
    if (pendingGesture) {
      pendingGesture = false;
      apply();
    }
    wake();
  };
  on(window, "pointerdown", onGesture, { capture: true, passive: true });
  on(window, "keydown", onGesture, { capture: true, passive: true });

  // ---------------------------------------------------------- aplicar

  function allMedia() {
    const set = new Set(seen);
    try {
      document.querySelectorAll("video, audio").forEach((el) => set.add(el));
    } catch (e) {}
    return set;
  }

  function apply() {
    chains.forEach(route);
    if (needsGraph()) {
      allMedia().forEach((el) => {
        if (!el.paused || sourceOf.has(el)) {
          watch(el);
          hook(el);
        }
      });
    }
  }

  // ------------------------------------------------- reposo y limpieza

  function anyPlaying() {
    for (const el of connected) if (!el.paused) return true;
    return false;
  }

  function wake() {
    clearT(idleTimer);
    idleTimer = null;
    if (own && own.state === "suspended") own.resume().catch(() => {});
  }

  function scheduleIdle() {
    if (!own || idleTimer) return;
    idleTimer = setT(() => {
      idleTimer = null;
      if (!anyPlaying() && own.state === "running") own.suspend().catch(() => {});
    }, 60000);
  }

  setI(() => {
    for (const el of seen) {
      if (!el.isConnected && el.paused) {
        seen.delete(el);
        if (connected.has(el)) {
          cut(sourceOf.get(el));
          connected.delete(el);
        }
      }
    }
    for (const c of chains) {
      if (c.ctx.state === "closed") chains.delete(c);
    }
    if (!anyPlaying()) scheduleIdle();
  }, 20000);

  // ----------------------------------------------------------- medición

  function status() {
    let total = 0;
    let ok = 0;
    let failed = 0;
    allMedia().forEach((el) => {
      if (!el.isConnected && el.paused) return;
      total++;
      if (connected.has(el) || viaPage.has(el)) ok++;
      else if (blocked.has(el)) failed++;
    });
    for (const c of chains) {
      if (c.page && c.used && c.ctx.state === "running") {
        total++;
        ok++;
      }
    }
    return { total, ok, failed };
  }

  function peak() {
    let max = 0;
    for (const c of chains) {
      if (c.ctx.state !== "running") continue;
      if (!c.page && !anyPlaying()) continue;
      c.analyser.getFloatTimeDomainData(c.buf);
      for (let i = 0; i < c.buf.length; i += 2) {
        const v = Math.abs(c.buf[i]);
        if (v > max) max = v;
      }
    }
    return Math.min(max, 1);
  }

  let meterTimer = null;
  let meterUntil = 0;

  function startMeter() {
    meterUntil = Date.now() + 2500;
    if (meterTimer) return;
    meterTimer = setI(() => {
      if (Date.now() > meterUntil) {
        clearI(meterTimer);
        meterTimer = null;
        return;
      }
      emit({ t: "status", peak: peak(), ...status() });
    }, 120);
  }

  // ------------------------------------------------------------- puente

  let askId = 0;
  const asks = new Map();

  function emit(msg) {
    try {
      nDispatch.call(window, new CE("ducky:evt", { detail: stringify(msg) }));
    } catch (e) {}
  }

  function ask(t, data) {
    return new Promise((resolve) => {
      const id = ++askId;
      const timer = setT(() => {
        asks.delete(id);
        resolve(false);
      }, 4000);
      asks.set(id, (v) => {
        clearT(timer);
        resolve(v);
      });
      emit({ t, id, ...data });
    });
  }

  on(window, "ducky:cmd", (e) => {
    let m;
    try {
      m = parse(e.detail);
    } catch (err) {
      return;
    }
    if (!m) return;
    if (m.t === "settings") {
      Object.assign(state, DEFAULTS, m.s || {});
      state.gain = Math.max(0, Math.min(6, Number(state.gain) || 0));
      state.boost = Math.max(0, Math.min(12, Number(state.boost) || 0));
      apply();
    } else if (m.t === "meter") {
      startMeter();
    } else if (m.t === "reply" && asks.has(m.id)) {
      const done = asks.get(m.id);
      asks.delete(m.id);
      done(!!m.ok);
    }
  });

  emit({ t: "hello" });
})();
