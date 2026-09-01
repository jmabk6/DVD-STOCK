// app.js — orchestration et écrans.
// L'écran de saisie : scan, jaquette, enregistrement, tampon d'emplacement.
//
// La mise en page, la hiérarchie et les jetons de couleur viennent de la
// maquette saisie.html ; son JavaScript ne simulait que des états et n'a pas
// été repris. Les lignes titre et propositions TMDB de la maquette
// appartiennent au lot L3 et sont volontairement absentes.
//
// Le formatage de l'emplacement (C12-025) vit ici : c'est de la présentation.
// Le store rend `caisse` et `position` séparés et n'a pas à savoir comment on
// les affiche.
//
// Séquence par disque (SPEC §6.1) : scan EAN → photo jaquette → enregistrement.
// Un doublon coupe court : le disque rejoint son jumeau, il n'a pas besoin
// d'une seconde jaquette.

import { creerScanner, chargerDecodeur } from "./scanner.js";
import { capturer, urlDeLaPhoto } from "./photo.js";
import * as store from "./store.js";

const $ = id => document.getElementById(id);

const DUREE_TAMPON_MS = 2000;

/** C12 + 25 → « C12-025 ». Présentation, pas donnée. */
const emplacement = d => `${d.caisse}-${String(d.position).padStart(3, "0")}`;

let caisse = null;          // caisse courante, ou null
let occupee = 0;            // fiches déjà rangées dans cette caisse
let minuterieTampon = null;
let torcheDisponible = false;
let urlVignette = null;     // objet URL de la vignette affichée

// « panneau » : ouverture de caisse. « attente » : prêt à scanner.
// « jaquette » : un EAN est lu, on attend la photo.
let mode = "attente";
let enAttente = null;       // { ean } du disque dont on attend la jaquette

// ---------------------------------------------------------------------------
// Retours sonores et haptiques — trois signaux distincts.
// L'utilisateur regarde les disques, pas l'écran (SPEC §5).
// ---------------------------------------------------------------------------

const SIGNAUX = {
  accepte: { frequence: 1180, duree: 0.09, forme: "sine",     vibration: 45 },
  doublon: { frequence: 420,  duree: 0.22, forme: "sine",     vibration: [60, 50, 60] },
  echec:   { frequence: 150,  duree: 0.32, forme: "sawtooth", vibration: [130, 70, 130] },
};

let audio = null;

// iOS n'autorise l'audio qu'après un geste de l'utilisateur. On saisit le
// premier venu, quel qu'il soit : sans ça, une session reprise sur une caisse
// déjà ouverte resterait muette jusqu'au premier appui sur un bouton.
function eveillerAudio(){
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === "suspended") audio.resume();
  } catch(e){ /* pas de son sur cet appareil */ }
}
document.addEventListener("pointerdown", eveillerAudio, { capture: true });

function signaler(nom){
  const signal = SIGNAUX[nom];
  eveillerAudio();
  try {
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = signal.forme;
    o.frequency.value = signal.frequence;
    g.gain.value = 0.18;
    o.connect(g); g.connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + signal.duree);
  } catch(e){ /* audio indisponible */ }
  // Sans effet sur iPhone : Safari iOS n'implémente pas navigator.vibrate.
  navigator.vibrate?.(signal.vibration);
}

// ---------------------------------------------------------------------------
// Veille — l'écran ne doit pas s'éteindre pendant une session active.
// ---------------------------------------------------------------------------

let verrouVeille = null;

async function tenirEveille(){
  if (!navigator.wakeLock || document.visibilityState !== "visible") return;
  try {
    verrouVeille = await navigator.wakeLock.request("screen");
    verrouVeille.addEventListener("release", () => { verrouVeille = null; });
  } catch(e){ /* refusé ou indisponible */ }
}

// iOS relâche le verrou dès que l'application passe en arrière-plan.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !verrouVeille && caisse) tenirEveille();
});

// ---------------------------------------------------------------------------
// Affichage
// ---------------------------------------------------------------------------

function majBandeau(alerteCapacite = false){
  $("caisse").textContent = caisse ? caisse.code : "—";
  $("compte").textContent = store.compterSession();
  const etat = $("etat-caisse");
  if (!caisse){
    etat.textContent = "aucune caisse ouverte";
    etat.classList.remove("pleine");
    return;
  }
  etat.textContent = `${occupee} / ${caisse.capacite}`;
  etat.classList.toggle("pleine", alerteCapacite || occupee >= caisse.capacite);
}

function majBoutons(){
  const principal = $("btn"), second = $("b-torche");
  if (mode === "panneau"){
    principal.textContent = "Ouvrir la caisse";
    second.textContent = "Annuler";
    second.hidden = !caisse;          // rien à annuler s'il n'y a pas de caisse
  } else if (mode === "jaquette"){
    principal.textContent = "Photographier la jaquette";
    second.textContent = "Sans photo";
    second.hidden = false;
  } else {
    principal.textContent = "Caisses";
    second.textContent = "Lampe";
    second.hidden = !torcheDisponible;
  }
  second.classList.remove("active");
}

