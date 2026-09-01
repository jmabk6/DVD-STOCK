// photo.js — capture de la jaquette et redimensionnement.
//
// Capture depuis le flux vidéo DÉJÀ OUVERT par scanner.js : aucun second
// getUserMedia. Rallumer la caméra entre deux disques coûterait une seconde
// ou deux à chaque fois, et c'est ce qui tuerait le geste.
//
// I-11 — l'image est réduite à 400 px de large AVANT d'être rendue, jamais
// après. Ce fichier ne rend jamais une pleine résolution : rien en aval n'a
// l'occasion d'en écrire une.
//
// Aucun cadrage, aucune détection de contours, aucune validation manuelle :
// on prend l'image telle qu'elle est au moment du déclenchement.

import { LARGEUR_PHOTO } from "./store.js";

/** Qualités JPEG essayées, dans l'ordre, jusqu'à tenir sous la cible. */
const QUALITES = [0.72, 0.58, 0.45];
const CIBLE_OCTETS = 45_000;

const toile = document.createElement("canvas");
const ctx = toile.getContext("2d");

/**
 * Saisit une image du flux vidéo et la rend réduite et compressée.
 * Rend { donnees: Blob, largeur, hauteur, octets, qualite }.
 * Lève si le flux n'a pas encore d'image exploitable.
 */
export async function capturer(video){
  if (!video || video.readyState < 2 || !video.videoWidth){
    throw new Error("le flux vidéo n'a pas encore d'image");
  }

  // Le redimensionnement a lieu ici, au moment du dessin : à aucun instant
  // une pleine résolution n'existe hors du flux vidéo lui-même.
  const largeur = Math.min(LARGEUR_PHOTO, video.videoWidth);
  const hauteur = Math.max(1, Math.round(video.videoHeight * (largeur / video.videoWidth)));
  toile.width = largeur;
  toile.height = hauteur;
  ctx.drawImage(video, 0, 0, largeur, hauteur);

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
