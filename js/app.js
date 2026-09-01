// app.js — orchestration et écrans.
// Commit 4 : l'écran de saisie. Scan, enregistrement, tampon d'emplacement.
//
// La mise en page, la hiérarchie et les jetons de couleur viennent de la
// maquette saisie.html ; son JavaScript ne simulait que des états et n'a pas
// été repris. Les lignes titre et propositions TMDB de la maquette
// appartiennent au lot L3 et sont volontairement absentes.
//
// Le formatage de l'emplacement (C12-025) vit ici : c'est de la présentation.
// Le store rend `caisse` et `position` séparés et n'a pas à savoir comment on
// les affiche.

import { creerScanner, chargerDecodeur } from "./scanner.js";
import * as store from "./store.js";

const $ = id => document.getElementById(id);

const DUREE_TAMPON_MS = 2000;

/** C12 + 25 → « C12-025 ». Présentation, pas donnée. */
const emplacement = d => `${d.caisse}-${String(d.position).padStart(3, "0")}`;

let caisse = null;          // caisse courante, ou null
let occupee = 0;            // fiches déjà rangées dans cette caisse
let minuterieTampon = null;
let panneauOuvert = false;
let torcheDisponible = false;

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

function remplirLigne(id, html){
  const ligne = $(id);
  ligne.classList.add("faite");
  ligne.querySelector(".corps").innerHTML = html;
}

function viderFiche(){
  for (const [id, libelle] of [["l-ean", "Code-barres"], ["l-emplacement", "Emplacement"]]){
    const ligne = $(id);
    ligne.classList.remove("faite");
    ligne.querySelector(".corps").innerHTML = `<div class="champ-vide">${libelle}</div>`;
  }
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
  panneauOuvert = true;
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

  $("btn").textContent = "Ouvrir la caisse";
  $("b-torche").textContent = "Annuler";
  $("b-torche").classList.remove("active");
  $("b-torche").hidden = !caisse;   // rien à annuler s'il n'y a pas de caisse
}

function fermerPanneau(){
  panneauOuvert = false;
  $("panneau").hidden = true;
  $("btn").textContent = "Caisses";
  $("b-torche").textContent = "Lampe";
  $("b-torche").hidden = !torcheDisponible;
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

async function enregistrer(ean){
  if (!caisse){
    // Le cas du tout début de session : un boîtier passe devant l'objectif
    // avant qu'une caisse existe. Message clair, jamais d'erreur technique.
    signaler("echec");
    annoncer("Ouvrez une caisse avant de scanner", true);
    if (!panneauOuvert) await ouvrirPanneau();
    return;
  }

  try {
    const { disque, doublon, capacite } = await store.ajouterDisque({ ean });
    occupee = capacite.occupee;
    const emp = emplacement(disque);

    remplirLigne("l-ean", `<div class="valeur mono">${ean}</div>`);
    remplirLigne("l-emplacement",
      `<div class="valeur mono">${emp}</div>` +
      (doublon ? `<div class="sous">déjà en stock · quantité ${disque.quantite}</div>` : ""));

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
  }
}

// ---------------------------------------------------------------------------
// Scanner — caméra allumée pendant toute la session, jamais relancée.
// ---------------------------------------------------------------------------

const scanner = creerScanner({
  video: $("video"),

  surEtat(texte, verrouille){
    // Ni le panneau de caisse ni une alerte en cours ne doivent être écrasés.
    if (!panneauOuvert && !$("hint").classList.contains("alerte")){
      $("hint").textContent = texte;
    }
    $("viseur").classList.toggle("verrouille", verrouille);
  },

  surCamera({ torche }){
    torcheDisponible = torche;
    if (!panneauOuvert) $("b-torche").hidden = !torche;
  },

  surCode(ean){
    $("hint").classList.remove("alerte");
    enregistrer(ean);
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
  if (panneauOuvert) creerCaisse();
  else ouvrirPanneau();
});

$("b-torche").addEventListener("click", async () => {
  if (panneauOuvert){ fermerPanneau(); return; }
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
