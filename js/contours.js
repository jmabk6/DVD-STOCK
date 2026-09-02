// contours.js — détection des quatre coins d'une jaquette, et redressement.
//
// Hors périmètre L1. Tout ce qui concerne la détection vit dans ce fichier :
// il doit pouvoir disparaître sans laisser de trace ailleurs qu'aux deux ou
// trois points d'accroche de photo.js et app.js.
//
// Aucune bibliothèque. Sobel, Hough, choix du meilleur quadrilatère et
// homographie tiennent en arithmétique sur des tableaux typés. OpenCV
// coûterait huit mégaoctets de WASM à chaque ouverture pour ces trois cents
// lignes — c'était le défaut de la version qu'on remplace.
//
// La détection ne décide jamais seule : elle rend un quadrilatère ou `null`,
// et l'appelant retombe sur le cadre fixe. Elle n'affiche rien, ne demande
// rien, ne bloque rien.

export const REGLAGES = {
  largeurAnalyse: 320,   // px ; la détection travaille sur une image réduite
  budgetMs: 900,         // au-delà, on abandonne et on prend le cadre fixe
  partCretesFortes: 0.30,     // proportion des crêtes qui amorcent l'hystérésis
  lignesParGroupe: 6,    // lignes les plus fortes retenues de chaque côté
  aireMinimale: 0.10,    // le quadrilatère doit couvrir au moins 10 % de l'image
  aireMaximale: 0.96,
  rapportMin: 0.40,      // largeur/hauteur admissible, perspective comprise
  rapportMax: 1.20,
  appuiMinimal: 0.55,    // proportion de chaque côté réellement posée sur un contour
};

// ---------------------------------------------------------------------------
// Étages de traitement
// ---------------------------------------------------------------------------

function enGris(pixels, n){
  const gris = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4){
    gris[i] = 0.299 * pixels[p] + 0.587 * pixels[p + 1] + 0.114 * pixels[p + 2];
  }
  return gris;
}

/** Trois passes de flou en boîte approchent une gaussienne, pour bien moins cher. */
function flou(source, largeur, hauteur, rayon){
  let a = source, b = new Float32Array(source.length);
  for (let passe = 0; passe < 3; passe++){
    // horizontal
    for (let y = 0; y < hauteur; y++){
      const ligne = y * largeur;
      let somme = 0;
      for (let x = -rayon; x <= rayon; x++) somme += a[ligne + Math.min(largeur - 1, Math.max(0, x))];
      for (let x = 0; x < largeur; x++){
        b[ligne + x] = somme / (2 * rayon + 1);
        const sortant = Math.min(largeur - 1, Math.max(0, x - rayon));
        const entrant = Math.min(largeur - 1, Math.max(0, x + rayon + 1));
        somme += a[ligne + entrant] - a[ligne + sortant];
      }
    }
    [a, b] = [b, a];
    // vertical
    for (let x = 0; x < largeur; x++){
      let somme = 0;
      for (let y = -rayon; y <= rayon; y++) somme += a[Math.min(hauteur - 1, Math.max(0, y)) * largeur + x];
      for (let y = 0; y < hauteur; y++){
        b[y * largeur + x] = somme / (2 * rayon + 1);
        const sortant = Math.min(hauteur - 1, Math.max(0, y - rayon));
        const entrant = Math.min(hauteur - 1, Math.max(0, y + rayon + 1));
        somme += a[entrant * largeur + x] - a[sortant * largeur + x];
      }
    }
    [a, b] = [b, a];
  }
  return a;
}

function sobel(gris, largeur, hauteur){
  const magnitude = new Float32Array(largeur * hauteur);
  const gx = new Float32Array(largeur * hauteur);
  const gy = new Float32Array(largeur * hauteur);
  for (let y = 1; y < hauteur - 1; y++){
    for (let x = 1; x < largeur - 1; x++){
      const i = y * largeur + x;
      const hg = gris[i - largeur - 1], h = gris[i - largeur], hd = gris[i - largeur + 1];
      const g  = gris[i - 1],                                    d = gris[i + 1];
      const bg = gris[i + largeur - 1], b = gris[i + largeur], bd = gris[i + largeur + 1];
      const dx = (hd + 2 * d + bd) - (hg + 2 * g + bg);
      const dy = (bg + 2 * b + bd) - (hg + 2 * h + hd);
      gx[i] = dx; gy[i] = dy;
      magnitude[i] = Math.hypot(dx, dy);
    }
  }
  return { magnitude, gx, gy };
}

