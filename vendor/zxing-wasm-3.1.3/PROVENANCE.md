# zxing-wasm 3.1.3 — copie figée

Origine : `npm pack zxing-wasm@3.1.3`. Licence MIT, voir `LICENSE`.

Seuls les fichiers du sous-chemin `reader` sont retenus :

| Fichier ici | Origine dans le paquet npm |
|---|---|
| `reader/index.js` | `dist/es/reader/index.js` |
| `reader/zxing_reader.wasm` | `dist/reader/zxing_reader.wasm` |
| `share.js` | `dist/es/share.js` |

`reader/index.js` importe `../share.js` : la disposition ci-dessus conserve ce
chemin relatif intact, aucun remaniement des imports n'est nécessaire.

## Modification apportée

Un seul changement, dans `share.js` ligne 589. Le `locateFile` par défaut du
paquet allait chercher le `.wasm` sur jsDelivr :

```js
return n ? `https://fastly.jsdelivr.net/npm/zxing-wasm@3.1.3/dist/${n[1]}/${e}` : t + e;
```

remplacé par :

```js
return t + e;
```

Le `.wasm` est ainsi résolu à côté du module, dans le dépôt.

`js/scanner.js` fournit de toute façon son propre `locateFile`, mais laisser une
URL de CDN dans le dépôt maintenait un chemin vers le réseau : en cas de
surcharge défaillante, le décodeur aurait basculé sur le CDN sans rien signaler,
et le fonctionnement hors ligne aurait cassé silencieusement (I-9).

## Reproduire

```
npm pack zxing-wasm@3.1.3
tar -xzf zxing-wasm-3.1.3.tgz
```
puis copier les trois fichiers du tableau et rejouer la modification ci-dessus.

## Garde-fou

`test-hors-ligne.js`, à la racine, échoue si une URL externe réapparaît sous
`vendor/` — c'est-à-dire notamment si une re-vendorisation ultérieure oublie de
rejouer la modification ci-dessus.

```
node test-hors-ligne.js
```
