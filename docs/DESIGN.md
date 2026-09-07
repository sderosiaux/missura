# DESIGN.md — Semantic Access Proxy landing

## Thèse de marque
Une phrase : **le proxy rétrécit chaque requête d'agent au périmètre exact de sa mission — la page montre ce rétrécissement partout.**

## Personnalité (3 axes)
1. Déterministe, pas magique — on montre des règles et des traces, jamais de « AI-powered ».
2. Artefact avant illustration — du vrai code, du vrai JSON, de vrais headers.
3. Calme et autoritaire — le ton d'un contrôle qui fonctionne, pas d'une alarme.

## Motif signature
La paire **large → étroit** : listes qui se filtrent, diff `- large / + borné`, tampon de décision `ALLOWED / NARROWED / DENIED` en mono uppercase avec pastille.

## Métaphore visuelle
Un faisceau de requêtes qui traverse un plan de contrôle et ressort réduit. Rendu en SVG fin (traits 1–1.5 px), jamais en 3D ni en orbes.

## Couleurs (CSS variables)
```css
--paper:      #FAF9F5;  /* fond page, blanc chaud */
--paper-deep: #F1EFE9;  /* fonds de blocs artefacts */
--ink:        #17181A;  /* texte principal */
--ink-soft:   #55565C;  /* texte secondaire */
--line:       #E2DFD6;  /* filets, bordures */
--bound:      #0E6B4A;  /* vert « bounded/allow » — accent structurel + CTA */
--bound-soft: #E4F0EA;  /* fond badge allow */
--deny:       #B3382C;  /* rouge « denied/out-of-scope » — usage fonctionnel uniquement */
--deny-soft:  #F7E7E4;  /* fond badge deny */
--code-bg:    #141514;  /* SEULS les blocs code sont sombres : artefact terminal sur page claire */
--code-ink:   #E8E6DF;
```
Règles : page light only. Vert et rouge portent toujours un sens (allow/deny), jamais décoratifs. Contraste AA minimum ; deny/bound doublés d'un label texte (jamais couleur seule).

## Typographie
- Display : **Archivo** (700/600, resserrée, -0.02em) — headlines et titres de section.
- Body : **Archivo** (400/500).
- Artefacts : **IBM Plex Mono** — code, diffs, tokens, JSON, tampons, labels techniques.
Deux familles max ✔ (Google Fonts, licence OFL).

### Échelle
```
h1  clamp(2.4rem, 5.5vw, 4.2rem) / 1.05
h2  clamp(1.7rem, 3vw, 2.4rem) / 1.15
h3  1.25rem
body 1.0625rem / 1.6
mono 0.875rem / 1.55
label mono 0.75rem uppercase +0.08em
```

## Grille & largeurs
- Contenu max 1120 px ; texte courant max 62ch.
- Hero asymétrique : 5/7 texte, 7/12 artefact desktop ; empilé mobile.
- Espacement : échelle 4 px — sections 96–128 px desktop, 64 px mobile.

## Bordures, coins, ombres
- Coins : 6 px max sur blocs artefacts, 4 px sur badges, 999 px interdits sauf pastilles de statut.
- Bordures 1 px `--line` ; blocs code bordure 1 px #2A2B2A.
- Ombres : quasi aucune ; une seule ombre douce autorisée sous le bloc démo hero (`0 24px 48px -32px rgb(0 0 0 / .25)`).

## Icônes & illustration
- Pas de bibliothèque d'icônes comme identité. Icônes limitées à : pastille statut, flèche, check/croix — dessinées inline SVG 1.5 px stroke.
- Illustration = diagrammes SVG originaux (flux, graphe customer:acme). Aucune photo stock.

## Motion
- Une seule idée animée : le rétrécissement (requête traverse → objets hors périmètre s'estompent/barrés ; lignes de log qui apparaissent).
- Durées 300–600 ms, ease-out. Déclenchement au scroll (IntersectionObserver), une fois.
- `prefers-reduced-motion` : tout état final statique, zéro animation.

## Composition
- Desktop : alternance bloc texte / bloc artefact, filets horizontaux pleine largeur comme séparateurs de registre.
- Mobile : artefacts code scrollables horizontalement (pas de wrap destructeur), hiérarchie conservée, hero empilé texte d'abord.

## Interdits pour cette marque
- Dark theme global, gradients violets, orbes/glow, glassmorphism.
- Cards arrondies répétées en grille 3 colonnes par défaut, bento.
- Logos ou métriques inventés ; « AI-powered », « zero trust » en headline.
- Inter/Roboto/Arial. Lucide comme identité.
