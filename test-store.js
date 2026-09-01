// test-store.js — les cinq invariants de la couche de stockage.
// Usage : node test-store.js
// Sort en erreur si l'un d'eux est violé.
//
// Node n'a pas IndexedDB. Plutôt que d'ajouter une dépendance npm, ou un
// crochet de test dans store.js, on lui donne ici un substitut minimal :
// exactement les six opérations que store.js utilise, et rien de plus.
// Si store.js élargit un jour sa surface IndexedDB, ce substitut cassera —
// c'est voulu, c'est ce qui garde cette surface étroite pour le lot L2.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const RACINE = dirname(fileURLToPath(import.meta.url));

// ===========================================================================
// Substitut d'IndexedDB
// ===========================================================================

// Une requête réelle notifie de façon asynchrone : on reproduit ce délai,
// sans quoi les tests passeraient sur un code qui échouerait dans le navigateur.
// `apres` sert à la transaction pour savoir quand plus rien n'est en vol.
function requete(executer, apres){
  const r = { onsuccess: null, onerror: null, result: undefined, error: null };
  queueMicrotask(() => {
    try { r.result = executer(); r.onsuccess?.(); }
    catch (e){ r.error = e; r.onerror?.(); }
    apres?.();
  });
  return r;
}

class FauxIndex {
  constructor(magasin, cheminCle){ this.magasin = magasin; this.cheminCle = cheminCle; }
  getAll(cle){
    return this.magasin.suivre(() => [...this.magasin.donnees.values()]
      // null et undefined ne sont pas des clés valides : ces enregistrements
      // ne sont pas indexés, exactement comme dans un vrai IndexedDB.
      .filter(v => v[this.cheminCle] !== null && v[this.cheminCle] !== undefined)
      .filter(v => v[this.cheminCle] === cle)
      .map(v => structuredClone(v)));
  }
}

class FauxMagasin {
  constructor(nom, cheminCle, donnees, indexes, tx){
    this.nom = nom; this.cheminCle = cheminCle;
    this.donnees = donnees; this.indexes = indexes; this.tx = tx;
  }
  suivre(travail){ return this.tx.suivre(travail); }
  createIndex(nom, cheminCle){
    this.indexes.set(nom, cheminCle);
    return new FauxIndex(this, cheminCle);
  }
  index(nom){
    if (!this.indexes.has(nom)) throw new Error(`NotFoundError : index ${nom} inconnu sur ${this.nom}`);
    return new FauxIndex(this, this.indexes.get(nom));
  }
  get(cle){
    return this.suivre(() => {
      const v = this.donnees.get(cle);
      return v === undefined ? undefined : structuredClone(v);
    });
  }
  getAll(){ return this.suivre(() => [...this.donnees.values()].map(v => structuredClone(v))); }
  add(valeur){
    return this.suivre(() => {
      const cle = valeur[this.cheminCle];
      if (this.donnees.has(cle)) throw new Error(`ConstraintError : ${this.nom}/${cle} existe déjà`);
      this.donnees.set(cle, structuredClone(valeur));
      return cle;
    });
  }
  put(valeur){
    return this.suivre(() => {
      this.donnees.set(valeur[this.cheminCle], structuredClone(valeur));
      return valeur[this.cheminCle];
    });
  }
}

class FauxTransaction {
  constructor(base, noms){
    this.base = base; this.noms = noms;
    this.enCours = 0; this.terminee = false;
    this.oncomplete = null; this.onerror = null; this.onabort = null; this.error = null;
  }
  objectStore(nom){
    if (!this.noms.includes(nom)) throw new Error(`NotFoundError : ${nom} hors de la transaction`);
    const m = this.base.magasins.get(nom);
    return new FauxMagasin(nom, m.cheminCle, m.donnees, m.indexes, this);
  }
  suivre(travail){
    this.enCours++;
    return requete(travail, () => {
      this.enCours--;
      // Un vrai IndexedDB valide la transaction quand la boucle d'événements
      // rend la main sans requête en attente. Le macrotask laisse d'abord les
      // microtâches enchaîner la requête suivante.
      setTimeout(() => {
        if (this.enCours === 0 && !this.terminee){ this.terminee = true; this.oncomplete?.(); }
      }, 0);
    });
  }
}

