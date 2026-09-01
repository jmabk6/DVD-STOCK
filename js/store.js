// store.js — SEULE couche d'accès aux données (I-10).
// Aucun autre fichier ne touche IndexedDB.
//
// Commit 2. L'API à exposer, et rien d'autre :
//   ouvrirCaisse(capacite) -> caisse
//   caisseCourante() -> caisse | null
//   fermerCaisse(code)
//   ajouterDisque({ean, photoCle}) -> {disque, doublon:bool}
//   chercherParEan(ean) -> disque | null
//   listerDisques(filtre) -> disque[]
//   compterSession() -> number
//   exporterTout() -> objet JSON
