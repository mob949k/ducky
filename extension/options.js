// options.js — Ducky 3.5 · sitios guardados, pin y atajos

const $ = (id) => document.getElementById(id);

const pct = (s) => Math.round(Math.max(0, Math.min(6, Number(s && s.gain) || 0)) * 100);

function item(host, s) {
  const li = document.createElement("li");
  const name = Object.assign(document.createElement("span"), { className: "host", textContent: host, title: host });
  const p = pct(s);
  const value = Object.assign(document.createElement("span"), { className: p > 100 ? "pct up" : "pct", textContent: `${p}%` });
  const flags = [];
  if (s && s.boost > 0) flags.push("Bass");
  if (s && s.limiter === false) flags.push("No limiter");
  const extra = Object.assign(document.createElement("span"), { className: "flags", textContent: flags.join(" · ") });
  const del = Object.assign(document.createElement("button"), { className: "x", textContent: "×", title: `Forget ${host}` });
  del.setAttribute("aria-label", `Forget ${host}`);
  del.addEventListener("click", () => chrome.storage.local.remove(`site:${host}`).then(load));
  li.append(name, value, extra, del);
  return li;
}

async function load() {
  const all = await chrome.storage.local.get(null);
  const sites = Object.keys(all)
    .filter((k) => k.startsWith("site:"))
    .map((k) => [k.slice(5), all[k]])
    .sort((a, b) => pct(b[1]) - pct(a[1]) || a[0].localeCompare(b[0]));

  $("sites").replaceChildren(...sites.map(([h, s]) => item(h, s)));
  $("empty").hidden = sites.length > 0;
  $("clear").hidden = sites.length === 0;

  $("pin-card").hidden = !all.pinned;
  if (all.pinned) $("pin-text").textContent = `Every site plays at ${pct(all.pinned)}%. Per-site volumes are kept for later.`;
}

$("clear").addEventListener("click", async () => {
  if (!confirm("Forget the volume of every saved site?")) return;
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith("site:")));
  load();
});

$("unpin").addEventListener("click", () => chrome.storage.local.remove("pinned").then(load));

$("shortcuts").addEventListener("click", () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }));

chrome.storage.onChanged.addListener((c, area) => {
  if (area === "local") load();
});

load();