class FauxBase {
  constructor(){ this.magasins = new Map(); }
  createObjectStore(nom, { keyPath }){
    const m = { cheminCle: keyPath, donnees: new Map(), indexes: new Map() };
    this.magasins.set(nom, m);
    // Pendant la montée de version, les requêtes ne dépendent d'aucune transaction.
    return new FauxMagasin(nom, keyPath, m.donnees, m.indexes, { suivre: t => requete(t) });
  }
  transaction(noms, _mode){ return new FauxTransaction(this, [].concat(noms)); }
}

function installerFauxIndexedDB(){
  const base = new FauxBase();
  globalThis.indexedDB = {
    open(_nom, _version){
      const r = { onupgradeneeded: null, onsuccess: null, onerror: null, result: base, error: null };
      queueMicrotask(() => { r.onupgradeneeded?.(); queueMicrotask(() => r.onsuccess?.()); });
      return r;
    },
  };
  return base;
}

// ===========================================================================
// Harnais
// ===========================================================================

let echecs = 0, controles = 0;
const messages = [];

function verifier(condition, libelle){
  controles++;
  if (condition) return true;
  echecs++;
  messages.push("  ÉCHEC  " + libelle);
  return false;
}

function egal(obtenu, attendu, libelle){
  return verifier(
    JSON.stringify(obtenu) === JSON.stringify(attendu),
    `${libelle} — attendu ${JSON.stringify(attendu)}, obtenu ${JSON.stringify(obtenu)}`);
}

/** Vrai si `travail` lève une ErreurInvariant portant ce numéro. */
async function leve(invariant, travail, libelle){
  controles++;
  try {
    await travail();
  } catch (e){
    if (e?.invariant === invariant) return true;
    echecs++;
    messages.push(`  ÉCHEC  ${libelle} — attendu ${invariant}, obtenu ${e?.invariant ?? e?.name}: ${e?.message}`);
    return false;
  }
  echecs++;
  messages.push(`  ÉCHEC  ${libelle} — aucune erreur levée, ${invariant} attendu`);
  return false;
}

let compteurImports = 0;
/** Un store neuf, sur une base vide : chaque invariant part d'une page blanche. */
async function storeNeuf(){
  const base = installerFauxIndexedDB();
  const module = await import("./js/store.js?n=" + (++compteurImports));
  return { store: module, base };
}

/** Écrit directement dans la base, en contournant store.js — pour simuler une
 *  corruption, une reprise d'export, ou ce que L2 descendra de Firestore. */
function planter(base, magasin, enregistrement){
  base.magasins.get(magasin).donnees.set(enregistrement[base.magasins.get(magasin).cheminCle], enregistrement);
}
function lireBrut(base, magasin, cle){
  return base.magasins.get(magasin).donnees.get(cle);
}

const EAN_A = "3475001051011";
const EAN_B = "5051889638964";
const EAN_C = "3512392514234";

// ===========================================================================
// I-1 — `caisse` et `position` immuables après création
// ===========================================================================
async function testI1(){
  const { store, base } = await storeNeuf();
  await store.ouvrirCaisse(5);

  const { disque: premier } = await store.ajouterDisque({ ean: EAN_A });
  egal(premier.caisse, "C01", "I-1 : caisse attribuée à l'insertion");
  egal(premier.position, 1, "I-1 : position attribuée à l'insertion");

  // Un doublon ne déplace pas le premier exemplaire.
  const { disque: apresDoublon } = await store.ajouterDisque({ ean: EAN_A });
  egal(apresDoublon.caisse, premier.caisse, "I-1 : la caisse ne bouge pas sur doublon");
  egal(apresDoublon.position, premier.position, "I-1 : la position ne bouge pas sur doublon");
  egal(apresDoublon.id, premier.id, "I-1 : l'identifiant ne bouge pas sur doublon");

  // Le store rend des copies : muter ce qu'il rend ne l'atteint pas.
  premier.caisse = "C99";
  premier.position = 999;
  const relu = await store.chercherParEan(EAN_A);
  egal(relu.caisse, "C01", "I-1 : muter l'objet rendu n'atteint pas le store");
  egal(relu.position, 1, "I-1 : muter la position rendue n'atteint pas le store");

  // Fermer une caisse, en ouvrir une autre : le disque déjà rangé ne bouge pas.
  await store.fermerCaisse("C01");
  await store.ouvrirCaisse(3);
  await store.ajouterDisque({ ean: EAN_B });
  const encore = await store.chercherParEan(EAN_A);
  egal([encore.caisse, encore.position], ["C01", 1],
    "I-1 : l'emplacement survit à la fermeture et à l'ouverture d'une autre caisse");

  // Le cas que I-1 protège vraiment : on rescanne un disque déjà rangé alors
  // qu'une AUTRE caisse est ouverte. Le doublon doit rester à son emplacement
  // d'origine, jamais suivre la caisse courante.
  egal((await store.caisseCourante()).code, "C02", "I-1 : la caisse courante est bien C02");
  const rescan = await store.ajouterDisque({ ean: EAN_A });
  egal(rescan.doublon, true, "I-1 : rescanner depuis une autre caisse donne un doublon");
  egal([rescan.disque.caisse, rescan.disque.position], ["C01", 1],
    "I-1 : le doublon garde son emplacement d'origine, il ne suit pas la caisse courante");
  egal(rescan.disque.quantite, 3, "I-1 : seule la quantité bouge");

  // Aucune fonction n'écrit dans ces champs : contrôle sur la source.
  const source = readFileSync(join(RACINE, "js", "store.js"), "utf8");
  const affectations = source.match(/\.(caisse|position)\s*=[^=]/g) || [];
  verifier(affectations.length === 0,
    `I-1 : store.js ne doit affecter ni .caisse ni .position (trouvé : ${affectations.join(", ")})`);
}

