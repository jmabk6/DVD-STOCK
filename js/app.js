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
  const principal = $("btn"), second = $("b-second"), tiers = $("b-tiers");
  second.hidden = true;
  tiers.hidden = true;
  $("b-lampe").hidden = !torcheDisponible || mode === "liste";

  if (mode === "panneau"){
    principal.textContent = "Ouvrir la caisse";
    second.textContent = "Annuler";
    second.hidden = !caisse;          // rien à annuler s'il n'y a pas de caisse
  } else if (mode === "jaquette"){
    principal.textContent = "Photographier la jaquette";
    second.textContent = "Sans photo";
    second.hidden = false;
  } else if (mode === "reprise"){
    principal.textContent = "Photographier la jaquette";
    second.textContent = "Annuler";
    second.hidden = false;
  } else if (mode === "liste"){
    principal.textContent = "Retour à la saisie";
    second.textContent = "Exporter";
    second.hidden = false;
    tiers.textContent = "Importer";
    tiers.hidden = false;
  } else {
    principal.textContent = "Sans code-barres";
    second.textContent = "Liste";
    second.hidden = false;
    tiers.textContent = "Caisses";
    tiers.hidden = false;
  }
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
// Liste minimale — emplacement, EAN, vignette, quantité, date.
// Triée par caisse puis position. Aucun filtre, aucune grille : c'est L4.
// ---------------------------------------------------------------------------

const PIXEL_VIDE = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

const urlsListe = [];

const dateCourte = t => new Date(t).toLocaleDateString("fr-FR",
  { day: "2-digit", month: "2-digit", year: "2-digit" });

async function ouvrirListe(){
  nettoyerListe();          // idempotent : un second rendu ne fuit ni observateur ni URL
  mode = "liste";
  enAttente = null;
  $("liste").hidden = false;
  majBoutons();

  const disques = await store.listerDisques();          // déjà trié caisse puis position
  const exemplaires = disques.reduce((n, d) => n + d.quantite, 0);
  $("liste-tete").innerHTML = disques.length
    ? `<b>${disques.length}</b> fiches · <b>${exemplaires}</b> exemplaires`
    : "";

  const corps = $("liste-corps");
  corps.innerHTML = "";
  if (!disques.length){
    corps.innerHTML = `<div class="liste-vide">Aucun disque saisi pour l'instant.<br>
      Revenez à la saisie et scannez un code-barres.</div>`;
    return;
  }

  let caisseAffichee = null;
  const fragment = document.createDocumentFragment();
  for (const d of disques){
    if (d.caisse !== caisseAffichee){
      caisseAffichee = d.caisse;
      const titre = document.createElement("div");
      titre.className = "caisse-titre";
      titre.textContent = d.caisse;
      fragment.appendChild(titre);
    }
    const entree = document.createElement("div");
    entree.className = "entree";
    entree.addEventListener("click", () => ouvrirFeuille(d.id));
    entree.innerHTML =
      (d.photoCle
        ? `<img class="vignette" alt="" src="${PIXEL_VIDE}" data-cle="${d.photoCle}">`
        : `<div class="sans-image"></div>`) +
      `<div class="infos">
         <div class="place">${d.caisse}-${String(d.position).padStart(3, "0")}</div>
         <div class="detail">${d.ean ?? "sans code-barres"} · ${dateCourte(d.dateSaisie)}</div>
       </div>
       <div class="quantite${d.quantite > 1 ? " multiple" : ""}">×${d.quantite}</div>`;
    fragment.appendChild(entree);
  }
  corps.appendChild(fragment);

  corps.addEventListener("scroll", surDefilement);
  chargerVignettesVisibles();
}

// Les jaquettes ne sont lues qu'à l'approche de l'écran : trois mille fiches
// ne peuvent pas tenir trois mille blobs ouverts en même temps.
//
// Calculé, pas observé. Un IntersectionObserver dépend du cycle de rendu, et
// ne livre rien quand la page n'est pas rendue — la liste resterait alors une
// colonne de cadres vides, sans le moindre message.
const MARGE_VIGNETTES = 300;   // px chargés au-delà de l'écran, de part et d'autre

