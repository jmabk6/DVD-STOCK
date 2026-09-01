// sw.js — cache hors ligne.
// L1 doit fonctionner réseau coupé : sans service worker, iOS ne garantit
// rien après le premier chargement. Tout est servi depuis le dépôt, donc
// tout est préchargé une fois puis lu depuis le cache.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ À CHAQUE COMMIT QUI TOUCHE UN FICHIER DE `RESSOURCES` : INCRÉMENTER   │
// │ `VERSION`. Sans quoi un iPhone qui a déjà installé la PWA continuera  │
// │ de servir la version en cache indéfiniment, pendant que le dépôt      │
// │ avance. La panne est silencieuse et pénible à diagnostiquer.          │
// └──────────────────────────────────────────────────────────────────────┘
const VERSION = "dvd-stock-v2";

// Chemins relatifs à la portée du service worker : l'application marche
// aussi bien à la racine que sous /DVD-STOCK/ sur GitHub Pages.
const RESSOURCES = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/app.css",
  "./js/app.js",
  "./js/scanner.js",
  "./js/store.js",
  "./vendor/zxing-wasm-3.1.3/reader/index.js",
  "./vendor/zxing-wasm-3.1.3/reader/zxing_reader.wasm",
  "./vendor/zxing-wasm-3.1.3/share.js",
  "./vendor/fonts/archivo-latin-var.woff2",
  "./vendor/fonts/dm-mono-500-latin.woff2",
  "./icones/icone-180.png",
  "./icones/icone-192.png",
  "./icones/icone-512.png",
];

// Le service worker est à la racine du dépôt : sa portée couvre donc aussi
// test-scan/ et _archive/. Ces deux dossiers doivent passer au réseau sans
// être touchés — test-scan/ reste la référence de comparaison et doit servir
// son propre code, _archive/ doit rester intouché jusque dans son
// comportement. Ni préchargement, ni interception.
const HORS_APPLICATION = ["test-scan/", "_archive/"];

/** Vrai si la requête ne regarde pas l'application : le navigateur la traite seul. */
function horsApplication(url, portee){
  let u, p;
  try { u = new URL(url); p = new URL(portee); } catch { return true; }
  if (u.origin !== p.origin) return true;
  if (!u.pathname.startsWith(p.pathname)) return true;
  const relatif = u.pathname.slice(p.pathname.length);
  return HORS_APPLICATION.some(d => relatif.startsWith(d));
}

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(VERSION)
      .then(c => c.addAll(RESSOURCES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(noms => Promise.all(
        noms.filter(n => n !== VERSION).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const requete = e.request;
  if (requete.method !== "GET") return;
  if (horsApplication(requete.url, self.registration.scope)) return;

  // Une navigation hors ligne retombe sur la page mise en cache.
  if (requete.mode === "navigate"){
    e.respondWith(
      fetch(requete).catch(() => caches.match("./index.html", { ignoreSearch: true }))
    );
    return;
  }

  // Le reste est figé : cache d'abord, réseau seulement si absent.
  e.respondWith(
    caches.match(requete, { ignoreSearch: true }).then(r => r || fetch(requete))
  );
});
