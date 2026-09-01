// app.js — orchestration et écrans.
// Commit 1 : un seul écran, le diagnostic. Il sert à vérifier sur l'iPhone
// que tout est servi par le dépôt et que rien ne dépend du réseau.

import { creerScanner, chargerDecodeur, VERSION_DECODEUR } from "./scanner.js";

const $ = id => document.getElementById(id);
const ok      = t => `<span class="ok">${t}</span>`;
const ko      = t => `<span class="ko">${t}</span>`;
const attente = t => `<span class="attente">${t}</span>`;

let compteur = 0;
const dejaVus = new Set();

// --- lancée depuis l'écran d'accueil ? ---
const autonome = window.matchMedia("(display-mode: standalone)").matches
  || window.navigator.standalone === true;
$("d-pwa").innerHTML = autonome
  ? ok("oui")
  : attente("non — ouvrez depuis l'écran d'accueil");

// --- décodeur ---
chargerDecodeur()
  .then(() => { $("d-wasm").innerHTML = ok(`chargé (${VERSION_DECODEUR}, local)`); })
  .catch(e => { $("d-wasm").innerHTML = ko("échec — " + e.message); });

// --- polices ---
document.fonts.ready.then(() => {
  const manquantes = [];
  if (!document.fonts.check('600 16px Archivo'))   manquantes.push("Archivo");
  if (!document.fonts.check('500 16px "DM Mono"')) manquantes.push("DM Mono");
  $("d-polices").innerHTML = manquantes.length
    ? ko("absentes — " + manquantes.join(", "))
    : ok("Archivo + DM Mono, locales");
});

// --- cache hors ligne ---
if ("serviceWorker" in navigator){
  navigator.serviceWorker.register("./sw.js")
    .then(async reg => {
      await navigator.serviceWorker.ready;
      $("d-cache").innerHTML = reg.active
        ? ok("actif — la page tient réseau coupé")
        : attente("installation en cours — rechargez une fois");
    })
    .catch(e => { $("d-cache").innerHTML = ko("échec — " + e.message); });
} else {
  $("d-cache").innerHTML = ko("service worker indisponible");
}

// --- scan ---
const scanner = creerScanner({
  video: $("video"),

  surEtat(texte, verrouille){
    $("etat").textContent = texte;
    $("cadre").classList.toggle("verrouille", verrouille);
  },

  surCamera({ largeur, hauteur, torche }){
    $("d-cam").innerHTML = ok(`${largeur}×${hauteur}`);
    $("b-torche").hidden = !torche;
  },

  surCadence(ips){
    $("d-cadence").innerHTML = ips >= 8 ? ok(`${ips} images/s`) : attente(`${ips} images/s`);
  },

  surCode(ean, ms){
    const doublon = dejaVus.has(ean);
    dejaVus.add(ean);
    compteur++;
    $("compte").textContent = compteur;
    $("vide")?.remove();
    $("journal").insertAdjacentHTML("afterbegin",
      `<div class="lecture${doublon ? " doublon" : ""}">` +
      `<code>${ean}</code>` +
      `<span class="ms">${doublon ? "déjà lu · " : ""}${ms} ms</span></div>`);
  },
});

scanner.demarrer().catch(e => {
  $("d-cam").innerHTML = ko(`${e.name} — ${e.message}`);
  $("etat").textContent = "Caméra indisponible";
});

// --- pied de page ---
$("b-torche").addEventListener("click", async () => {
  $("b-torche").classList.toggle("active", await scanner.basculerTorche());
});

$("b-vider").addEventListener("click", () => {
  dejaVus.clear();
  compteur = 0;
  $("compte").textContent = "0";
  $("journal").innerHTML = '<div id="vide">Journal vidé.</div>';
});