// ===========================================================================
// I-2 — `prochainePosition` ne décroît jamais, une position n'est pas réattribuée
// ===========================================================================
async function testI2(){
  const { store, base } = await storeNeuf();
  await store.ouvrirCaisse(5);

  // Capacité 5, sept disques : la capacité avertit, elle n'arrête pas (commit 3).
  const positions = [];
  for (const ean of [EAN_A, EAN_B, EAN_C, null, null, null, null]){
    const { disque } = await store.ajouterDisque({ ean });
    positions.push(disque.position);
  }
  egal(positions, [1, 2, 3, 4, 5, 6, 7], "I-2 : positions attribuées en continu");
  egal(new Set(positions).size, 7, "I-2 : aucune position en double");

  // Fermer conserve la numérotation.
  const fermee = await store.fermerCaisse("C01");
  egal(fermee.prochainePosition, 8, "I-2 : fermer ne remet pas le compteur à zéro");

  // Rouvrir : la numérotation reprend où elle s'était arrêtée.
  const rouverte = await store.rouvrirCaisse("C01");
  egal(rouverte.prochainePosition, 8, "I-2 : rouvrir ne remet pas le compteur à zéro");
  const { disque: huitieme } = await store.ajouterDisque({ ean: null });
  egal(huitieme.position, 8, "I-2 : une caisse rouverte reprend à 8, pas à 1");

  // Un code de caisse retiré n'est jamais réattribué.
  await store.fermerCaisse("C01");
  const seconde = await store.ouvrirCaisse(4);
  egal(seconde.code, "C02", "I-2 : les codes de caisse ne sont pas réutilisés");

  // Le garde : une `prochainePosition` revenue en arrière ne doit pas produire
  // un emplacement en double, même si elle a été plantée hors du store.
  planter(base, "caisses", { ...lireBrut(base, "caisses", "C01"), ouverte: true, prochainePosition: 3 });
  await store.fermerCaisse("C02");
  await leve("I-2", () => store.ajouterDisque({ ean: null }),
    "I-2 : une position déjà occupée est refusée");
}

// ===========================================================================
// I-3 — un EAN existant n'ouvre pas de seconde fiche
// ===========================================================================
async function testI3(){
  const { store } = await storeNeuf();
  await store.ouvrirCaisse(50);

  const premier = await store.ajouterDisque({ ean: EAN_A });
  egal(premier.doublon, false, "I-3 : première lecture, doublon faux");
  egal(premier.disque.quantite, 1, "I-3 : quantité initiale");

  const second = await store.ajouterDisque({ ean: EAN_A });
  egal(second.doublon, true, "I-3 : seconde lecture, doublon vrai");
  egal(second.disque.quantite, 2, "I-3 : quantité incrémentée");
  egal(second.disque.id, premier.disque.id, "I-3 : pas de seconde fiche");

  const troisieme = await store.ajouterDisque({ ean: EAN_A });
  egal(troisieme.disque.quantite, 3, "I-3 : troisième exemplaire");

  egal((await store.listerDisques()).length, 1, "I-3 : une seule fiche pour trois exemplaires");

  // Un autre EAN ouvre bien une fiche.
  await store.ajouterDisque({ ean: EAN_B });
  egal((await store.listerDisques()).length, 2, "I-3 : un EAN différent ouvre une fiche");

  // Sans code-barres : aucune fusion, chaque boîtier a sa fiche (commit 6).
  await store.ajouterDisque({ ean: null });
  await store.ajouterDisque({ ean: null });
  egal((await store.listerDisques()).length, 4, "I-3 : les fiches sans EAN ne fusionnent jamais");
  egal((await store.listerDisques({ avecEan: false })).length, 2, "I-3 : deux fiches sans EAN");

  egal((await store.chercherParEan(EAN_A)).quantite, 3, "I-3 : chercherParEan rend la fiche unique");
  egal(await store.chercherParEan("9999999999994"), null, "I-3 : EAN absent rend null");
}