function chargerVignettesVisibles(){
  const corps = $("liste-corps");
  const zone = corps.getBoundingClientRect();
  // Seules les images pas encore chargées portent encore data-cle : le balayage
  // se réduit au fil du défilement.
  for (const img of corps.querySelectorAll("img.vignette[data-cle]")){
    const boite = img.getBoundingClientRect();
    if (boite.bottom < zone.top - MARGE_VIGNETTES) continue;
    if (boite.top > zone.bottom + MARGE_VIGNETTES) break;   // la suite est plus bas encore
    const cle = img.dataset.cle;
    delete img.dataset.cle;                                 // une seule lecture par image
    store.lirePhoto(cle).then(photo => {
      if (!photo) return;
      const url = URL.createObjectURL(photo.donnees);
      urlsListe.push(url);
      img.src = url;
    }).catch(() => { /* jaquette illisible : le cadre reste vide */ });
  }
}

let defilementEnAttente = null;
function surDefilement(){
  if (defilementEnAttente) return;
  defilementEnAttente = setTimeout(() => {
    defilementEnAttente = null;
    chargerVignettesVisibles();
  }, 120);
}

function nettoyerListe(){
  clearTimeout(defilementEnAttente);
  defilementEnAttente = null;
  $("liste-corps").removeEventListener("scroll", surDefilement);
  while (urlsListe.length) URL.revokeObjectURL(urlsListe.pop());
  $("liste-corps").innerHTML = "";
  $("feuille").hidden = true;
  ficheChoisie = null;
  $("liste").hidden = true;
}

// ---------------------------------------------------------------------------
// Actions sur une fiche : refaire la jaquette, corriger la quantité.
// Le minimum. La fiche détail complète est L4.
// ---------------------------------------------------------------------------

let ficheChoisie = null;

async function ouvrirFeuille(id){
  const fiche = (await store.listerDisques()).find(d => d.id === id);
  if (!fiche) return;
  ficheChoisie = fiche;
  $("feuille-tete").innerHTML =
    `${fiche.caisse}-${String(fiche.position).padStart(3, "0")}
     <small>${fiche.ean ?? "sans code-barres"} · saisi le ${dateCourte(fiche.dateSaisie)}</small>`;
  majQuantiteFeuille(fiche.quantite);
  $("feuille").hidden = false;
}

function majQuantiteFeuille(q){
  $("f-quantite").textContent = q;
  // La quantité ne descend pas sous 1 : écarter un disque se fait par le
  // statut REBUT, pas en le ramenant à zéro (I-12).
  $("f-moins").disabled = q <= 1;
}

async function changerQuantite(delta){
  if (!ficheChoisie) return;
  const voulue = ficheChoisie.quantite + delta;
  if (voulue < 1) return;
  try {
    ficheChoisie = await store.corrigerQuantite(ficheChoisie.id, voulue);
    majQuantiteFeuille(ficheChoisie.quantite);
    await rafraichirListe();
  } catch (e){
    signaler("echec");
  }
}

/** Recharge la liste en gardant la feuille d'actions ouverte. */
async function rafraichirListe(){
  const id = ficheChoisie?.id;
  const ouverte = !$("feuille").hidden;
  await ouvrirListe();
  if (id && ouverte) await ouvrirFeuille(id);
}

function fermerListe(){
  nettoyerListe();
  mode = "attente";
  majBoutons();
  annoncer(caisse ? "Présentez le code-barres" : "Ouvrez une caisse pour commencer");
}

// ---------------------------------------------------------------------------
// Panneau de caisse
// ---------------------------------------------------------------------------

async function ouvrirPanneau(){
  nettoyerListe();
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

  const courante = $("courante");
  courante.innerHTML = "";
  courante.hidden = !caisse;
  if (caisse){
    courante.insertAdjacentHTML("beforeend",
      `<span>En cours : <b>${caisse.code}</b> — ${occupee} disques</span>`);
    const b = document.createElement("button");
    b.textContent = `Fermer ${caisse.code}`;
    b.addEventListener("click", () => fermerLaCaisse());
    courante.appendChild(b);
  }
  majBoutons();
}