/**
 * Affinage : on ne garde d'un contour que sa crête, en comparant chaque pixel
 * à ses deux voisins dans la direction du gradient.
 *
 * Sans cet étage, un seuil global ne peut pas gagner : assez bas pour attraper
 * le bord sombre d'une jaquette, il laisse passer tout le grain du fond ; assez
 * haut pour écarter le grain, il perd le bord. L'affinage réduit les taches de
 * grain à presque rien et laisse les vrais bords intacts.
 */
function affiner(magnitude, gx, gy, largeur, hauteur){
  const crete = new Float32Array(magnitude.length);
  for (let y = 1; y < hauteur - 1; y++){
    for (let x = 1; x < largeur - 1; x++){
      const i = y * largeur + x;
      const m = magnitude[i];
      if (m === 0) continue;
      const angle = ((Math.atan2(gy[i], gx[i]) * 180) / Math.PI + 180) % 180;
      let dx, dy;
      if (angle < 22.5 || angle >= 157.5){ dx = 1; dy = 0; }
      else if (angle < 67.5){ dx = 1; dy = 1; }
      else if (angle < 112.5){ dx = 0; dy = 1; }
      else { dx = -1; dy = 1; }
      if (m >= magnitude[i + dy * largeur + dx] && m >= magnitude[i - dy * largeur - dx]){
        crete[i] = m;
      }
    }
  }
  return crete;
}

/**
 * Hystérésis : deux seuils. Les crêtes les plus franches amorcent, puis on
 * suit leurs voisines encore raisonnables. Un bord faible mais continu est
 * ainsi retenu en entier, tandis qu'un point de grain isolé, n'ayant personne
 * à qui se raccrocher, est laissé de côté.
 */
function seuiller(crete, largeur, hauteur, partHaute){
  const vives = [];
  for (let i = 0; i < crete.length; i++) if (crete[i] > 0) vives.push(crete[i]);
  if (!vives.length) return { contours: new Uint8Array(crete.length), points: [] };
  vives.sort((a, b) => a - b);
  const haut = vives[Math.min(vives.length - 1, Math.floor(vives.length * (1 - partHaute)))] || 1;
  const bas = haut * 0.4;

  const contours = new Uint8Array(crete.length);
  const pile = [];
  for (let i = 0; i < crete.length; i++){
    if (crete[i] >= haut){ contours[i] = 1; pile.push(i); }
  }
  while (pile.length){
    const i = pile.pop();
    const x = i % largeur, y = (i / largeur) | 0;
    for (let dy = -1; dy <= 1; dy++){
      for (let dx = -1; dx <= 1; dx++){
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= largeur || ny >= hauteur) continue;
        const j = ny * largeur + nx;
        if (!contours[j] && crete[j] >= bas){ contours[j] = 1; pile.push(j); }
      }
    }
  }
  const points = [];
  for (let i = 0; i < contours.length; i++) if (contours[i]) points.push(i);
  return { contours, points, haut, bas };
}

// ---------------------------------------------------------------------------
// Hough — les bords d'un boîtier sont des droites, même vus de biais.
// Plus robuste qu'un suivi de contour : un bord interrompu par un reflet ou
// un doigt vote quand même.
// ---------------------------------------------------------------------------

const PAS_ANGLE = 180;

function hough(points, largeur, hauteur){
  const diagonale = Math.ceil(Math.hypot(largeur, hauteur));
  const nbRho = 2 * diagonale + 1;
  const accumulateur = new Int32Array(PAS_ANGLE * nbRho);
  const cos = new Float32Array(PAS_ANGLE), sin = new Float32Array(PAS_ANGLE);
  for (let t = 0; t < PAS_ANGLE; t++){
    const a = (t * Math.PI) / PAS_ANGLE;
    cos[t] = Math.cos(a); sin[t] = Math.sin(a);
  }
  for (const i of points){
    const x = i % largeur, y = (i / largeur) | 0;
    for (let t = 0; t < PAS_ANGLE; t++){
      const rho = Math.round(x * cos[t] + y * sin[t]) + diagonale;
      accumulateur[t * nbRho + rho]++;
    }
  }
  return { accumulateur, nbRho, diagonale, cos, sin };
}