// ===========================================================================
// I-6 — montants en centimes entiers, aucun flottant
// ===========================================================================
async function testI6(){
  const { store, base } = await storeNeuf();
  await store.ouvrirCaisse(10);
  const { disque } = await store.ajouterDisque({ ean: EAN_A });

  // I-4 : non vérifié se dit null, pas zéro.
  egal(disque.prixGibert, null, "I-6 : prixGibert non renseigné vaut null, pas 0");
  egal(disque.prixEbay, null, "I-6 : prixEbay non renseigné vaut null, pas 0");
  verifier(Number.isInteger(disque.quantite), "I-6 : quantite est un entier");
  verifier(Number.isInteger(disque.dateSaisie), "I-6 : dateSaisie est un entier");

  // Une capacité non entière est refusée à la porte.
  await leve("I-6", () => store.ouvrirCaisse(2.5), "I-6 : capacité flottante refusée");
  await leve("I-6", () => store.ouvrirCaisse(0), "I-6 : capacité nulle refusée");

  // Un flottant entré par une autre porte — export relu, ou Firestore au lot
  // L2 — doit être vu à la lecture, pas propagé.
  planter(base, "disques", { ...lireBrut(base, "disques", disque.id), prixGibert: 4.5 });
  await leve("I-6", () => store.listerDisques(), "I-6 : prixGibert flottant détecté à la lecture");
  await leve("I-6", () => store.chercherParEan(EAN_A), "I-6 : prixGibert flottant détecté par chercherParEan");
  await leve("I-6", () => store.exporterTout(), "I-6 : prixGibert flottant détecté à l'export");

  // Un montant entier en centimes passe. Un refus aussi : c'est un signal (I-4).
  planter(base, "disques", { ...lireBrut(base, "disques", disque.id), prixGibert: 60 });
  egal((await store.chercherParEan(EAN_A)).prixGibert, 60, "I-6 : 60 centimes acceptés");
  planter(base, "disques", { ...lireBrut(base, "disques", disque.id), prixGibert: "REFUSE" });
  egal((await store.chercherParEan(EAN_A)).prixGibert, "REFUSE", "I-6 : REFUSE accepté (I-4)");
  planter(base, "disques", { ...lireBrut(base, "disques", disque.id), prixEbay: 0.1 });
  await leve("I-6", () => store.listerDisques(), "I-6 : prixEbay flottant détecté");

  // Aucun flottant dans le code lui-même là où il s'agit de montants.
  const source = readFileSync(join(RACINE, "js", "store.js"), "utf8");
  verifier(!/(prixGibert|prixEbay)\s*[:=]\s*\d+\.\d/.test(source),
    "I-6 : aucun montant flottant écrit en dur dans store.js");
}

