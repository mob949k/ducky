// background.js — Ducky 3.0
// Insignia con el porcentaje activo y atajos de teclado.

const DEFAULTS = { gain: 1, boost: 0, limiter: true };
const STEP = 0.25;
const MAX = 6;

function hostOf(url) {
  try {
    const u = new URL(url);
    if (!/^(https?|file):$/.test(u.protocol)) return null;
    return u.hostname || "local";
  } catch (e) {
    return null;
  }
}

function setBadge(tabId, gain) {
  const pct = Math.round(gain * 100);
  const text = pct === 100 ? "" : String(Math.min(pct, 999));
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action
    .setBadgeBackgroundColor({ tabId, color: pct > 100 ? "#F08A3C" : "#2B3350" })
    .catch(() => {});
  if (chrome.action.setBadgeTextColor) {
    chrome.action
      .setBadgeTextColor({ tabId, color: pct > 100 ? "#1C2236" : "#FBF6EC" })
      .catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === "BADGE" && sender.tab && sender.tab.id !== undefined &&
      sender.frameId === 0) {
    setBadge(sender.tab.id, Number(msg.gain) || 0);
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id === undefined) return;
    const host = hostOf(tab.url);
    if (!host) return;

    const key = `site:${host}`;
    const data = await chrome.storage.local.get(key);
    const current = { ...DEFAULTS, ...(data[key] || {}) };
    let gain = current.gain;

    if (command === "volume-up") gain = Math.min(MAX, gain + STEP);
    else if (command === "volume-down") gain = Math.max(0, gain - STEP);
    else if (command === "volume-reset") gain = 1;
    else return;

    gain = Math.round(gain * 100) / 100;
    // El content script escucha storage.onChanged y aplica el cambio solo.
    await chrome.storage.local.set({ [key]: { ...current, gain } });
    setBadge(tab.id, gain);
  } catch (e) {
    /* pestaña cerrada o sin acceso: no hay nada que hacer */
  }
});