function remplirLigne(id, html){
  const ligne = $(id);
  ligne.classList.add("faite");
  ligne.querySelector(".corps").innerHTML = html;
}

function viderFiche(){
  if (urlVignette){ URL.revokeObjectURL(urlVignette); urlVignette = null; }
  for (const [id, libelle] of [["l-ean", "Code-barres"],
                               ["l-photo", "Jaquette"],
                               ["l-emplacement", "Emplacement"]]){
    const ligne = $(id);
    ligne.classList.remove("faite", "active");
    ligne.querySelector(".corps").innerHTML = `<div class="champ-vide">${libelle}</div>`;
  }
}

function activerLigne(id){
  document.querySelectorAll(".ligne").forEach(l => l.classList.remove("active"));
  if (id) $(id).classList.add("active");
}

function montrerTampon({ classe, cadre, quoi, ou }){
  clearTimeout(minuterieTampon);
  $("fiche").querySelector(".tampon")?.remove();
  $("fiche").insertAdjacentHTML("beforeend",
    `<div class="tampon ${classe}">
       <div class="cadre">${cadre}</div>
       <div class="quoi">${quoi}</div>
       ${ou ? `<div class="ou">${ou}</div>` : ""}
     </div>`);
  minuterieTampon = setTimeout(() => {
    $("fiche").querySelector(".tampon")?.remove();
  }, DUREE_TAMPON_MS);
}

function annoncer(texte, alerte = false){
  $("hint").textContent = texte;
  $("hint").classList.toggle("alerte", alerte);
}

// ---------------------------------------------------------------------------
// Panneau de caisse
// ---------------------------------------------------------------------------

async function ouvrirPanneau(){
  mode = "panneau";
  enAttente = null;
  $("panneau").hidden = false;

  const fermees = await store.listerCaisses({ ouverte: false });
  const reprise = $("reprise");
  reprise.innerHTML = fermees.length
    ? `<span class="sous" style="width:100%">Ou reprendre une caisse fermée :</span>`
    : "";
  for (const c of fermees){
    const b = document.createElement("button");
    b.textContent = `${c.code} · ${c.prochainePosition - 1}`;
    b.addEventListener("click", () => reprendre(c.code));
    reprise.appendChild(b);
  }
  majBoutons();
}

function fermerPanneau(){
  mode = "attente";
  enAttente = null;
  $("panneau").hidden = true;
  majBoutons();
}

async function entrerEnSaisie(){
  viderFiche();
  majBandeau();
  fermerPanneau();
  tenirEveille();
  annoncer("Présentez le code-barres");
}

async function creerCaisse(){
  const capacite = parseInt($("capacite").value, 10);
  if (!Number.isInteger(capacite) || capacite < 1){
    annoncer("Capacité invalide", true);
    signaler("echec");
    return;
  }
  caisse = await store.ouvrirCaisse(capacite);
  occupee = 0;
  await entrerEnSaisie();
}

async function reprendre(code){
  caisse = await store.rouvrirCaisse(code);
  occupee = (await store.listerDisques({ caisse: code })).length;
  await entrerEnSaisie();
}

// ---------------------------------------------------------------------------
// Enregistrement
// ---------------------------------------------------------------------------

/** Un code vient d'être accepté par le scanner. */
async function surLecture(ean){
  if (!caisse){
    // Le cas du tout début de session : un boîtier passe devant l'objectif
    // avant qu'une caisse existe. Message clair, jamais d'erreur technique.
    signaler("echec");
    annoncer("Ouvrez une caisse avant de scanner", true);
    if (mode !== "panneau") await ouvrirPanneau();
    return;
  }

  // Une jaquette est déjà attendue : on ne perd pas le disque en cours.
  if (mode === "jaquette"){
    signaler("echec");
    annoncer("Photographiez d'abord la jaquette", true);
    return;
  }

  // Nouveau disque : la fiche repart vide, sans quoi la jaquette du disque
  // précédent resterait affichée sous le code-barres du suivant.
  viderFiche();
  remplirLigne("l-ean", `<div class="valeur mono">${ean}</div>`);

  // Un doublon n'a pas besoin de jaquette : le disque rejoint son jumeau.
  // On montre celle du premier exemplaire, qui aide à confirmer que c'est
  // bien le même film.
  const connu = await store.chercherParEan(ean);
  if (connu){
    await montrerJaquetteConnue(connu);
    await ranger(ean, null);
    return;
  }

  enAttente = { ean };
  mode = "jaquette";
  activerLigne("l-photo");
  majBoutons();
  annoncer("Montrez la jaquette");
}

/** Le fragment de vignette, commun à la capture et au doublon. */
function vignette(url, titre, sous){
  return `<div class="avec-vignette">
            <img class="vignette" src="${url}" alt="">
            <div>
              <div class="valeur" style="font-size:17px">${titre}</div>
              <div class="sous">${sous}</div>
            </div>
          </div>`;
}