/** Maxima locaux, avec suppression du voisinage pour ne pas retenir dix fois
 *  la même droite. */
function pics(houghResult, combien){
  const { accumulateur, nbRho } = houghResult;
  let maximum = 0;
  for (let i = 0; i < accumulateur.length; i++) if (accumulateur[i] > maximum) maximum = accumulateur[i];
  const plancher = Math.max(12, maximum * 0.22);

  const candidats = [];
  for (let t = 0; t < PAS_ANGLE; t++){
    for (let r = 1; r < nbRho - 1; r++){
      const v = accumulateur[t * nbRho + r];
      if (v < plancher) continue;
      if (v < accumulateur[t * nbRho + r - 1] || v < accumulateur[t * nbRho + r + 1]) continue;
      candidats.push({ t, r, v });
    }
  }
  candidats.sort((a, b) => b.v - a.v);

  const gardes = [];
  for (const c of candidats){
    if (gardes.length >= combien) break;
    const proche = gardes.some(g => {
      const dt = Math.min(Math.abs(g.t - c.t), PAS_ANGLE - Math.abs(g.t - c.t));
      return dt <= 6 && Math.abs(g.r - c.r) <= 14;
    });
    if (!proche) gardes.push(c);
  }
  return gardes.map(g => ({
    theta: (g.t * Math.PI) / PAS_ANGLE,
    rho: g.r - houghResult.diagonale,
    votes: g.v,
  }));
}

/** Sépare les droites en deux familles d'orientation : les deux paires de
 *  bords d'un boîtier sont perpendiculaires, à la perspective près. */
function deuxFamilles(lignes){
  if (lignes.length < 4) return null;
  const reference = lignes[0].theta;
  const ecart = t => {
    let d = Math.abs(t - reference) % Math.PI;
    return Math.min(d, Math.PI - d);
  };
  const a = [], b = [];
  for (const l of lignes) (ecart(l.theta) < Math.PI / 4 ? a : b).push(l);
  if (a.length < 2 || b.length < 2) return null;
  return [a.slice(0, REGLAGES.lignesParGroupe), b.slice(0, REGLAGES.lignesParGroupe)];
}

function intersection(l1, l2){
  const det = Math.cos(l1.theta) * Math.sin(l2.theta) - Math.sin(l1.theta) * Math.cos(l2.theta);
  if (Math.abs(det) < 1e-6) return null;
  return {
    x: (l1.rho * Math.sin(l2.theta) - l2.rho * Math.sin(l1.theta)) / det,
    y: (l2.rho * Math.cos(l1.theta) - l1.rho * Math.cos(l2.theta)) / det,
  };
}

const aire = c => Math.abs(
  (c[0].x * c[1].y - c[1].x * c[0].y) + (c[1].x * c[2].y - c[2].x * c[1].y) +
  (c[2].x * c[3].y - c[3].x * c[2].y) + (c[3].x * c[0].y - c[0].x * c[3].y)) / 2;

function convexe(c){
  let signe = 0;
  for (let i = 0; i < 4; i++){
    const a = c[i], b = c[(i + 1) % 4], d = c[(i + 2) % 4];
    const croix = (b.x - a.x) * (d.y - b.y) - (b.y - a.y) * (d.x - b.x);
    if (croix === 0) continue;
    const s = Math.sign(croix);
    if (signe === 0) signe = s; else if (s !== signe) return false;
  }
  return true;
}

