// popup.js — Ducky 3.1

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
  slider: $("slider"),
  up: $("up"),
  down: $("down"),
  chips: document.querySelectorAll(".chip"),
  limiter: $("limiter"),
  boost: $("boost"),
  reset: $("reset"),
  note: $("note"),
};

let tabId = null;
let siteKey = null;
let settings = { ...DEFAULTS };
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
  el.value.innerHTML = `${pct}<small>%</small>`;
  el.slider.value = pct;
  el.slider.style.setProperty("--fill", `${(pct / MAX) * 100}%`);
  el.app.classList.toggle("amped", pct > 100);

  el.chips.forEach((b) => b.classList.toggle("on", Number(b.dataset.val) === pct));
  el.limiter.setAttribute("aria-pressed", String(!!settings.limiter));
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
  const amped = settings.gain > 1 || settings.boost > 0;

  if (!supported) text = "Chrome no permite extensiones en esta página.";
  else if (!reachable) text = "Recarga la página para activar Ducky.";
  else if (amped && failed > 0) text = "Un video de otro sitio no se puede amplificar.";
  else if (amped && total > 0 && ok === 0) text = "Dale play para amplificar.";

  el.note.hidden = !text;
  if (el.note.textContent !== text) el.note.textContent = text;
}

// ---------------------------------------------------------------- guardado

function save() {
  if (!siteKey) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.local.set({ [siteKey]: { ...settings } }).catch(() => {});
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

render();

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs && tabs[0];
  if (!tab) return;
  tabId = tab.id;

  const host = hostOf(tab.url || "");
  supported = !!host;
  siteKey = host ? `site:${host}` : null;
  el.site.textContent = host === "local" ? "Archivo local"
    : host ? host.replace(/^www\./, "") : "Página del navegador";
  el.site.title = host || "";
  el.app.classList.toggle("off", !supported);

  if (!supported) {
    probed = true;
    note(0, 0, 0);
    return;
  }

  chrome.storage.local.get(siteKey, (data) => {
    settings = { ...DEFAULTS, ...((data && data[siteKey]) || {}) };
    render();
  });

  pingFrames();
  setInterval(pingFrames, 900);
  setInterval(renderLevel, 100);
});
