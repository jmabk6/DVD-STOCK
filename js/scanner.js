// scanner.js — caméra, décodage EAN-13, verrou de scan.
// Seul fichier qui touche à getUserMedia et au décodeur.
// Le décodeur est servi par le dépôt, en version figée (I-9).

import { readBarcodes, prepareZXingModule }
  from "../vendor/zxing-wasm-3.1.3/reader/index.js";

// Le .wasm est voisin du module ES. Résolu relativement au module lui-même :
// l'application fonctionne aussi bien à la racine d'un domaine que sous
// /DVD-STOCK/ sur GitHub Pages.
const DOSSIER_DECODEUR = new URL("../vendor/zxing-wasm-3.1.3/reader/", import.meta.url);

export const VERSION_DECODEUR = "3.1.3";

export const REGLAGES = {
  largeurAnalyse: 640,      // px ; réduire accélère le décodage
  delaiRearmementMs: 400,   // I-8 : absence de code avant réarmement
};

const OPTIONS_LECTURE = {
  formats: ["EAN-13"],
  tryHarder: true,
  maxNumberOfSymbols: 1,
};

/** Clé de contrôle EAN-13. Vérifiée avant toute acceptation. */
export function cleEan13Valide(ean){
  if (!/^\d{13}$/.test(ean)) return false;
  let somme = 0;
  for (let i = 0; i < 12; i++) somme += (+ean[i]) * (i % 2 ? 3 : 1);
  return (10 - somme % 10) % 10 === +ean[12];
}

let modulePret = null;

/** Charge le décodeur. Idempotent : les appels suivants rendent la même promesse. */
export function chargerDecodeur(){
  modulePret ||= prepareZXingModule({
    overrides: {
      locateFile: (chemin, prefixe) => chemin.endsWith(".wasm")
        ? new URL(chemin, DOSSIER_DECODEUR).href
        : prefixe + chemin,
    },
    fireImmediately: true,
  });
  return modulePret;
}

/**
 * Crée un scanner attaché à un élément <video>.
 * Rappels, tous facultatifs :
 *   surCode(ean, msDepuisArmement) — lecture acceptée, verrou posé
 *   surEtat(texte, verrouille)     — libellé d'état lisible
 *   surCamera({largeur, hauteur, torche}) — caméra ouverte
 *   surCadence(imagesParSeconde)   — une fois par seconde
 */
export function creerScanner({ video, surCode, surEtat, surCamera, surCadence } = {}){
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  let piste = null, actif = false, decodeurPret = false;
  let verrouille = false, dernierCodeVu = 0, arme = performance.now();
  let torcheAllumee = false;
  let images = 0, debutMesure = performance.now();

  const etat = (texte) => surEtat?.(texte, verrouille);

  async function demarrer(){
    if (actif) return;
    actif = true;
    chargerDecodeur().then(() => { decodeurPret = true; });

    const flux = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });
    video.srcObject = flux;
    piste = flux.getVideoTracks()[0];

    const reglages = piste.getSettings();
    surCamera?.({
      largeur: reglages.width,
      hauteur: reglages.height,
      torche: torcheDisponible(),
    });

    arme = performance.now();
    etat("Présentez le code-barres");
    requestAnimationFrame(boucle);
  }

  function arreter(){
    actif = false;
    piste?.stop();
    piste = null;
    video.srcObject = null;
  }

  async function boucle(){
    if (!actif) return;
    if (decodeurPret && video.readyState >= 2 && !document.hidden){
      const echelle = REGLAGES.largeurAnalyse / video.videoWidth;
      canvas.width = REGLAGES.largeurAnalyse;
      canvas.height = Math.round(video.videoHeight * echelle);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      try {
        const lu = await readBarcodes(
          ctx.getImageData(0, 0, canvas.width, canvas.height), OPTIONS_LECTURE);
        mesurerCadence();
        if (lu.length && lu[0].text) traiter(lu[0].text);
        else if (verrouille && performance.now() - dernierCodeVu >= REGLAGES.delaiRearmementMs) rearmer();
      } catch(e){ /* image illisible : ignorée */ }
    }
    requestAnimationFrame(boucle);
  }

  function traiter(ean){
    dernierCodeVu = performance.now();
    if (verrouille) return;
    if (!cleEan13Valide(ean)) return;   // clé fausse : ni acceptée, ni verrouillée
    verrouille = true;
    etat("Code lu — retirez le boîtier");
    surCode?.(ean, Math.round(performance.now() - arme));
  }

  function rearmer(){
    verrouille = false;
    arme = performance.now();
    etat("Présentez le code-barres");
  }

  function mesurerCadence(){
    images++;
    const ecoule = performance.now() - debutMesure;
    if (ecoule >= 1000){
      surCadence?.(Math.round(images * 1000 / ecoule));
      images = 0;
      debutMesure = performance.now();
    }
  }

  function torcheDisponible(){
    return !!(piste?.getCapabilities && piste.getCapabilities().torch);
  }

  async function basculerTorche(){
    if (!piste) return false;
    try {
      await piste.applyConstraints({ advanced: [{ torch: !torcheAllumee }] });
      torcheAllumee = !torcheAllumee;
    } catch(e){ /* lampe refusée par le matériel */ }
    return torcheAllumee;
  }

  return { demarrer, arreter, basculerTorche, torcheDisponible };
}