/** Ordonne les coins : haut-gauche, haut-droit, bas-droit, bas-gauche. */
function ordonner(coins){
  const cx = (coins[0].x + coins[1].x + coins[2].x + coins[3].x) / 4;
  const cy = (coins[0].y + coins[1].y + coins[2].y + coins[3].y) / 4;
  const tries = [...coins].sort((a, b) =>
    Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  let depart = 0, meilleur = Infinity;
  for (let i = 0; i < 4; i++){
    const score = tries[i].x + tries[i].y;
    if (score < meilleur){ meilleur = score; depart = i; }
  }
  return [0, 1, 2, 3].map(i => tries[(depart + i) % 4]);
}

/** Proportion d'un côté qui repose réellement sur des pixels de contour. */
function appui(a, b, contours, largeur, hauteur){
  const pas = 40;
  let poses = 0;
  for (let i = 0; i <= pas; i++){
    const x = Math.round(a.x + ((b.x - a.x) * i) / pas);
    const y = Math.round(a.y + ((b.y - a.y) * i) / pas);
    let trouve = false;
    for (let dy = -2; dy <= 2 && !trouve; dy++){
      for (let dx = -2; dx <= 2; dx++){
        const px = x + dx, py = y + dy;
        if (px < 0 || py < 0 || px >= largeur || py >= hauteur) continue;
        if (contours[py * largeur + px]){ trouve = true; break; }
      }
    }
    if (trouve) poses++;
  }
  return poses / (pas + 1);
}

function meilleurQuadrilatere(familles, contours, largeur, hauteur){
  const [famA, famB] = familles;
  const surface = largeur * hauteur;
  let meilleur = null;

  for (let i = 0; i < famA.length - 1; i++){
    for (let j = i + 1; j < famA.length; j++){
      for (let k = 0; k < famB.length - 1; k++){
        for (let l = k + 1; l < famB.length; l++){
          const bruts = [
            intersection(famA[i], famB[k]), intersection(famA[i], famB[l]),
            intersection(famA[j], famB[l]), intersection(famA[j], famB[k]),
          ];
          if (bruts.some(p => !p)) continue;

          const marge = largeur * 0.08;
          if (bruts.some(p => p.x < -marge || p.y < -marge ||
                              p.x > largeur + marge || p.y > hauteur + marge)) continue;

          const coins = ordonner(bruts);
          if (!convexe(coins)) continue;

          const a = aire(coins);
          if (a < surface * REGLAGES.aireMinimale || a > surface * REGLAGES.aireMaximale) continue;

          const cote = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
          const haut = cote(coins[0], coins[1]), bas = cote(coins[3], coins[2]);
          const gauche = cote(coins[0], coins[3]), droite = cote(coins[1], coins[2]);
          const rapport = ((haut + bas) / 2) / ((gauche + droite) / 2 || 1);
          if (rapport < REGLAGES.rapportMin || rapport > REGLAGES.rapportMax) continue;

          const appuis = [
            appui(coins[0], coins[1], contours, largeur, hauteur),
            appui(coins[1], coins[2], contours, largeur, hauteur),
            appui(coins[2], coins[3], contours, largeur, hauteur),
            appui(coins[3], coins[0], contours, largeur, hauteur),
          ];
          if (Math.min(...appuis) < REGLAGES.appuiMinimal) continue;

          const moyenAppui = appuis.reduce((s, v) => s + v, 0) / 4;
          const score = (a / surface) * moyenAppui * moyenAppui;
          if (!meilleur || score > meilleur.score) meilleur = { coins, score, appui: moyenAppui };
        }
      }
    }
  }
  return meilleur;
}

// ---------------------------------------------------------------------------
// Entrée publique
// ---------------------------------------------------------------------------

const toileAnalyse = document.createElement("canvas");
const ctxAnalyse = toileAnalyse.getContext("2d", { willReadFrequently: true });

/**
 * Cherche les quatre coins d'une jaquette dans l'image du flux.
 * Rend { coins, ms, appui } en coordonnées NORMALISÉES (0–1) sur l'image
 * source, ou null si rien de convaincant n'a été trouvé.
 * Ne lève jamais : un échec est un `null`, pas une exception.
 */
export function detecter(video){
  const depart = performance.now();
  try {
    if (!video?.videoWidth) return null;
    const largeur = REGLAGES.largeurAnalyse;
    const hauteur = Math.max(1, Math.round(video.videoHeight * (largeur / video.videoWidth)));
    toileAnalyse.width = largeur;
    toileAnalyse.height = hauteur;
    ctxAnalyse.drawImage(video, 0, 0, largeur, hauteur);
    const pixels = ctxAnalyse.getImageData(0, 0, largeur, hauteur).data;

    const gris = flou(enGris(pixels, largeur * hauteur), largeur, hauteur, 2);
    const { magnitude, gx, gy } = sobel(gris, largeur, hauteur);
    const crete = affiner(magnitude, gx, gy, largeur, hauteur);
    const { contours, points } = seuiller(crete, largeur, hauteur, REGLAGES.partCretesFortes);
    if (points.length < 60) return null;
    if (performance.now() - depart > REGLAGES.budgetMs) return null;

    const lignes = pics(hough(points, largeur, hauteur), 16);
    const familles = deuxFamilles(lignes);
    if (!familles) return null;
    if (performance.now() - depart > REGLAGES.budgetMs) return null;

    const trouve = meilleurQuadrilatere(familles, contours, largeur, hauteur);
    if (!trouve) return null;

    return {
      coins: trouve.coins.map(p => ({ x: p.x / largeur, y: p.y / hauteur })),
      appui: trouve.appui,
      ms: Math.round(performance.now() - depart),
    };
  } catch (e){
    return null;   // la détection ne casse jamais la saisie
  }
}

// ---------------------------------------------------------------------------
// Redressement — homographie du carré unité vers le quadrilatère détecté,
// puis parcours inverse pixel par pixel avec interpolation bilinéaire.
// ---------------------------------------------------------------------------

function homographie(coins){
  const [p0, p1, p2, p3] = coins;   // (0,0) (1,0) (1,1) (0,1)
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, sx = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, sy = p0.y - p1.y + p2.y - p3.y;

  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9){
    return { a: p1.x - p0.x, b: p2.x - p1.x, c: p0.x,
             d: p1.y - p0.y, e: p2.y - p1.y, f: p0.y, g: 0, h: 0 };
  }
  const det = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(det) < 1e-9) return null;
  const g = (sx * dy2 - dx2 * sy) / det;
  const h = (dx1 * sy - sx * dy1) / det;
  return {
    a: p1.x - p0.x + g * p1.x, b: p3.x - p0.x + h * p3.x, c: p0.x,
    d: p1.y - p0.y + g * p1.y, e: p3.y - p0.y + h * p3.y, f: p0.y,
    g, h,
  };
}

