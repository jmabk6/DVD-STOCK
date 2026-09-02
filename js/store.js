// store.js — SEULE couche d'accès aux données (I-10).
// Aucun autre fichier ne touche IndexedDB. Aucun autre fichier ne connaît le
// schéma. Quand Firestore arrivera au lot L2, c'est ce fichier seul qui
// changera, et l'interface publique ci-dessous ne bougera pas.
//
// Toutes les fonctions publiques rendent une promesse : IndexedDB n'offre
// aucun accès synchrone. Les signatures de la consigne décrivent la forme du
// retour, pas son immédiateté. `compterSession` fait exception : c'est un
// compteur en mémoire, il répond directement.
//
// Schéma : §3 de la SPEC-001, sans le champ `provenance` (retiré).

const BASE = "dvd-stock";
const VERSION_SCHEMA = 2;   // v2 : ajout du magasin `photos`

/** I-11 — largeur maximale d'une jaquette écrite en base. */
export const LARGEUR_PHOTO = 400;

const STATUTS = ["EN_STOCK", "A_VERIFIER", "VENDU", "REBUT"];
const ETATS_BOITIER = ["BON", "MOYEN", "ABIME"];
const FORMAT_CODE_CAISSE = /^C\d{2,}$/;
const FORMAT_EAN = /^\d{13}$/;

/** Violation d'un invariant. Porte son numéro, pour que les tests soient précis. */
class ErreurInvariant extends Error {
  constructor(invariant, message){
    super(`${invariant} — ${message}`);
    this.name = "ErreurInvariant";
    this.invariant = invariant;
  }
}

// ---------------------------------------------------------------------------
// Validation — appliquée à l'écriture ET à la lecture.
//
// À la lecture aussi, parce qu'un enregistrement peut avoir été écrit par une
// version antérieure, relu depuis un export, ou — au lot L2 — descendu de
// Firestore. Un montant flottant qui entre par une de ces portes doit être vu
// là où on le lit, pas propagé en silence.
// ---------------------------------------------------------------------------

function montantValide(champ, valeur, refusPossible){
  if (valeur === null) return;
  if (refusPossible && valeur === "REFUSE") return;   // I-4 : un refus n'est pas un prix nul
  if (!Number.isInteger(valeur)){
    throw new ErreurInvariant("I-6",
      `${champ} doit être un entier de centimes, "REFUSE" ou null — reçu ${JSON.stringify(valeur)}`);
  }
}

function validerDisque(d){
  if (typeof d?.id !== "string" || !d.id)
    throw new ErreurInvariant("I-12", "disque sans id");
  if (d.ean !== null && !FORMAT_EAN.test(d.ean ?? ""))
    throw new ErreurInvariant("I-3", `ean invalide : ${JSON.stringify(d.ean)}`);
  if (!FORMAT_CODE_CAISSE.test(d.caisse ?? ""))
    throw new ErreurInvariant("I-1", `caisse invalide : ${JSON.stringify(d.caisse)}`);
  if (!Number.isInteger(d.position) || d.position < 1)
    throw new ErreurInvariant("I-1", `position invalide : ${JSON.stringify(d.position)}`);
  if (!Number.isInteger(d.quantite) || d.quantite < 1)
    throw new ErreurInvariant("I-6", `quantite invalide : ${JSON.stringify(d.quantite)}`);
  if (!STATUTS.includes(d.statut))
    throw new ErreurInvariant("I-12", `statut inconnu : ${JSON.stringify(d.statut)}`);
  if (d.etatBoitier !== null && !ETATS_BOITIER.includes(d.etatBoitier))
    throw new ErreurInvariant("I-12", `etatBoitier inconnu : ${JSON.stringify(d.etatBoitier)}`);
  if (!Array.isArray(d.genres))
    throw new ErreurInvariant("I-12", "genres doit être un tableau");
  if (!Number.isInteger(d.dateSaisie))
    throw new ErreurInvariant("I-6", "dateSaisie doit être un entier");
  if (d.dateVente !== null && !Number.isInteger(d.dateVente))
    throw new ErreurInvariant("I-6", "dateVente doit être un entier ou null");
  montantValide("prixGibert", d.prixGibert, true);
  montantValide("prixEbay", d.prixEbay, false);
  return d;
}

