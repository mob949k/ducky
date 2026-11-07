// popup.js — Ducky 3.5

const DEFAULTS = { gain: 1, boost: 0, limiter: true };
const BOOST_DB = 8;
const MAX = 600;
const STEP = 5;
const JUMP = 25;

const $ = (id) => document.getElementById(id);
const el = {
  app: $("app"),
  site: $("site"),
  duck: $("duck"),
  pulse: $("pulse"),
  value: $("value"),
  num: null,
  slider: $("slider"),
  up: $("up"),
  down: $("down"),
  chips: document.querySelectorAll(".chip"),
  limiter: $("limiter"),
  boost: $("boost"),
  reset: $("reset"),
  pin: $("pin"),
  settings: $("settings"),
  pitch: $("pitch"),
  note: $("note"),
  noteText: $("note-text"),
  reload: $("reload"),
};

const PIN_KEY = "pinned"; // mismo volumen en todos los sitios
let pinned = false;

let tabId = null;
let siteKey = null;
let settings = { ...DEFAULTS };

// Valores guardados: siempre dentro de rango, aunque estén dañados.
function clean(saved) {
  const s = saved && typeof saved === "object" ? saved : {};
  return {
    gain: Math.max(0, Math.min(6, Number(s.gain ?? 1) || 0)),
    boost: s.boost > 0 ? BOOST_DB : 0,
    limiter: s.limiter !== false,
  };
}
let saveTimer = null;
let shownPeak = 0;

const frames = new Map(); // frameId → { total, ok, failed, peak, t }
let reachable = false;
let probed = false;
let supported = true;

const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
const pctNow = () => Math.round(settings.gain * 100);

// ---------------------------------------------------------------- pintado

function render() {
  const pct = pctNow();
  // Sin innerHTML: solo nodos de texto.
  if (el.num.data !== String(pct)) el.num.data = String(pct);
  el.slider.value = pct;
  el.slider.style.setProperty("--fill", `${(pct / MAX) * 100}%`);
  el.app.classList.toggle("amped", pct > 100);

  el.chips.forEach((b) => b.classList.toggle("on", Number(b.dataset.val) === pct));
  el.limiter.setAttribute("aria-pressed", String(!!settings.limiter));
  el.pin.setAttribute("aria-pressed", String(pinned));
  el.pin.title = pinned ? "Using one volume on every site. Click to go back to per-site" : "Use this volume on every site";
  el.pitch.replaceChildren(
    pinned ? "Same volume on " : "Boost the volume of your browser up to ",
    Object.assign(document.createElement("b"), { textContent: pinned ? "every site" : "600%" })
  );
  el.boost.setAttribute("aria-pressed", String(settings.boost > 0));

  // El pato ladea el sombrero según cuánto subes.
  if (!still) {
    const tilt = pct <= 100 ? (pct - 100) * 0.05 : (pct - 100) * 0.018;
    el.duck.style.setProperty("--tilt", `${tilt.toFixed(2)}deg`);
  }
}

function renderLevel() {
  let peak = 0, total = 0, ok = 0, failed = 0;
  const now = Date.now();

  frames.forEach((f, id) => {
    if (now - f.t > 1500) return frames.delete(id);
    peak = Math.max(peak, f.peak);
    total += f.total;
    ok += f.ok;
    failed += f.failed;
  });

  // Sube rápido y cae despacio, como una aguja de VU.
  shownPeak = peak > shownPeak ? peak : shownPeak * 0.85;
  el.pulse.style.setProperty("--peak", shownPeak.toFixed(3));
  if (!still) el.pulse.style.setProperty("--spin", `${(shownPeak * 14).toFixed(1)}deg`);
  el.app.classList.toggle("quiet", shownPeak < 0.02);
  el.app.classList.toggle("clipping", peak > 0.97);

  if (probed) note(total, ok, failed);
}

// Solo se muestra un aviso cuando hay algo que hacer.
function note(total, ok, failed) {
  let text = "";
  let canReload = false;
  const amped = settings.gain > 1 || settings.boost > 0;

  if (!supported) text = "Chrome doesn't allow extensions on this page.";
  else if (!reachable) {
    text = "Reload the page to activate Ducky.";
    canReload = true;
  }
  else if (amped && failed > 0) text = "A video from another site can't be boosted.";
  else if (amped && total > 0 && ok === 0) text = "Press play to boost.";

  el.note.hidden = !text;
  el.reload.hidden = !canReload;
  if (el.noteText.textContent !== text) el.noteText.textContent = text;
}