/** Ferme la caisse en cours. Elle reste dans les données et peut être reprise. */
async function fermerLaCaisse(){
  if (!caisse) return;
  const code = caisse.code;
  await store.fermerCaisse(code);
  caisse = await store.caisseCourante();
  occupee = caisse ? (await store.listerDisques({ caisse: caisse.code })).length : 0;
  majBandeau();
  await ouvrirPanneau();
  annoncer(`${code} fermée`);
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
  // On consulte la liste, ou on refait une jaquette : ce n'est pas le moment
  // de saisir un nouveau disque.
  if (mode === "liste") return;
  if (mode === "reprise"){
    annoncer("Reprise de jaquette en cours — photographiez ou annulez", true);
    return;
  }

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

/** Boîtier sans code-barres lisible : fiche créée sans EAN, avec jaquette. */
async function sansCodeBarres(){
  if (!caisse){
    signaler("echec");
    annoncer("Ouvrez une caisse avant de saisir", true);
    await ouvrirPanneau();
    return;
  }
  viderFiche();
  remplirLigne("l-ean", `<div class="sous">sans code-barres</div>`);
  enAttente = { ean: null };
  mode = "jaquette";
  activerLigne("l-photo");
  majBoutons();
  annoncer("Montrez la jaquette");
}

// ---------------------------------------------------------------------------
// Reprendre la jaquette d'une fiche existante.
// La fiche n'est pas recréée : l'emplacement et l'EAN ne bougent pas.
// ---------------------------------------------------------------------------

let ficheARephotographier = null;

function demarrerReprisePhoto(){
  if (!ficheChoisie) return;
  ficheARephotographier = ficheChoisie;
  nettoyerListe();
  mode = "reprise";
  viderFiche();
  const emp = `${ficheARephotographier.caisse}-${String(ficheARephotographier.position).padStart(3, "0")}`;
  remplirLigne("l-ean",
    `<div class="valeur mono">${ficheARephotographier.ean ?? "sans code-barres"}</div>
     <div class="sous">${emp}</div>`);
  activerLigne("l-photo");
  majBoutons();
  annoncer(`Montrez la jaquette de ${emp}`);
}

async function terminerReprisePhoto(){
  const fiche = ficheARephotographier;
  if (!fiche) return;
  const emp = `${fiche.caisse}-${String(fiche.position).padStart(3, "0")}`;
  try {
    const photo = await capturer($("video"));
    await store.remplacerPhoto(fiche.id, photo);
    if (urlVignette) URL.revokeObjectURL(urlVignette);
    urlVignette = urlDeLaPhoto(photo);
    remplirLigne("l-photo", vignette(urlVignette, "Jaquette refaite",
      `${photo.largeur} px · ${Math.round(photo.octets / 1024)} Ko`));
    signaler("accepte");
    montrerTampon({ classe: "", cadre: emp, quoi: "Jaquette refaite",
                    ou: "La fiche et son emplacement n'ont pas bougé" });
  } catch (e){
    signaler("echec");
    montrerTampon({ classe: "echec", cadre: "refusé", quoi: "Jaquette non reprise",
                    ou: e?.message ?? String(e) });
  } finally {
    ficheARephotographier = null;
    mode = "attente";
    majBoutons();
    annoncer("Présentez le code-barres");
  }
}

function annulerReprisePhoto(){
  ficheARephotographier = null;
  mode = "attente";
  viderFiche();
  majBoutons();
  annoncer("Présentez le code-barres");
}

// ---------------------------------------------------------------------------
// Export — la seule sauvegarde disponible tant que L2 n'existe pas.
// ---------------------------------------------------------------------------

// Au-delà de ce nombre de fiches, un export d'un seul tenant risque de manquer
// de mémoire sur un iPhone : les jaquettes en base64 pèsent un tiers de plus
// que les images. On découpe par caisse plutôt que de ne rien produire.
const SEUIL_DECOUPAGE = 800;

const nomExport = code =>
  `dvd-stock-${new Date().toISOString().slice(0, 10)}${code ? "-" + code : ""}.json`;

async function fichierExport(code){
  const donnees = await store.exporterTout({ avecPhotos: true, caisse: code });
  // Pas d'indentation : avec les jaquettes en base64, elle coûte cher pour rien.
  return {
    fichier: new File([JSON.stringify(donnees)], nomExport(code), { type: "application/json" }),
    fiches: donnees.disques.length,
    jaquettes: donnees.photos.length,
  };
}

/** Feuille de partage d'abord — sur iPhone, un lien de téléchargement dans une
 *  PWA installée ne mène nulle part. Repli sur le lien ailleurs. */
async function livrer(fichiers){
  if (navigator.canShare?.({ files: fichiers })){
    try {
      await navigator.share({ files: fichiers, title: "Sauvegarde DVD" });
      return true;
    } catch (e){
      if (e?.name === "AbortError") return false;   // partage annulé : pas une erreur
    }
  }
  for (const f of fichiers){
    const url = URL.createObjectURL(f);
    const lien = document.createElement("a");
    lien.href = url;
    lien.download = f.name;
    lien.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    await new Promise(r => setTimeout(r, 300));
  }
  return true;
}

async function exporter(){
  try {
    annoncer("Préparation de la sauvegarde…");
    const inventaire = await store.listerDisques();
    const codes = [...new Set(inventaire.map(d => d.caisse))];

    let morceaux = null;
    if (inventaire.length <= SEUIL_DECOUPAGE || codes.length < 2){
      try {
        morceaux = [await fichierExport(null)];
      } catch (e){
        morceaux = null;   // mémoire insuffisante d'un seul tenant : on découpe
      }
    }
    if (!morceaux){
      morceaux = [];
      for (const code of codes) morceaux.push(await fichierExport(code));
    }

    if (!await livrer(morceaux.map(m => m.fichier))) { annoncer("Sauvegarde annulée"); return; }

    const fiches = morceaux.reduce((n, m) => n + m.fiches, 0);
    const jaquettes = morceaux.reduce((n, m) => n + m.jaquettes, 0);
    annoncer(morceaux.length > 1
      ? `${fiches} fiches et ${jaquettes} jaquettes, en ${morceaux.length} fichiers`
      : `${fiches} fiches et ${jaquettes} jaquettes sauvegardées`);
  } catch (e){
    signaler("echec");
    annoncer("Sauvegarde impossible — " + (e?.message ?? e), true);
  }
}

/** Réimport. Plusieurs fichiers à la fois : un export découpé se restaure d'un coup. */
async function importer(fichiers){
  const cumul = { ajoutees: 0, ignorees: 0, jaquettes: 0 };
  try {
    annoncer(`Lecture de ${fichiers.length} fichier${fichiers.length > 1 ? "s" : ""}…`);
    for (const f of fichiers){
      const bilan = await store.importerTout(JSON.parse(await f.text()));
      cumul.ajoutees += bilan.disques.ajoutees;
      cumul.ignorees += bilan.disques.ignorees;
      cumul.jaquettes += bilan.photos.ajoutees;
    }
    caisse = await store.caisseCourante();
    occupee = caisse ? (await store.listerDisques({ caisse: caisse.code })).length : 0;
    majBandeau();
    await ouvrirListe();
    signaler("accepte");
    annoncer(`${cumul.ajoutees} fiches et ${cumul.jaquettes} jaquettes restaurées`
      + (cumul.ignorees ? ` · ${cumul.ignorees} déjà présentes` : ""));
  } catch (e){
    signaler("echec");
    annoncer("Réimport impossible — " + (e?.message ?? e), true);
  }
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
  else if (mode === "reprise") terminerReprisePhoto();
  else if (mode === "liste") fermerListe();
  else sansCodeBarres();
});

$("b-second").addEventListener("click", () => {
  if (mode === "panneau"){ fermerPanneau(); annoncer("Présentez le code-barres"); return; }
  if (mode === "jaquette"){ rangerSansPhoto(); return; }
  if (mode === "reprise"){ annulerReprisePhoto(); return; }
  if (mode === "liste"){ exporter(); return; }
  ouvrirListe();
});

$("b-tiers").addEventListener("click", () => {
  if (mode === "liste"){ $("fichier").click(); return; }
  ouvrirPanneau();
});

$("fichier").addEventListener("change", async ev => {
  const fichiers = [...ev.target.files];
  ev.target.value = "";                    // pour pouvoir rejouer le même fichier
  if (fichiers.length) await importer(fichiers);
});

$("b-lampe").addEventListener("click", async () => {
  $("b-lampe").classList.toggle("active", await scanner.basculerTorche());
});

$("f-photo").addEventListener("click", () => demarrerReprisePhoto());
$("f-moins").addEventListener("click", () => changerQuantite(-1));
$("f-plus").addEventListener("click", () => changerQuantite(+1));
$("f-fermer").addEventListener("click", () => { $("feuille").hidden = true; ficheChoisie = null; });

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