function validerPhoto(p){
  if (typeof p?.cle !== "string" || !p.cle)
    throw new ErreurInvariant("I-12", "photo sans clé");
  if (!Number.isInteger(p.largeur) || p.largeur < 1)
    throw new ErreurInvariant("I-11", `largeur invalide : ${JSON.stringify(p.largeur)}`);
  if (!Number.isInteger(p.hauteur) || p.hauteur < 1)
    throw new ErreurInvariant("I-11", `hauteur invalide : ${JSON.stringify(p.hauteur)}`);
  // I-11 — le redimensionnement se fait AVANT l'écriture, jamais après.
  // Le store refuse ce qui arrive en pleine résolution : c'est ici que
  // l'invariant devient impossible à contourner.
  if (p.largeur > LARGEUR_PHOTO)
    throw new ErreurInvariant("I-11",
      `photo de ${p.largeur} px de large : elle doit être réduite à ${LARGEUR_PHOTO} px avant écriture`);
  if (!Number.isInteger(p.octets) || p.octets < 1)
    throw new ErreurInvariant("I-6", `octets invalide : ${JSON.stringify(p.octets)}`);
  if (!Number.isInteger(p.dateSaisie))
    throw new ErreurInvariant("I-6", "dateSaisie doit être un entier");
  return p;
}

function validerCaisse(c){
  if (!FORMAT_CODE_CAISSE.test(c?.code ?? ""))
    throw new ErreurInvariant("I-1", `code de caisse invalide : ${JSON.stringify(c?.code)}`);
  if (typeof c.ouverte !== "boolean")
    throw new ErreurInvariant("I-1", "ouverte doit être un booléen");
  if (!Number.isInteger(c.prochainePosition) || c.prochainePosition < 1)
    throw new ErreurInvariant("I-2", `prochainePosition invalide : ${JSON.stringify(c.prochainePosition)}`);
  if (!Number.isInteger(c.capacite) || c.capacite < 1)
    throw new ErreurInvariant("I-6", `capacite invalide : ${JSON.stringify(c.capacite)}`);
  return c;
}

/** I-1 — `caisse` et `position` sont immuables après création. */
function verifierImmuables(ancien, nouveau){
  for (const champ of ["id", "caisse", "position", "dateSaisie"]){
    if (ancien[champ] !== nouveau[champ]){
      throw new ErreurInvariant("I-1",
        `${champ} est immuable après création : ${JSON.stringify(ancien[champ])} → ${JSON.stringify(nouveau[champ])}`);
    }
  }
  return nouveau;
}

/** I-2 — `prochainePosition` ne décroît jamais. */
function verifierProgression(ancienne, nouvelle){
  if (nouvelle.prochainePosition < ancienne.prochainePosition){
    throw new ErreurInvariant("I-2",
      `prochainePosition ne peut pas décroître : ${ancienne.prochainePosition} → ${nouvelle.prochainePosition}`);
  }
  if (nouvelle.capacite < ancienne.capacite){
    throw new ErreurInvariant("I-2",
      `capacite ne peut pas décroître : ${ancienne.capacite} → ${nouvelle.capacite}`);
  }
  return nouvelle;
}

/**
 * Où en est le remplissage d'une caisse.
 * Le store signale, il ne décide pas : ni fermeture automatique, ni blocage
 * (I-5). L'écran avertit, l'utilisateur continue s'il veut.
 */
function etatCapacite(caisse, occupee){
  return {
    annoncee: caisse.capacite,   // la capacité déclarée à l'ouverture, jamais modifiée
    occupee,                     // ce que la caisse contient réellement
    atteinte: occupee >= caisse.capacite,
  };
}

// ---------------------------------------------------------------------------
// IndexedDB — surface volontairement étroite : open, transaction, get, getAll,
// add, put, un index, et `delete` sur le seul magasin `photos`. Rien de plus,
// pour que L2 ait peu à remplacer.
// ---------------------------------------------------------------------------

let basePromesse = null;
let compteurSession = 0;

function promesse(requete){
  return new Promise((resoudre, rejeter) => {
    requete.onsuccess = () => resoudre(requete.result);
    requete.onerror = () => rejeter(requete.error);
  });
}