// ---------------------------------------------------------------- guardado

function save() {
  if (!siteKey) return;
  const key = pinned ? PIN_KEY : siteKey;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.local.set({ [key]: { ...settings } }).catch(() => {});
  }, 60);
}

function setGain(pct) {
  pct = Math.round(Math.max(0, Math.min(MAX, pct)) / STEP) * STEP;
  if (pct === pctNow()) return;
  settings.gain = pct / 100;
  render();
  save();
}

// -------------------------------------------------------------- controles

el.slider.addEventListener("input", () => {
  let v = Number(el.slider.value);
  if (Math.abs(v - 100) <= 10) v = 100; // tope suave en el volumen original
  setGain(v);
});

el.slider.addEventListener("wheel", (e) => {
  e.preventDefault();
  setGain(pctNow() + (e.deltaY < 0 ? STEP : -STEP));
}, { passive: false });

el.up.addEventListener("click", () => setGain(pctNow() + JUMP));
el.down.addEventListener("click", () => setGain(pctNow() - JUMP));

el.chips.forEach((b) =>
  b.addEventListener("click", () => setGain(Number(b.dataset.val)))
);

el.limiter.addEventListener("click", () => {
  settings.limiter = !settings.limiter;
  render();
  save();
});

el.boost.addEventListener("click", () => {
  settings.boost = settings.boost > 0 ? 0 : BOOST_DB;
  render();
  save();
});

el.reset.addEventListener("click", () => {
  settings = { ...DEFAULTS };
  render();
  save();
});

// Pin: usar este volumen en todos los sitios (o volver al de cada sitio).
el.pin.addEventListener("click", async () => {
  if (!siteKey) return;
  clearTimeout(saveTimer);
  try {
    if (pinned) {
      pinned = false;
      await chrome.storage.local.remove(PIN_KEY);
      const data = await chrome.storage.local.get(siteKey);
      settings = clean(data[siteKey]);
    } else {
      pinned = true;
      await chrome.storage.local.set({ [PIN_KEY]: { ...settings } });
    }
  } catch (e) {}
  render();
});

el.settings.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

el.reload.addEventListener("click", () => {
  if (tabId !== null) chrome.tabs.reload(tabId);
  window.close();
});

// ---------------------------------------------------------------- medidor

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== "METER") return;
  if (!sender.tab || sender.tab.id !== tabId) return;
  reachable = true;
  frames.set(sender.frameId ?? 0, {
    total: msg.total | 0,
    ok: msg.ok | 0,
    failed: msg.failed | 0,
    peak: Number(msg.peak) || 0,
    t: Date.now(),
  });
});

function pingFrames() {
  if (tabId === null || !supported) return;
  chrome.tabs.sendMessage(tabId, { type: "METER_ON" }, () => {
    reachable = chrome.runtime.lastError ? frames.size > 0 : true;
    probed = true;
  });
}

// ---------------------------------------------------------------- arranque

function hostOf(url) {
  try {
    const u = new URL(url);
    if (!/^(https?|file):$/.test(u.protocol)) return null;
    return u.hostname || "local";
  } catch (e) {
    return null;
  }
}

el.num = document.createTextNode("100");
el.value.replaceChildren(el.num, Object.assign(document.createElement("small"), { textContent: "%" }));
render();

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs && tabs[0];
  if (!tab) return;
  tabId = tab.id;

  const host = hostOf(tab.url || "");
  supported = !!host;
  siteKey = host ? `site:${host}` : null;
  el.site.textContent = host === "local" ? "Local file"
    : host ? host.replace(/^www\./, "") : "Browser page";
  el.site.title = host || "";
  el.app.classList.toggle("off", !supported);

  if (!supported) {
    probed = true;
    note(0, 0, 0);
    render();
    return;
  }

  chrome.storage.local.get([siteKey, PIN_KEY], (data) => {
    pinned = !!(data && data[PIN_KEY]);
    settings = clean(data && (pinned ? data[PIN_KEY] : data[siteKey]));
    render();
  });

  // El medidor se pausa si la ventana no está visible.
  let timers = [];
  const startTimers = () => {
    if (timers.length) return;
    pingFrames();
    timers = [setInterval(pingFrames, 900), setInterval(renderLevel, 100)];
  };
  const stopTimers = () => {
    timers.forEach(clearInterval);
    timers = [];
  };
  document.addEventListener("visibilitychange", () =>
    document.hidden ? stopTimers() : startTimers()
  );
  startTimers();
});
