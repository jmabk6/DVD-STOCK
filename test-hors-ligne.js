// test-hors-ligne.js — garde-fou de l'invariant I-9 et du cache hors ligne.
// Usage : node test-hors-ligne.js
// Sort en erreur si l'un des contrôles échoue.
//
// Le risque visé n'est pas aujourd'hui : c'est le jour où quelqu'un
// re-vendorisera une version plus récente du décodeur et oubliera de rejouer
// le patch de locateFile, ou collera une balise <link> vers Google Fonts.

const { readdirSync, readFileSync, statSync, existsSync } = require("node:fs");
const { join, relative, extname, sep } = require("node:path");
const { runInNewContext } = require("node:vm");

const RACINE = __dirname;

// test-scan/ utilise légitimement un CDN : c'est la page de test d'origine,
// conservée telle quelle. _archive/ est intouchable. Ni l'un ni l'autre
// n'est servi par l'application.
const DOSSIERS_IGNORES = ["test-scan", "_archive", ".git", "node_modules"];

// Licences et notes de provenance : elles citent des URL à dessein, et le
// navigateur ne les charge jamais.
const EXTENSIONS_DOCUMENTAIRES = [".md", ".txt"];

const URL_EXTERNE = /https?:\/\/[^\s"'`)<>]{4,}/g;
// Les URL locales ne sortent pas de la machine.
const TOLEREES = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/;

let echecs = 0;
const echec = (msg) => { echecs++; console.error("ÉCHEC  " + msg); };
const ok = (msg) => console.log("ok     " + msg);

function parcourir(dossier){
  const sortie = [];
  for (const entree of readdirSync(dossier)){
    const chemin = join(dossier, entree);
    if (statSync(chemin).isDirectory()){
      if (DOSSIERS_IGNORES.includes(entree)) continue;
      sortie.push(...parcourir(chemin));
    } else {
      sortie.push(chemin);
    }
  }
  return sortie;
}

// ---------------------------------------------------------------------------
// I-9 — aucune URL externe dans un fichier que le navigateur charge.
// ---------------------------------------------------------------------------
const fichiers = parcourir(RACINE);
const analyses = [], ignores = [];

for (const chemin of fichiers){
  const nom = relative(RACINE, chemin).split(sep).join("/");
  if (nom === "test-hors-ligne.js") continue;             // ce script lui-même
  if (EXTENSIONS_DOCUMENTAIRES.includes(extname(chemin))){ ignores.push(nom); continue; }
  analyses.push(nom);

  // Lu en latin1 : les binaires sont analysés comme les fichiers texte.
  const contenu = readFileSync(chemin, "latin1");
  const trouvees = [...new Set(contenu.match(URL_EXTERNE) || [])].filter(u => !TOLEREES.test(u));
  for (const u of trouvees) echec(`URL externe dans ${nom} : ${u}`);
}

if (!analyses.length) echec("aucun fichier analysé — le parcours est cassé");
else if (!echecs) ok(`${analyses.length} fichiers sans URL externe (I-9)`);
console.log("       documentation non analysée : " + (ignores.join(", ") || "aucune"));

// ---------------------------------------------------------------------------
// Cache hors ligne — chaque ressource préchargée doit exister.
// `addAll` est atomique : un seul 404 et l'installation échoue en entier,
// donc plus aucun fonctionnement hors ligne, sans message.
// ---------------------------------------------------------------------------
const source = readFileSync(join(RACINE, "sw.js"), "utf8");
const bac = { self: { addEventListener(){} }, caches: {}, fetch(){}, URL };
const sw = runInNewContext(
  source + "\n;({ VERSION, RESSOURCES, HORS_APPLICATION, horsApplication })", bac);

let manquantes = 0;
for (const ressource of sw.RESSOURCES){
  const relatif = ressource.replace(/^\.\//, "") || "index.html";
  if (!existsSync(join(RACINE, relatif))){ echec(`ressource préchargée absente : ${ressource}`); manquantes++; }
}
if (!sw.RESSOURCES.length) echec("sw.js ne précharge rien");
else if (!manquantes) ok(`${sw.RESSOURCES.length} ressources préchargées présentes (cache ${sw.VERSION})`);

// ---------------------------------------------------------------------------
// Portée — test-scan/ et _archive/ doivent passer au réseau, sans interception.
// ---------------------------------------------------------------------------
const PORTEE = "https://jmabk6.github.io/DVD-STOCK/";
const cas = [
  ["https://jmabk6.github.io/DVD-STOCK/",                     false, "la page elle-même"],
  ["https://jmabk6.github.io/DVD-STOCK/js/app.js",            false, "un fichier de l'application"],
  ["https://jmabk6.github.io/DVD-STOCK/vendor/fonts/x.woff2", false, "une ressource vendorisée"],
  ["https://jmabk6.github.io/DVD-STOCK/test-scan/",           true,  "test-scan/ passe au réseau"],
  ["https://jmabk6.github.io/DVD-STOCK/test-scan/index.html", true,  "test-scan/ passe au réseau"],
  ["https://jmabk6.github.io/DVD-STOCK/_archive/index.html",  true,  "_archive/ reste intouché"],
  ["https://cdn.jsdelivr.net/npm/zxing-wasm@3.1.3/x.js",      true,  "une autre origine"],
];
let portee = 0;
for (const [url, attendu, note] of cas){
  const obtenu = sw.horsApplication(url, PORTEE);
  if (obtenu !== attendu){ echec(`portée : ${url} — attendu ${attendu}, obtenu ${obtenu} (${note})`); portee++; }
}
if (!portee) ok(`${cas.length} cas de portée conformes`);

// ---------------------------------------------------------------------------
console.log("");
if (echecs){ console.error(`${echecs} échec(s).`); process.exit(1); }
console.log("Tout est conforme.");