function ouvrirBase(){
  basePromesse ||= new Promise((resoudre, rejeter) => {
    const requete = indexedDB.open(BASE, VERSION_SCHEMA);
    // Montée de version additive : une base déjà remplie ne doit rien perdre.
    requete.onupgradeneeded = () => {
      const base = requete.result;
      if (!base.objectStoreNames.contains("disques")){
        const disques = base.createObjectStore("disques", { keyPath: "id" });
        disques.createIndex("ean", "ean");   // les fiches sans EAN ne sont pas indexées
        disques.createIndex("caisse", "caisse");
      }
      if (!base.objectStoreNames.contains("caisses"))
        base.createObjectStore("caisses", { keyPath: "code" });
      if (!base.objectStoreNames.contains("meta"))
        base.createObjectStore("meta", { keyPath: "cle" });
      if (!base.objectStoreNames.contains("photos"))
        base.createObjectStore("photos", { keyPath: "cle" });
    };
    requete.onsuccess = () => resoudre(requete.result);
    requete.onerror = () => rejeter(requete.error);
  });
  return basePromesse;
}

async function transaction(magasins, mode, travail){
  const base = await ouvrirBase();
  const tx = base.transaction(magasins, mode);
  const fini = new Promise((resoudre, rejeter) => {
    tx.oncomplete = () => resoudre();
    tx.onerror = () => rejeter(tx.error);
    tx.onabort = () => rejeter(tx.error || new Error("transaction annulée"));
  });
  const resultat = await travail(nom => tx.objectStore(nom));
  await fini;
  return resultat;
}

const copie = valeur => structuredClone(valeur);

const FORMAT_EXPORT = "dvd-stock";

// Les jaquettes voyagent en base64 dans l'export. Tant que L2 n'existe pas,
// l'export est la seule sauvegarde : les perdre obligerait à ressortir chaque
// boîtier des cartons pour les refaire, ce qui n'est pas plus réaliste que de
// tout ressaisir. Le « lourdes et reproductibles » de la SPEC §2 vise le
// régime normal, pas une sauvegarde unique.
function enBase64(tampon){
  const vue = new Uint8Array(tampon);
  const PAS = 0x8000;                       // par tranches : éviter un dépassement de pile
  let binaire = "";
  for (let i = 0; i < vue.length; i += PAS){
    binaire += String.fromCharCode.apply(null, vue.subarray(i, i + PAS));
  }
  return btoa(binaire);
}

function depuisBase64(texte){
  const binaire = atob(texte);
  const vue = new Uint8Array(binaire.length);
  for (let i = 0; i < binaire.length; i++) vue[i] = binaire.charCodeAt(i);
  return vue;
}

async function lireMeta(magasin, cle, defaut){
  const enregistrement = await promesse(magasin.get(cle));
  return enregistrement === undefined ? defaut : enregistrement.valeur;
}

// ---------------------------------------------------------------------------
// API publique — quinze fonctions, et la constante LARGEUR_PHOTO dont photo.js
// a besoin pour réduire au bon format. Rien d'autre.
// ---------------------------------------------------------------------------

/**
 * Ouvre une caisse et lui attribue le prochain code libre.
 * Les codes sont attribués en continu (C01, C02, …) ; un code retiré n'est
 * jamais réattribué, le compteur ne fait que croître.
 */
export async function ouvrirCaisse(capacite){
  if (!Number.isInteger(capacite) || capacite < 1){
    throw new ErreurInvariant("I-6",
      `capacite doit être un entier positif — reçu ${JSON.stringify(capacite)}`);
  }
  return transaction(["caisses", "meta"], "readwrite", async magasin => {
    const meta = magasin("meta");
    const prochain = await lireMeta(meta, "prochainCodeCaisse", 1);
    const caisse = validerCaisse({
      code: "C" + String(prochain).padStart(2, "0"),
      ouverte: true,
      prochainePosition: 1,
      capacite,
    });
    await promesse(magasin("caisses").add(caisse));
    await promesse(meta.put({ cle: "prochainCodeCaisse", valeur: prochain + 1 }));
    return copie(caisse);
  });
}

/**
 * La caisse de travail : la dernière ouverte qui n'a pas été fermée.
 * Plusieurs caisses peuvent l'être en même temps (SPEC §3).
 */
