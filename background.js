// background.js — Ducky 3.2
// Insignia con el porcentaje, atajos de teclado y permiso CORS temporal
// para amplificar videos servidos desde otro dominio.

const DEFAULTS = { gain: 1, boost: 0, limiter: true };
const STEP = 0.25;
const MAX = 6;
const MAX_RULES = 200;

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

// ---------------------------------------------------------- permiso CORS
// Regla de sesión limitada a: esta pestaña, este origen que pide el video
// y el servidor del video, solo para peticiones de audio/video. Solo se
// concede si el usuario está amplificando ese sitio.

function ruleId(tabId, origin, host) {
  let h = 2166136261;
  const s = `${tabId}|${origin}|${host}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 1) % 2000000000 + 1;
}

async function allowCors(tabId, origin, host) {
  const id = ruleId(tabId, origin, host);
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  if (rules.some((r) => r.id === id)) return true;

  const removeRuleIds = rules.length >= MAX_RULES ? [rules[0].id] : [];
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds,
    addRules: [
      {
        id,
        priority: 1,
        action: {
          type: "modifyHeaders",
          responseHeaders: [
            { header: "access-control-allow-origin", operation: "set", value: origin },
            { header: "access-control-allow-credentials", operation: "set", value: "true" },
          ],
        },
        condition: {
          tabIds: [tabId],
          initiatorDomains: [new URL(origin).hostname],
          requestDomains: [host],
          resourceTypes: ["media"],
        },
      },
    ],
  });
  return true;
}

async function handleCors(msg, sender) {
  const tab = sender.tab;
  if (!tab || tab.id === undefined || tab.id < 0) return false;

  // El sitio se toma de la pestaña, no de lo que diga la página.
  const site = hostOf(tab.url || "");
  if (!site) return false;
  const key = `site:${site}`;
  const data = await chrome.storage.local.get(key);
  const s = { ...DEFAULTS, ...(data[key] || {}) };
  if (!(s.gain > 1.005 || s.boost > 0)) return false;

  let origin;
  try {
    const u = new URL(msg.origin);
    if (!/^https?:$/.test(u.protocol)) return false;
    origin = u.origin;
    // El origen debe ser el del frame que envía el mensaje.
    if (sender.origin && sender.origin !== origin) return false;
  } catch (e) {
    return false;
  }

  const host = String(msg.host || "").toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host)) return false;

  return allowCors(tab.id, origin, host);
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const ids = rules
      .filter((r) => r.condition.tabIds && r.condition.tabIds.includes(tabId))
      .map((r) => r.id);
    if (ids.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
  } catch (e) {}
});

// ------------------------------------------------------------- mensajes

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === "BADGE" && sender.tab && sender.tab.id !== undefined &&
      sender.frameId === 0) {
    setBadge(sender.tab.id, Number(msg.gain) || 0);
    return;
  }

  if (msg.type === "CORS") {
    handleCors(msg, sender)
      .then((ok) => sendResponse({ ok }))
      .catch(() => sendResponse({ ok: false }));
    return true; // respuesta asíncrona
  }
});

// ---------------------------------------------------------------- atajos

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
    // content.js escucha storage.onChanged y aplica el cambio solo.
    await chrome.storage.local.set({ [key]: { ...current, gain } });
    setBadge(tab.id, gain);
  } catch (e) {
    /* pestaña cerrada o sin acceso */
  }
});
