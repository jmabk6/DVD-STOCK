// photo.js — capture de la jaquette et redimensionnement.
//
// Commit 5. Capture depuis le flux vidéo déjà ouvert par scanner.js :
// pas de second getUserMedia. Redimensionnement à 400 px de large AVANT
// écriture, jamais après (I-11). JPEG qualité moyenne, cible ~40 Ko.