export async function caisseCourante(){
  return transaction(["caisses"], "readonly", async magasin => {
    const toutes = await promesse(magasin("caisses").getAll());
    const ouvertes = toutes.map(validerCaisse).filter(c => c.ouverte);
    if (!ouvertes.length) return null;
    ouvertes.sort((a, b) => a.code.localeCompare(b.code));
    return copie(ouvertes[ouvertes.length - 1]);
  });
}

/**
 * Ferme une caisse. `prochainePosition` est conservée : une caisse rouverte
 * reprendra sa numérotation là où elle s'était arrêtée (I-2).
 */
export async function fermerCaisse(code){
  return transaction(["caisses"], "readwrite", async magasin => {
    const caisses = magasin("caisses");
    const caisse = await promesse(caisses.get(code));
    if (caisse === undefined)
      throw new ErreurInvariant("I-12", `caisse inconnue : ${JSON.stringify(code)}`);
    validerCaisse(caisse);
    const fermee = verifierProgression(caisse, { ...caisse, ouverte: false });
    await promesse(caisses.put(validerCaisse(fermee)));
    return copie(fermee);
  });
}

/**
 * Rouvre une caisse fermée.
 * Ouvrir et rouvrir sont deux intentions distinctes : `ouvrirCaisse` crée une
 * caisse et lui attribue un code neuf, `rouvrirCaisse` reprend une caisse
 * existante. La numérotation repart où elle s'était arrêtée, jamais à 1 (I-2).
 * Rouvrir une caisse déjà ouverte ne fait rien et ne lève pas d'erreur.
 */
export async function rouvrirCaisse(code){
  return transaction(["caisses"], "readwrite", async magasin => {
    const caisses = magasin("caisses");
    const caisse = await promesse(caisses.get(code));
    if (caisse === undefined)
      throw new ErreurInvariant("I-12", `caisse inconnue : ${JSON.stringify(code)}`);
    validerCaisse(caisse);
    const rouverte = verifierProgression(caisse, { ...caisse, ouverte: true });
    await promesse(caisses.put(validerCaisse(rouverte)));
    return copie(rouverte);
  });
}

/** Les caisses, par code croissant. Filtre facultatif : { ouverte }. */
export async function listerCaisses(filtre = {}){
  return transaction(["caisses"], "readonly", async magasin => {
    let caisses = (await promesse(magasin("caisses").getAll())).map(validerCaisse);
    if (filtre.ouverte !== undefined) caisses = caisses.filter(c => c.ouverte === filtre.ouverte);
    caisses.sort((a, b) => a.code.localeCompare(b.code));
    return copie(caisses);
  });
}

/**
 * Ajoute un disque dans la caisse courante.
 * Un EAN déjà présent n'ouvre pas de seconde fiche : la quantité est
 * incrémentée et `doublon` vaut true (I-3). L'emplacement du premier
 * exemplaire est rendu tel quel, jamais recalculé (I-1).
 *
 * Rend `{ disque, doublon, capacite }`. `capacite` porte l'état du remplissage
 * — `{ annoncee, occupee, atteinte }` — pour que l'écran puisse avertir. Le
 * store n'en tire aucune conséquence : il ne ferme rien et ne bloque rien.
 */
