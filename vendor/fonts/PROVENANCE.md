# Polices — copies figées

Archivo et DM Mono, licence SIL Open Font 1.1 (`OFL-Archivo.txt`,
`OFL-DMMono.txt`), redistribuables dans le dépôt.

Sous-ensemble **latin uniquement**, récupéré depuis l'API Google Fonts.

| Fichier | Poids | Graisses |
|---|---|---|
| `archivo-latin-var.woff2` | 34 940 o | fonte variable, 100–900 |
| `dm-mono-500-latin.woff2` | 8 724 o | 500 |

Archivo est distribuée en fonte variable : un seul fichier couvre les graisses
400, 600 et 700 utilisées par la maquette, pour moins cher que trois instances
statiques.

Les blocs `@font-face` sont dans `css/app.css`. Aucune requête vers
`fonts.googleapis.com` ni `fonts.gstatic.com` ne subsiste (I-9).
