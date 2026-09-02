// photo.js — capture de la jaquette, recadrage et redimensionnement.
//
// Capture depuis le flux vidéo DÉJÀ OUVERT par scanner.js : aucun second
// getUserMedia. Rallumer la caméra entre deux disques coûterait une seconde
// ou deux à chaque fois, et c'est ce qui tuerait le geste.
//
// I-11 — l'image est réduite à 400 px de large AVANT d'être rendue, jamais
// après. Ce fichier ne rend jamais une pleine résolution : rien en aval n'a
// l'occasion d'en écrire une.
//
// L'image du flux est en paysage, une jaquette est verticale. Prendre l'image
// entière donnait une bande où la pochette occupait un cinquième de la
// surface — illisible en vignette quoi qu'on fasse ensuite. On recadre donc
// sur la zone du viseur avant de réduire.
//
// `zoneCapture` est la SEULE définition de ce qui est enregistré. app.js s'en
// sert pour dessiner le cadre à l'écran : le viseur et la capture ne peuvent
// pas diverger.
//
// Recadrage automatique et centré, donc — mais toujours aucun cadrage manuel,
// aucune détection de contours, aucune validation : le déclenchement reste
// simple, c'est le cadrage visible qui manquait, pas la confirmation.

import { LARGEUR_PHOTO } from "./store.js";

/** Largeur / hauteur d'un boîtier de DVD (135 × 190 mm). */
export const RAPPORT_JAQUETTE = 135 / 190;

/** Qualités JPEG essayées, dans l'ordre, jusqu'à tenir sous la cible. */
const QUALITES = [0.72, 0.58, 0.45, 0.35];
const CIBLE_OCTETS = 45_000;

const toile = document.createElement("canvas");
const ctx = toile.getContext("2d");

/**
 * La zone de l'image qui sera réellement enregistrée : le plus grand
 * rectangle centré au format d'un boîtier de DVD.
 */
export function zoneCapture(largeurImage, hauteurImage){
  let largeur = largeurImage;
  let hauteur = largeur / RAPPORT_JAQUETTE;
  if (hauteur > hauteurImage){
    hauteur = hauteurImage;
    largeur = hauteur * RAPPORT_JAQUETTE;
  }
  return {
    x: Math.round((largeurImage - largeur) / 2),
    y: Math.round((hauteurImage - hauteur) / 2),
    largeur: Math.round(largeur),
    hauteur: Math.round(hauteur),
  };
}

/**
 * Saisit la zone de jaquette du flux vidéo, réduite et compressée.
 * Rend { donnees: Blob, largeur, hauteur, octets, qualite }.
 * Lève si le flux n'a pas encore d'image exploitable.
 */
export async function capturer(video){
  if (!video || video.readyState < 2 || !video.videoWidth){
    throw new Error("le flux vidéo n'a pas encore d'image");
  }

  const zone = zoneCapture(video.videoWidth, video.videoHeight);

  // Recadrage et réduction dans le même dessin : à aucun instant une pleine
  // résolution n'existe hors du flux vidéo lui-même.
  const largeur = Math.min(LARGEUR_PHOTO, zone.largeur);
  const hauteur = Math.max(1, Math.round(zone.hauteur * (largeur / zone.largeur)));
  toile.width = largeur;
  toile.height = hauteur;
  ctx.drawImage(video, zone.x, zone.y, zone.largeur, zone.hauteur, 0, 0, largeur, hauteur);

  let donnees = null, qualite = null;
  for (const q of QUALITES){
    donnees = await enBlob(toile, q);
    qualite = q;
    if (donnees.size <= CIBLE_OCTETS) break;
  }

  return { donnees, largeur, hauteur, octets: donnees.size, qualite };
}

function enBlob(toile, qualite){
  return new Promise((resoudre, rejeter) => {
    toile.toBlob(
      b => b ? resoudre(b) : rejeter(new Error("compression JPEG impossible")),
      "image/jpeg",
      qualite);
  });
}

/**
 * Une URL affichable pour une jaquette lue en base.
 * L'appelant est responsable de la révoquer quand la vignette disparaît.
 */
export function urlDeLaPhoto(photo){
  return photo ? URL.createObjectURL(photo.donnees) : null;
}