export async function ajouterDisque({ ean = null, photoCle = null } = {}){
  if (ean !== null && !FORMAT_EAN.test(ean)){
    throw new ErreurInvariant("I-3", `ean invalide : ${JSON.stringify(ean)}`);
  }
  if (photoCle !== null && typeof photoCle !== "string"){
    throw new ErreurInvariant("I-12", `photoCle invalide : ${JSON.stringify(photoCle)}`);
  }

  return transaction(["disques", "caisses"], "readwrite", async magasin => {
    const disques = magasin("disques");
    const caisses = magasin("caisses");

    const toutes = await promesse(caisses.getAll());
    const ouvertes = toutes.map(validerCaisse).filter(c => c.ouverte)
      .sort((a, b) => a.code.localeCompare(b.code));
    if (!ouvertes.length) throw new ErreurInvariant("I-1", "aucune caisse ouverte");
    const caisse = ouvertes[ouvertes.length - 1];

    const voisins = (await promesse(disques.index("caisse").getAll(caisse.code))).map(validerDisque);

    if (ean !== null){
      const existants = await promesse(disques.index("ean").getAll(ean));
      if (existants.length){
        const ancien = validerDisque(existants[0]);
        const nouveau = verifierImmuables(ancien, { ...ancien, quantite: ancien.quantite + 1 });
        await promesse(disques.put(validerDisque(nouveau)));
        compteurSession++;
        // Un doublon ne consomme aucun emplacement : la caisse ne bouge pas.
        return {
          disque: copie(nouveau),
          doublon: true,
          capacite: etatCapacite(caisse, voisins.length),
        };
      }
    }

    // I-2 — la position visée doit être libre. `prochainePosition` seule ne
    // suffit pas : comparée à la valeur qu'on vient de lire, elle ne détecte
    // pas une valeur déjà revenue en arrière, qui produirait un doublon
    // d'emplacement en silence. On regarde les positions réellement occupées.
    const occupees = new Set(voisins.map(d => d.position));
    if (occupees.has(caisse.prochainePosition)){
      throw new ErreurInvariant("I-2",
        `l'emplacement ${caisse.code}-${String(caisse.prochainePosition).padStart(3, "0")} est déjà occupé — une position libérée n'est jamais réattribuée`);
    }

    const disque = validerDisque({
      id: crypto.randomUUID(),
      ean,
      titre: "",
      tmdbId: null,
      annee: null,
      realisateur: null,
      duree: null,
      genres: [],
      caisse: caisse.code,
      position: caisse.prochainePosition,
      quantite: 1,
      statut: "EN_STOCK",
      prixGibert: null,
      prixEbay: null,
      etatBoitier: null,
      notes: "",
      lotId: null,
      photoCle,
      dateSaisie: Date.now(),
      dateVente: null,
    });

    const capacite = etatCapacite(caisse, voisins.length + 1);
    // `capacite` n'est pas touchée : c'est ce que JM a annoncé à l'ouverture,
    // et l'écart avec `occupee` est précisément ce qu'il faut lui montrer.
    // La relever ferait dire « 5 / 5 » à une caisse annoncée pour trois.
    const avancee = verifierProgression(caisse, {
      ...caisse,
      prochainePosition: caisse.prochainePosition + 1,
    });
    await promesse(disques.add(disque));
    await promesse(caisses.put(validerCaisse(avancee)));
    compteurSession++;
    return { disque: copie(disque), doublon: false, capacite };
  });
}

/** La fiche portant cet EAN, ou null. */
export async function chercherParEan(ean){
  if (ean === null || !FORMAT_EAN.test(ean ?? "")) return null;
  return transaction(["disques"], "readonly", async magasin => {
    const trouves = await promesse(magasin("disques").index("ean").getAll(ean));
    return trouves.length ? copie(validerDisque(trouves[0])) : null;
  });
}

/**
 * Les disques, triés par caisse puis par position croissante — l'ordre du
 * picking. Filtre facultatif : { caisse, statut, avecEan }.
 */
export async function listerDisques(filtre = {}){
  return transaction(["disques"], "readonly", async magasin => {
    let disques = (await promesse(magasin("disques").getAll())).map(validerDisque);
    if (filtre.caisse !== undefined) disques = disques.filter(d => d.caisse === filtre.caisse);
    if (filtre.statut !== undefined) disques = disques.filter(d => d.statut === filtre.statut);
    if (filtre.avecEan === true) disques = disques.filter(d => d.ean !== null);
    if (filtre.avecEan === false) disques = disques.filter(d => d.ean === null);
    disques.sort((a, b) => a.caisse.localeCompare(b.caisse) || a.position - b.position);
    return copie(disques);
  });
}

/** Nombre de disques passés depuis le chargement de l'application. */
export function compterSession(){
  return compteurSession;
}

/**
 * Écrit une jaquette et rend sa clé, à passer en `photoCle` à `ajouterDisque`.
 * L'image doit déjà être réduite : le store refuse toute largeur supérieure à
 * LARGEUR_PHOTO (I-11). C'est photo.js qui réduit, jamais le store.
 */