async function montrerJaquetteConnue(disque){
  if (!disque.photoCle) return;
  const photo = await store.lirePhoto(disque.photoCle);
  if (!photo) return;
  if (urlVignette) URL.revokeObjectURL(urlVignette);
  urlVignette = urlDeLaPhoto(photo);
  remplirLigne("l-photo", vignette(urlVignette, "Jaquette", "du premier exemplaire"));
}

/** Écrit la fiche, avec ou sans jaquette, et tamponne l'emplacement. */
async function ranger(ean, photoCle){
  try {
    const { disque, doublon, capacite } = await store.ajouterDisque({ ean, photoCle });
    occupee = capacite.occupee;
    const emp = emplacement(disque);

    remplirLigne("l-ean", `<div class="valeur mono">${ean}</div>`);
    remplirLigne("l-emplacement",
      `<div class="valeur mono">${emp}</div>` +
      (doublon ? `<div class="sous">déjà en stock · quantité ${disque.quantite}</div>` : ""));
    activerLigne(null);

    majBandeau(capacite.atteinte);
    signaler(doublon ? "doublon" : "accepte");

    montrerTampon(doublon
      ? {
          classe: "doublon",
          cadre: emp,
          quoi: "Déjà en stock",
          ou: `Quantité portée à ${disque.quantite} — rangez avec l'autre`,
        }
      : {
          classe: "",
          cadre: emp,
          quoi: `Rangez dans la caisse ${disque.caisse}`,
          ou: capacite.atteinte
            ? `Caisse pleine — ${capacite.occupee} pour ${capacite.annoncee} annoncés`
            : "",
        });
  } catch (e){
    signaler("echec");
    montrerTampon({
      classe: "echec",
      cadre: "refusé",
      quoi: "Enregistrement impossible",
      ou: e?.message ?? String(e),
    });
  } finally {
    enAttente = null;
    mode = "attente";
    majBoutons();
    annoncer("Présentez le code-barres");
  }
}

/** Déclenchement simple : une image du flux, réduite, puis la fiche. */
async function photographier(){
  if (!enAttente) return;
  const ean = enAttente.ean;
  try {
    const photo = await capturer($("video"));
    const cle = await store.enregistrerPhoto(photo);

    if (urlVignette) URL.revokeObjectURL(urlVignette);
    urlVignette = urlDeLaPhoto(photo);
    remplirLigne("l-photo", vignette(urlVignette, "Jaquette prise",
      `${photo.largeur} px · ${Math.round(photo.octets / 1024)} Ko`));

    await ranger(ean, cle);
  } catch (e){
    // La capture a échoué : on n'abandonne pas la fiche pour autant.
    signaler("echec");
    remplirLigne("l-photo", `<div class="sous">jaquette non prise — ${e.message}</div>`);
    await ranger(ean, null);
  }
}

async function rangerSansPhoto(){
  if (!enAttente) return;
  remplirLigne("l-photo", `<div class="sous">sans jaquette</div>`);
  await ranger(enAttente.ean, null);
}

// ---------------------------------------------------------------------------
// Scanner — caméra allumée pendant toute la session, jamais relancée.
// ---------------------------------------------------------------------------

const scanner = creerScanner({
  video: $("video"),

  surEtat(texte, verrouille){
    // Ni le panneau, ni l'attente de jaquette, ni une alerte ne sont écrasés.
    if (mode === "attente" && !$("hint").classList.contains("alerte")){
      $("hint").textContent = texte;
    }
    $("viseur").classList.toggle("verrouille", verrouille);
  },

  surCamera({ torche }){
    torcheDisponible = torche;
    majBoutons();
  },

  surCode(ean){
    $("hint").classList.remove("alerte");
    surLecture(ean);
  },

  surEchec(){
    signaler("echec");
    annoncer("Code illisible — représentez le boîtier", true);
    setTimeout(() => $("hint").classList.remove("alerte"), 1500);
  },
});

// ---------------------------------------------------------------------------
// Boutons
// ---------------------------------------------------------------------------

$("btn").addEventListener("click", () => {
  if (mode === "panneau") creerCaisse();
  else if (mode === "jaquette") photographier();
  else ouvrirPanneau();
});

$("b-torche").addEventListener("click", async () => {
  if (mode === "panneau"){ fermerPanneau(); annoncer("Présentez le code-barres"); return; }
  if (mode === "jaquette"){ rangerSansPhoto(); return; }
  $("b-torche").classList.toggle("active", await scanner.basculerTorche());
});

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------

if ("serviceWorker" in navigator){
  navigator.serviceWorker.register("./sw.js").catch(() => { /* hors ligne indisponible */ });
}

chargerDecodeur().catch(e => annoncer("Décodeur indisponible — " + e.message, true));

(async () => {
  caisse = await store.caisseCourante();
  if (caisse) occupee = (await store.listerDisques({ caisse: caisse.code })).length;
  majBandeau();

  if (caisse){
    fermerPanneau();
    tenirEveille();
    annoncer("Présentez le code-barres");
  } else {
    await ouvrirPanneau();
    annoncer("Ouvrez une caisse pour commencer");
  }

  try {
    await scanner.demarrer();
  } catch (e){
    annoncer(`Caméra indisponible — ${e.name}`, true);
  }
})();