/**
 * Redresse la zone délimitée par `coins` (normalisés) en une image de
 * `largeurCible` × `hauteurCible`. Rend un canvas, ou null si l'homographie
 * est dégénérée.
 */
export function redresser(video, coins, largeurCible, hauteurCible){
  const lS = video.videoWidth, hS = video.videoHeight;
  const m = homographie(coins.map(p => ({ x: p.x * lS, y: p.y * hS })));
  if (!m) return null;

  const toileSource = document.createElement("canvas");
  toileSource.width = lS; toileSource.height = hS;
  const ctxSource = toileSource.getContext("2d", { willReadFrequently: true });
  ctxSource.drawImage(video, 0, 0);
  const src = ctxSource.getImageData(0, 0, lS, hS).data;

  const sortie = document.createElement("canvas");
  sortie.width = largeurCible; sortie.height = hauteurCible;
  const ctxSortie = sortie.getContext("2d");
  const image = ctxSortie.createImageData(largeurCible, hauteurCible);
  const dst = image.data;

  for (let y = 0; y < hauteurCible; y++){
    const v = (y + 0.5) / hauteurCible;
    for (let x = 0; x < largeurCible; x++){
      const u = (x + 0.5) / largeurCible;
      const w = m.g * u + m.h * v + 1;
      let sx = (m.a * u + m.b * v + m.c) / w;
      let sy = (m.d * u + m.e * v + m.f) / w;
      sx = Math.min(lS - 1.001, Math.max(0, sx));
      sy = Math.min(hS - 1.001, Math.max(0, sy));

      const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * lS + x0) * 4, i10 = i00 + 4;
      const i01 = i00 + lS * 4, i11 = i01 + 4;
      const p = (y * largeurCible + x) * 4;
      for (let c = 0; c < 3; c++){
        const haut = src[i00 + c] + (src[i10 + c] - src[i00 + c]) * fx;
        const bas  = src[i01 + c] + (src[i11 + c] - src[i01 + c]) * fx;
        dst[p + c] = haut + (bas - haut) * fy;
      }
      dst[p + 3] = 255;
    }
  }
  ctxSortie.putImageData(image, 0, 0);
  return sortie;
}