export async function enregistrerPhoto({ donnees, largeur, hauteur }){
  const octets = donnees?.size;
  const photo = validerPhoto({
    cle: crypto.randomUUID(),
    donnees,
    largeur,
    hauteur,
    octets: Number.isInteger(octets) ? octets : NaN,
    dateSaisie: Date.now(),
  });
  return transaction(["photos"], "readwrite", async magasin => {
    await promesse(magasin("photos").add(photo));
    return photo.cle;
  });
}

/**
 * Remplace la jaquette d'une fiche existante — une photo floue ou mal cadrée
 * doit pouvoir être refaite. La fiche n'est pas recréée : l'emplacement, l'EAN
 * et la date de saisie ne bougent pas (I-1), seule `photoCle` change.
 *
 * L'ancienne image est effacée du magasin `photos`. C'est la seule suppression
 * de tout le store : une jaquette n'est pas une donnée métier — I-12 protège
 * les fiches, pas les images — et laisser s'accumuler des blobs orphelins sur
 * un téléphone n'est pas tenable.
 */
export async function remplacerPhoto(disqueId, { donnees, largeur, hauteur }){
  const octets = donnees?.size;
  const nouvelle = validerPhoto({
    cle: crypto.randomUUID(),
    donnees,
    largeur,
    hauteur,
    octets: Number.isInteger(octets) ? octets : NaN,
    dateSaisie: Date.now(),
  });
  return transaction(["disques", "photos"], "readwrite", async magasin => {
    const disques = magasin("disques");
    const ancien = await promesse(disques.get(disqueId));
    if (ancien === undefined)
      throw new ErreurInvariant("I-12", `disque inconnu : ${JSON.stringify(disqueId)}`);
    validerDisque(ancien);
    const nouveau = verifierImmuables(ancien, { ...ancien, photoCle: nouvelle.cle });
    await promesse(magasin("photos").add(nouvelle));
    await promesse(disques.put(validerDisque(nouveau)));
    if (ancien.photoCle) await promesse(magasin("photos").delete(ancien.photoCle));
    return copie(nouveau);
  });
}

/**
 * Corrige la quantité d'une fiche. Un test de scan répété laisse une fiche à
 * quatre exemplaires qu'il faut pouvoir ramener à un.
 * La quantité reste au minimum à 1 : écarter un disque se fait par le statut
 * REBUT, jamais en le ramenant à zéro (I-12).
 */
export async function corrigerQuantite(disqueId, quantite){
  if (!Number.isInteger(quantite) || quantite < 1){
    throw new ErreurInvariant("I-6",
      `quantite doit être un entier d'au moins 1 — reçu ${JSON.stringify(quantite)}`);
  }
  return transaction(["disques"], "readwrite", async magasin => {
    const disques = magasin("disques");
    const ancien = await promesse(disques.get(disqueId));
    if (ancien === undefined)
      throw new ErreurInvariant("I-12", `disque inconnu : ${JSON.stringify(disqueId)}`);
    validerDisque(ancien);
    const nouveau = verifierImmuables(ancien, { ...ancien, quantite });
    await promesse(disques.put(validerDisque(nouveau)));
    return copie(nouveau);
  });
}

/** La jaquette portant cette clé, ou null. */
export async function lirePhoto(cle){
  if (typeof cle !== "string" || !cle) return null;
  return transaction(["photos"], "readonly", async magasin => {
    const photo = await promesse(magasin("photos").get(cle));
    return photo === undefined ? null : validerPhoto(photo);
  });
}

/**
 * L'intégralité des données, prête à être écrite dans un fichier JSON.
 *
 * `avecPhotos` embarque les jaquettes en base64 — c'est ce qu'il faut pour une
 * vraie sauvegarde. `caisse` limite les fiches à une seule caisse, pour
 * découper un export devenu trop lourd pour la mémoire d'un téléphone. Les
 * caisses et la méta sont toujours entières : chaque morceau reste
 * réimportable seul.
 */