// ===========================================================================
// I-12 — rien n'est supprimé physiquement
// ===========================================================================
async function testI12(){
  const { store, base } = await storeNeuf();

  // Aucune fonction de suppression n'est exposée.
  const api = Object.keys(store).filter(n => typeof store[n] === "function").sort();
  egal(api, ["ajouterDisque", "caisseCourante", "chercherParEan", "compterSession",
             "exporterTout", "fermerCaisse", "listerCaisses", "listerDisques",
             "ouvrirCaisse", "rouvrirCaisse"],
    "I-12 : l'API est exactement les dix fonctions prévues");
  verifier(!api.some(n => /suppr|efface|retire|delete|remove/i.test(n)),
    "I-12 : aucune fonction de suppression exposée");

  // Ni appel de suppression sur la base.
  const source = readFileSync(join(RACINE, "js", "store.js"), "utf8");
  const suppressions = source.match(/\.(delete|clear)\s*\(/g) || [];
  verifier(suppressions.length === 0,
    `I-12 : store.js ne doit appeler ni delete ni clear (trouvé : ${suppressions.join(", ")})`);

  // Et rien ne disparaît en pratique.
  await store.ouvrirCaisse(3);
  const attendus = new Set();
  for (const ean of [EAN_A, EAN_B, null, EAN_A, null, EAN_C]){
    const { disque } = await store.ajouterDisque({ ean });
    attendus.add(disque.id);
  }
  await store.fermerCaisse("C01");
  await store.ouvrirCaisse(3);
  for (const ean of [null, EAN_A]){
    const { disque } = await store.ajouterDisque({ ean });
    attendus.add(disque.id);
  }

  const tout = await store.exporterTout();
  egal(tout.disques.length, attendus.size, "I-12 : aucune fiche perdue après doublons et fermetures");
  verifier(tout.disques.every(d => attendus.has(d.id)), "I-12 : les fiches exportées sont celles créées");
  egal(base.magasins.get("disques").donnees.size, attendus.size,
    "I-12 : la base contient autant d'enregistrements que de fiches créées");
  egal(tout.caisses.length, 2, "I-12 : une caisse fermée reste dans les données");
  egal(tout.caisses.map(c => c.ouverte), [false, true], "I-12 : la fermeture est un état, pas un retrait");
}

// ===========================================================================
// Caisses — le scénario de validation du commit 3 :
// ouvrir une caisse de 5, y mettre 7 disques, la fermer, en ouvrir une autre,
// vérifier les emplacements.
// ===========================================================================
async function testCaisses(){
  const { store } = await storeNeuf();

  const c1 = await store.ouvrirCaisse(5);
  egal([c1.code, c1.capacite, c1.prochainePosition], ["C01", 5, 1], "caisses : C01 ouverte à 5");

  // Sept disques dans une caisse annoncée à cinq.
  const suivi = [];
  for (let i = 0; i < 7; i++){
    const r = await store.ajouterDisque({ ean: null });
    suivi.push({
      emplacement: r.disque.caisse + "-" + String(r.disque.position).padStart(3, "0"),
      annoncee: r.capacite.annoncee,
      occupee: r.capacite.occupee,
      atteinte: r.capacite.atteinte,
    });
  }

  egal(suivi.map(s => s.emplacement),
    ["C01-001", "C01-002", "C01-003", "C01-004", "C01-005", "C01-006", "C01-007"],
    "caisses : sept emplacements consécutifs dans C01");

  // L'avertissement part au cinquième et ne s'arrête plus.
  egal(suivi.map(s => s.atteinte), [false, false, false, false, true, true, true],
    "caisses : la capacité est signalée atteinte à partir du cinquième disque");
  egal(suivi.map(s => s.occupee), [1, 2, 3, 4, 5, 6, 7], "caisses : occupation suivie disque par disque");

  // La capacité annoncée ne bouge pas : c'est l'écart avec l'occupation qui
  // porte l'information. Une caisse annoncée à 5 et remplie à 7 dit « 7 / 5 »,
  // pas « 7 / 7 ».
  egal(suivi.map(s => s.annoncee), [5, 5, 5, 5, 5, 5, 5],
    "caisses : la capacité annoncée n'est jamais réécrite par le store");
  egal((await store.listerCaisses({ ouverte: true }))[0].capacite, 5,
    "caisses : après sept disques, la caisse annonce toujours cinq");

  // Rien n'a été fermé ni bloqué : le store signale, il ne décide pas (I-5).
  egal((await store.caisseCourante()).code, "C01", "caisses : dépasser la capacité ne ferme pas la caisse");

  // Fermer avant d'être plein est permis, et en ouvrir une autre repart à 1.
  await store.fermerCaisse("C01");
  const c2 = await store.ouvrirCaisse(3);
  egal([c2.code, c2.prochainePosition], ["C02", 1], "caisses : une caisse neuve commence à 1");
  const { disque: premierC2 } = await store.ajouterDisque({ ean: EAN_A });
  egal([premierC2.caisse, premierC2.position], ["C02", 1], "caisses : le disque suivant va dans C02");

  // Un code retiré n'est jamais réattribué.
  await store.fermerCaisse("C02");
  const c3 = await store.ouvrirCaisse(4);
  egal(c3.code, "C03", "caisses : après C01 et C02 fermées, la suivante est C03, pas C01");
  await store.fermerCaisse("C03");
  egal((await store.ouvrirCaisse(4)).code, "C04", "caisses : le compteur de codes ne redescend jamais");

  // Rouvrir reprend la numérotation, sans toucher au code.
  await store.fermerCaisse("C04");
  const reprise = await store.rouvrirCaisse("C01");
  egal([reprise.code, reprise.ouverte, reprise.prochainePosition], ["C01", true, 8],
    "caisses : C01 rouverte reprend à 8");
  const { disque: huitieme } = await store.ajouterDisque({ ean: EAN_B });
  egal(huitieme.caisse + "-" + String(huitieme.position).padStart(3, "0"), "C01-008",
    "caisses : le disque suivant prend C01-008, jamais C01-001");

  // Rouvrir est idempotent ; rouvrir l'inconnu est refusé.
  egal((await store.rouvrirCaisse("C01")).prochainePosition, 9,
    "caisses : rouvrir une caisse déjà ouverte ne change rien");
  await leve("I-12", () => store.rouvrirCaisse("C99"), "caisses : rouvrir une caisse inconnue est refusé");

  // Aucune position en double, sur l'ensemble des caisses.
  const tous = await store.listerDisques();
  const emplacements = tous.map(d => d.caisse + "-" + d.position);
  egal(new Set(emplacements).size, emplacements.length, "caisses : aucun emplacement en double");

  egal((await store.listerCaisses()).map(c => c.code), ["C01", "C02", "C03", "C04"],
    "caisses : listerCaisses rend toutes les caisses, par code croissant");
  egal((await store.listerCaisses({ ouverte: true })).map(c => c.code), ["C01"],
    "caisses : le filtre ouverte fonctionne");
}

// ===========================================================================
// Contrôles complémentaires — pas des invariants, mais l'API doit tenir.
// ===========================================================================
async function testApi(){
  const { store } = await storeNeuf();

  egal(await store.caisseCourante(), null, "API : aucune caisse au départ");
  await leve("I-1", () => store.ajouterDisque({ ean: EAN_A }),
    "API : ajouter sans caisse ouverte est refusé");

  const c1 = await store.ouvrirCaisse(5);
  egal(c1.code, "C01", "API : premier code de caisse");
  egal((await store.caisseCourante()).code, "C01", "API : la caisse courante est la dernière ouverte");

  const c2 = await store.ouvrirCaisse(5);
  egal(c2.code, "C02", "API : deuxième code de caisse");
  egal((await store.caisseCourante()).code, "C02", "API : deux caisses ouvertes, la dernière prime");

  await store.fermerCaisse("C02");
  egal((await store.caisseCourante()).code, "C01", "API : après fermeture, on retombe sur C01");

  egal(store.compterSession(), 0, "API : compteur de session à zéro");
  await store.ajouterDisque({ ean: EAN_A });
  await store.ajouterDisque({ ean: EAN_A });          // doublon : un disque manipulé
  await store.ajouterDisque({ ean: null });
  egal(store.compterSession(), 3, "API : le compteur suit les disques passés, doublons compris");

  await leve("I-3", () => store.ajouterDisque({ ean: "123" }), "API : EAN mal formé refusé");
  await leve("I-12", () => store.fermerCaisse("C99"), "API : fermer une caisse inconnue est refusé");

  const tri = await store.listerDisques();
  const ordonne = [...tri].sort((a, b) => a.caisse.localeCompare(b.caisse) || a.position - b.position);
  egal(tri.map(d => d.caisse + "-" + d.position), ordonne.map(d => d.caisse + "-" + d.position),
    "API : listerDisques trie par caisse puis position");

  const tout = await store.exporterTout();
  verifier(typeof tout.dateExport === "number", "API : l'export porte une date");
  verifier(JSON.parse(JSON.stringify(tout)).disques.length === tout.disques.length,
    "API : l'export survit à un aller-retour JSON");
}

// ===========================================================================

const suites = [
  ["I-1  emplacement immuable", testI1],
  ["I-2  progression des positions", testI2],
  ["I-3  doublons", testI3],
  ["I-6  centimes entiers", testI6],
  ["I-12 aucune suppression", testI12],
  ["      caisses et emplacements", testCaisses],
  ["API  contrôles complémentaires", testApi],
];

for (const [nom, suite] of suites){
  const avant = echecs;
  messages.length = 0;
  try {
    await suite();
  } catch (e){
    echecs++;
    messages.push(`  ÉCHEC  exception non rattrapée : ${e?.stack ?? e}`);
  }
  console.log(`${echecs === avant ? "ok    " : "ÉCHEC "} ${nom}`);
  messages.forEach(m => console.error(m));
}

console.log("");
if (echecs){
  console.error(`${echecs} échec(s) sur ${controles} contrôles.`);
  process.exit(1);
}
console.log(`${controles} contrôles, tous conformes.`);