export async function exporterTout({ avecPhotos = false, caisse = null } = {}){
  const paquet = await transaction(["disques", "caisses", "meta"], "readonly", async magasin => {
    let disques = (await promesse(magasin("disques").getAll())).map(validerDisque);
    const caisses = (await promesse(magasin("caisses").getAll())).map(validerCaisse);
    const meta = await promesse(magasin("meta").getAll());
    if (caisse !== null) disques = disques.filter(d => d.caisse === caisse);
    disques.sort((a, b) => a.caisse.localeCompare(b.caisse) || a.position - b.position);
    caisses.sort((a, b) => a.code.localeCompare(b.code));
    return {
      format: FORMAT_EXPORT,
      versionSchema: VERSION_SCHEMA,
      dateExport: Date.now(),
      caisse,
      caisses,
      disques,
      meta,
    };
  });

  if (!avecPhotos) return paquet;

  // Lues une par une : tenir toute la bibliothèque de blobs en mémoire en
  // même temps est précisément ce qui fait échouer un export sur iPhone.
  const photos = [];
  for (const d of paquet.disques){
    if (!d.photoCle) continue;
    const photo = await lirePhoto(d.photoCle);
    if (!photo) continue;
    photos.push({
      cle: photo.cle,
      largeur: photo.largeur,
      hauteur: photo.hauteur,
      octets: photo.octets,
      dateSaisie: photo.dateSaisie,
      type: photo.donnees.type || "image/jpeg",
      donnees: enBase64(await photo.donnees.arrayBuffer()),
    });
  }
  return { ...paquet, photos };
}

/**
 * Réimporte un export. Additif et idempotent : une fiche dont l'identifiant
 * existe déjà est laissée telle quelle, jamais écrasée. C'est ce qui permet de
 * réimporter plusieurs morceaux d'un export découpé, et de rejouer le même
 * fichier deux fois sans dégât.
 *
 * Rien n'est écrit avant que tout ait été validé : un fichier corrompu ne
 * laisse pas la base à moitié restaurée.
 */
export async function importerTout(donnees){
  if (donnees?.format !== FORMAT_EXPORT)
    throw new ErreurInvariant("I-12", `format inconnu : ${JSON.stringify(donnees?.format)}`);
  if (!Array.isArray(donnees.disques) || !Array.isArray(donnees.caisses))
    throw new ErreurInvariant("I-12", "export incomplet : disques ou caisses manquants");

  const caisses = donnees.caisses.map(validerCaisse);
  const disques = donnees.disques.map(validerDisque);
  const photos = (donnees.photos ?? []).map(p => validerPhoto({
    cle: p?.cle,
    largeur: p?.largeur,
    hauteur: p?.hauteur,
    octets: p?.octets,
    dateSaisie: p?.dateSaisie,
    donnees: new Blob([depuisBase64(p?.donnees ?? "")], { type: p?.type || "image/jpeg" }),
  }));

  const bilan = {
    caisses: { ajoutees: 0, fusionnees: 0 },
    disques: { ajoutees: 0, ignorees: 0 },
    photos:  { ajoutees: 0, ignorees: 0 },
  };

  return transaction(["disques", "caisses", "meta", "photos"], "readwrite", async magasin => {
    const C = magasin("caisses"), D = magasin("disques"), P = magasin("photos"), M = magasin("meta");

    for (const c of caisses){
      const existante = await promesse(C.get(c.code));
      if (existante === undefined){
        await promesse(C.add(c));
        bilan.caisses.ajoutees++;
      } else {
        // I-2 : ni la numérotation ni la capacité ne redescendent.
        validerCaisse(existante);
        await promesse(C.put(verifierProgression(existante, {
          ...existante,
          prochainePosition: Math.max(existante.prochainePosition, c.prochainePosition),
          capacite: Math.max(existante.capacite, c.capacite),
        })));
        bilan.caisses.fusionnees++;
      }
    }

    for (const p of photos){
      if (await promesse(P.get(p.cle)) !== undefined){ bilan.photos.ignorees++; continue; }
      await promesse(P.add(p));
      bilan.photos.ajoutees++;
    }

    for (const d of disques){
      if (await promesse(D.get(d.id)) !== undefined){ bilan.disques.ignorees++; continue; }
      await promesse(D.add(d));
      bilan.disques.ajoutees++;
    }

    for (const m of donnees.meta ?? []){
      if (m?.cle !== "prochainCodeCaisse" || !Number.isInteger(m.valeur)) continue;
      const actuel = await lireMeta(M, "prochainCodeCaisse", 1);
      await promesse(M.put({ cle: "prochainCodeCaisse", valeur: Math.max(actuel, m.valeur) }));
    }

    return bilan;
  });
}
