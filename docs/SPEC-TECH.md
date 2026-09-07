# Spec technique: missura (repo OSS v0)

**Repo:** public, Apache-2.0, TypeScript/Node
**Référence produit:** `spec.md` (PRD v0.2)
**Principe directeur:** chaque milestone livre une garantie de production réelle. Pas de mock vendeur, pas de démo scénarisée. La preuve, c'est ton propre workspace.

## 1. Ce que v0 fait

Un proxy local compatible API vendeur qui:

1. Garde les credentials Linear et GitHub hors de l'agent (vault local).
2. Enferme chaque run d'agent dans une mission courte créée par l'humain.
3. Réduit les requêtes au périmètre de la mission (NARROW).
4. Filtre les réponses objet par objet (FILTER) — **c'est ce qui rend la compatibilité SDK possible**: on laisse passer les requêtes larges que les SDKs génèrent et on nettoie le retour, au lieu d'obliger le développeur à réécrire des requêtes « sûres » (§4.4.1).
5. Bloque tout le reste (DENY, 404 hors-scope).
6. Journalise chaque décision, consultable en live.

Connecteurs v0: **Linear (GraphQL, read-only)** et **GitHub (REST api.github.com, read-only, un ou plusieurs repos)**.

## 2. Modèle de confiance

```text
Humain / orchestrateur          (crée les missions — credential opérateur)
        │
        ▼
missura (proxy + vault + missions)
        │
        ▼
Agent                            (reçoit MISSION_TOKEN + base URLs, rien d'autre)
        │
        ▼
APIs vendeurs                    (ne voient que missura, jamais l'agent)
```

Règles non négociables:

- L'agent ne peut **jamais** créer, étendre ou prolonger une mission. L'API de mission est authentifiée par un credential opérateur absent de l'env agent.
- L'agent ne voit **jamais** un credential vendeur. Injection côté proxy après décision.
- Deny by default: endpoint non catalogué → DENY. Relation non prouvée → 404.
- Aucun LLM dans le chemin de décision. Parsers + règles.
- Les chemins alternatifs GitHub (raw.githubusercontent, codeload, git protocol) sont morts par construction: l'agent n'a pas de token vendeur pour les emprunter.

### 2.1 Équivalences standards — et où missura va plus loin

L'architecture est un flux OAuth2 classique, avec un twist:

| Rôle OAuth2 | Chez missura |
|---|---|
| Authorization Server (`/token`) | Le service de missions — émet le mission token |
| Client confidentiel (détient le secret) | **L'orchestrateur** (clé opérateur) — jamais l'agent |
| Porteur du token | L'agent — consomme, ne peut pas minter |
| Resource Server | Le proxy — valide le token, applique le scope |
| Ressource réelle | L'API vendeur — qui ne trust que ses propres credentials |

Le twist: dans OAuth, le Resource Server valide le token parce qu'il partage la confiance avec l'AS. **Linear et Zendesk ne trusteront jamais un AS tiers.** Le RS doit donc se placer devant le vendeur et convertir: token interne validé → credential vendeur injecté. C'est le **phantom token pattern** des API gateways; le cousin le plus connu est **AWS STS `AssumeRole`** (credentials temporaires, scopés, expirables — sauf qu'AWS contrôle aussi le Resource Server; missura doit l'émuler devant des APIs qui l'ignorent).

Plomberie calquée sur les RFC existantes:

| Standard | Usage missura |
|---|---|
| RFC 6749 `client_credentials` | Grant de création de mission par l'orchestrateur |
| RFC 9396 (RAR) | Format du scope: entités précises, pas des strings `read/write` |
| RFC 7009 | Révocation de mission |
| RFC 7662 (introspection) | Les tools MCP `get_mission`/`check_access` |
| RFC 8693 (token exchange) | Le modèle conceptuel de l'échange token interne → credential vendeur |
| RFC 9449 (DPoP) | Post-v0: lier le token à l'instance d'agent |

Où missura **dépasse** OAuth — la value prop exacte, dans cet ordre:

1. OAuth s'arrête à « ce scope autorise-t-il cet endpoint? ». Missura descend à l'objet: *cette issue appartient-elle au customer de la mission?* — parce que le connecteur comprend la sémantique de l'API.
2. OAuth ne regarde jamais les **réponses**. Le FILTER côté retour n'existe dans aucun Resource Server standard.

## 2.2 Trois modes — l'échelle d'adoption (décisions du 2026-08-15)

Le produit n'a pas un seul curseur sécurité/friction: il en a trois, et ils correspondent aux trois moments de la vie d'un utilisateur. **La distinction porteuse: NARROW ne casse rien, FILTER casse des choses.** Injecter un filtre natif du vendeur réduit la donnée à la source sans toucher aux compteurs, à la pagination ni aux types du SDK. Réécrire la réponse casse les trois — c'est notre différenciant, et c'est le coût qu'on ne peut pas imposer au premier lancement.

| Mode | Écritures / bulk / export / admin | Plafonds | NARROW natif | FILTER réponse | Journal |
|---|---|---|---|---|---|
| `audit` | observé | observés | non | non | complet |
| `hybrid` **(défaut au launch)** | **refusés** | **appliqués** | **appliqué** | non (opt-in) | complet |
| `strict` | refusés | appliqués | appliqué | **appliqué** + marche par type + refus de l'improuvable | complet |

Ce que `hybrid` garantit — et c'est ce qui se vend sans casser le code de personne: aucun credential vendeur dans l'agent, le périmètre natif du vendeur appliqué, un rayon d'action plafonné, une coupure en moins de 5 s, et une trace complète. Ce qu'il ne garantit pas: qu'aucun objet hors périmètre ne revienne. C'est `strict` qui l'apporte, et c'est l'upsell.

**Séquencement (résolution d'une tension entre deux décisions):** le mode `hybrid` ne devient le défaut **qu'avec** les plafonds — sans eux, « lectures permissives » signifie « tout ce que le credential vendeur peut lire », c'est-à-dire exactement ce qu'on vend contre. Les deux partent ensemble en M5. On développe en `strict` d'ici là: sans utilisateurs, la friction ne coûte rien.

## 2.3 Unité de scope: le discriminant natif d'abord (décision du 2026-08-15)

Les vendeurs ne portent presque jamais le concept « client » — Linear l'a prouvé dans la douleur (`Issue` n'a pas de champ `customer`, le lien passe par une collection `needs`). Ils portent en revanche presque tous un **discriminant de tenancy natif**: `repo`, `organization_id`, `project`, `team`, `space`, `tenant_id`.

Règle pour chaque nouveau connecteur, dans cet ordre:
1. **Discriminant natif filtrable côté vendeur** — une injection de filtre, un chemin de propriétaire, aucune casse de compteurs ni de pagination. C'est ce qui rend « toutes les industries » atteignable au lieu de « deux vendeurs modélisés à la main ».
2. **`--actor` (délégation)** comme second axe: l'agent ne dépasse jamais les droits de l'humain qui le déclenche. Aujourd'hui `actor` est de la provenance; le transformer en entrée d'autorisation est parqué (plafond de délégation) — c'est aussi la conversation que le marché tient (la délégation par utilisateur a capté l'argent et les standards).
3. **Entité métier cross-system** (`customer:acme` → les discriminants natifs de chaque système): une **couche de confort** au-dessus des deux premiers, modélisée là où un client la réclame vraiment — pas la fondation.

## 3. UX

### Setup (une fois)

```bash
npx missura init      # wizard: colle LINEAR_API_KEY + GITHUB_TOKEN → vault local chiffré
missura run           # démarre le proxy (localhost, un port par connecteur)
```

### Chaque session (une commande)

```bash
missura exec --scope customer:acme --repo acme/product --ttl 30m -- claude
```

`exec` crée la mission, injecte dans l'env du process enfant:

```text
MISSION_TOKEN=msr_...
LINEAR_API_URL=http://localhost:8481/graphql
GITHUB_API_URL=http://localhost:8482
```

puis lance l'agent (claude, script node, n'importe quoi). Pattern `doppler run --`. L'agent démarre déjà enfermé; expiration ou `missura revoke` le coupe en cours de route.

### Observer

```bash
missura tail          # decision log en live: ALLOW / NARROW / FILTER / DENY
missura missions      # missions actives, TTL restant, révocation
```

### Test de vérité (fait par l'utilisateur, pas mis en scène)

Demander à l'agent un client hors mission → réponse bornée, `DENY` loggé. Sur ses propres données.

### Intégration applicative (production)

`missura exec` n'est que l'habillage CLI. Une vraie app agentique (Python, LangGraph, peu importe) a deux zones, et la frontière humain/agent devient une frontière dans le code:

- **Zone orchestration (trusted)** — le backend déterministe. C'est lui qui appelle le token endpoint avec la clé opérateur:

```python
mission = requests.post("http://missura:8480/v1/token",
    headers={"Authorization": f"Bearer {OPERATOR_KEY}"},
    json={"grant_type": "client_credentials",
          "authorization_details": [{"type": "mission",
              "scope": {"customer": "acme"}, "ttl": 900}]}).json()
```

- **Zone agent (untrusted)** — la boucle LLM + tools. Elle ne reçoit que `MISSION_TOKEN` + les base URLs proxy. Une mission par run par client: l'isolation multi-tenant tombe naturellement, et un run qui dépasse son TTL repasse par l'orchestrateur — l'agent ne peut pas se prolonger.

Contrainte documentée: si boucle LLM et orchestrateur partagent un process, la clé opérateur ne doit jamais être accessible aux tools. L'étanchéité réelle, c'est process/container séparé.

## 4. Architecture

Monorepo pnpm:

```text
packages/
  core/        # missions, tokens, policy engine, decision log, vault
  proxy/       # serveur HTTP data plane, un listener par connecteur
  connectors/
    linear/    # parser GraphQL (AST), catalog, narrow, filter
    github/    # catalog REST, scope repo, filter
  cli/         # init, run, exec, tail, missions, revoke
  mcp/         # serveur MCP d'introspection (M4)
```

### 4.1 Data plane (proxy)

- Un port par connecteur (le domaine/port détermine le connecteur, le chemin reste celui du vendeur — PRD §13).
- Pipeline par requête: authn token → parse (connecteur) → classification action → décision (PASS/NARROW/DENY) → réécriture → injection credential → appel vendeur → FILTER réponse → sanitize erreurs → event log.
- Contrat de compatibilité: PRD §12 (méthodes, chemins, schémas, codes conservés).
- Streaming refusé v0; réponses JSON ≤ 10 MB (PRD §32.3).

### 4.2 Missions & tokens (formes OAuth2)

- Mission: `{ id, purpose, actor, scope: {customer?, repos[]}, connections, allow: [search, read], ttl, jti }`.
- `actor` (M2): **provenance uniquement — PAS une entrée d'autorisation en v0** (voir backlog « plafond de délégation »: le scope effectif devra devenir intersection(intent, entitlements de l'actor)). L'humain responsable — `alice@company.com` (PRD §10/§15). Chaque mission est liée à un owner humain (le « bind agents to human owners »): porté par le token, répété dans chaque événement de provenance. La responsabilité business vit sur la mission (éphémère), pas dans un registre d'agents.
- `purpose` (M2): l'intent métier en clair — « support case #482 », « fraud investigation ». Porté par le token, répété dans chaque événement de provenance. C'est la policy exprimée en langage métier, pas un mécanisme de décision.
- Token signé localement (clé générée à l'init), TTL ≤ 60 min par défaut, `jti` révocable, liste de révocation en mémoire + fichier d'état. Révocation effective < 5 s (PRD §32.4).
- **Circuit breaker** (M3): les `limits` de mission deviennent réactifs — N DENY consécutifs ou limite dépassée → mission auto-révoquée + événement `mission_killed` dans le log. Le kill switch passe de manuel à automatique.
- **Pas de registre d'agents — cattle, not pets**: l'inventaire vivant est `missura missions` (missions actives, TTL restant). Quand rien ne tourne, il est vide. Aucun stock durable d'identités agent chez missura; l'identité durable appartient au stack IAM/NHI du client (F-018), missura la consomme.
- API opérateur (HTTP local + CLI par-dessus), nommée sur les formes OAuth pour lisibilité en revue sécurité:
  - `POST /v1/token` — grant `client_credentials`, scope en `authorization_details` (RAR/RFC 9396)
  - `POST /v1/revoke` — RFC 7009
- Authentification: clé opérateur locale (fichier `~/.missura/`, jamais dans l'env agent). CLI `exec`/`mission create` = wrappers de cette API. **Secret partagé = suffisant en local, insuffisant en entreprise** — voir backlog « authentification opérateur en entreprise » (workload OIDC/mTLS, droit de minter scopé par équipe/intent).

### 4.3 Vault

- Fichier local chiffré (AES-256-GCM); clé dans le keychain OS quand disponible, sinon passphrase.
- Les secrets ne sont jamais loggés ni retournés par aucune API.

### 4.4 Connecteur Linear (GraphQL read-only)

- Parse l'AST complet: variables, arguments inline, aliases, fragments (PRD §21).
- Catalog v0: `issues`, `issue`, `customers` (le sien), `projects`, `comments` — queries uniquement. Toute mutation → DENY. Introspection → DENY par défaut, flag dev pour l'autoriser.
- NARROW: injection `filter.customer.id` dans l'AST/variables; un filtre agent plus restrictif est conservé, un filtre plus large est écrasé.
- FILTER: chaque node de collection vérifié (`belongs_to_customer`); objets hors-scope retirés; champ non-nullable impossible à filtrer → requête DENY avant l'appel (PRD §21.2).
- Pagination: curseur logique missura (REFILL si page trop courte) — PRD §22, version minimale v0: refill borné par coût max.

#### 4.4.1 Limite M2 assumée, et connecteurs conscients du schéma (le moat)

En M2 la traversée du document est validée par une **allowlist de chemins écrite à la main**. C'est sûr (deny-by-default, tout chemin non listé refuse le document entier) mais restrictif: **les méthodes typées du SDK officiel `@linear/sdk` sont refusées**, parce que leurs fragments générés sélectionnent `team`, `project`, `cycle`, `parent`, `reactions`, `sourceComment`… Sous une mission customer-scoped, seul `rawRequest` avec des requêtes écrites à la main passe.

Direction retenue (PRD §40, actif de défensibilité n°1): **connecteurs conscients du schéma vendeur**. Charger le schéma GraphQL Linear — épinglé, versionné, drift testé en CI — donne deux choses qu'une allowlist de chemins ne donnera jamais:
1. le **type de retour** de chaque champ → classification humaine PAR TYPE (customer-scoped: `Issue`, `Customer`, `Comment`, `Attachment` — métadonnée: `Team`, `WorkflowState`, `IssueLabel`, `User`, `Cycle`) au lieu d'énumérer des chemins un par un, connecteur après connecteur;
2. la **nullabilité** → condition nécessaire pour filtrer une réponse sans casser le schéma vendeur (PRD §21.2: un champ non-nullable impossible à filtrer doit forcer un deny AVANT l'appel).

**Point non négociable à retenir: le schéma seul ne restaure PAS la compatibilité SDK.** Le fragment du SDK sélectionne `parent` — une `Issue`, donc customer-scoped: aucune analyse statique ne peut prouver son appartenance avant l'appel. Il faut le laisser passer puis **filtrer la réponse**. Compatibilité SDK = schéma **+** FILTER (M3), jamais l'un sans l'autre. C'est aussi ce qui généralise: la même mécanique (types + nullabilité + filtrage retour) est ce qui rend chaque nouveau connecteur vendeur faisable.

#### 4.4.2 Doctrine: borner la requête quand on peut, filtrer la réponse par défaut

Le refus côté requête est une béquille de M2, **pas la cible**. Un agent qui reçoit un DENY doit reformuler; un agent qui reçoit une réponse filtrée continue son travail. La friction côté requête coûte des tours d'agent — donc des tokens, du temps et du taux d'échec — pour une sécurité qui n'est pas meilleure.

**Mise à jour 2026-08-15:** cette doctrine se scinde selon le mode (§2.2). NARROW natif s'applique dans `hybrid` comme dans `strict` — il ne casse rien. FILTER n'est le défaut qu'en `strict`.

Règle cible (M3, dès que le schéma est là):
- **Laisser passer et filtrer** dès que l'appartenance des objets retournés est prouvable (collections d'objets que le connecteur comprend: issues, tickets, pages).
- **NARROW quand un filtre vendeur natif existe** — moins cher que filtrer, et ça réduit la charge vendeur.
- **Refuser AVANT l'appel dans quatre cas seulement**, ceux où filtrer après ne rattrape rien: (1) écriture ou effet de bord; (2) type non classifié par le connecteur — on ne saurait pas prouver l'appartenance de ce qui revient, donc deny-by-default s'applique au TYPE, pas au chemin; (3) champ non-nullable qu'il faudrait retirer, ce qui casserait le schéma vendeur (PRD §21.2); (4) agrégat ou compteur non recalculable depuis les objets autorisés (PRD §20.4 — un total global révèle ce qu'on cache).

Cas d'école, la recherche GitHub: M2 refuse les `q` contenant `OR`/`AND`/`NOT`/parenthèses/guillemets parce qu'on ne parse pas la grammaire de recherche GitHub. La cible ne la parse pas davantage — elle laisse la requête s'exécuter et **filtre les résultats** sur les repos de la mission (chaque résultat porte son `repository`), en recalculant `total_count`. Le problème disparaît au lieu d'être contourné.

#### 4.4.2bis Limite connue du REFILL (M3) — perte par troncature

La pagination REFILL rejoue des pages vendeur jusqu'à remplir la page demandée (cap: 5 appels supplémentaires ou 10 s). Quand une page de refill ramène **plus** d'objets autorisés que demandé, le surplus est **jeté** et le curseur rendu pointe au-delà: ces objets manquent de la page suivante de l'agent. Les rendre quand même trahirait la longueur du parcours (une page plus longue que demandée = un compteur de pages walkées). La vraie réponse est le curseur logique possédé par missura (SPEC §22), délibérément décalé. **Conséquence à assumer ou à corriger: un agent qui pagine peut manquer silencieusement des objets qu'il avait le droit de voir.** Second effet du même report: un curseur stocké d'une mission à l'autre rejoue une position vendeur que cette mission n'a jamais parcourue.

#### 4.4.3 DÉCISION PRISE (2026-08-15, par l'humain) — ce que « scope client » veut dire dans Linear

Linear ne rattache pas une issue à un client par un champ direct: le lien est `Issue.needs` → `CustomerNeed.customer`, une collection. **Une issue peut donc appartenir à plusieurs clients à la fois** (un bug qui affecte Acme et Globex).

**Retenu: l'option permissive (`some`).** Une issue est dans le scope dès qu'**au moins un** de ses needs pointe sur le client de la mission. La collection `needs` elle-même est filtrée par la règle d'appartenance ordinaire: un `CustomerNeed` d'un autre client est un objet customer-scoped étranger, donc il est retiré. L'issue passe, l'agent ne sait pas qui d'autre est dessus.

**Ce que ça coûte, assumé:** le titre et la description d'une issue partagée peuvent contenir du contexte d'un autre client. C'est du texte libre écrit par un humain — aucune classification par type ne peut le voir, et le seul moyen de l'éviter était de cacher l'issue à tout le monde, y compris à son client légitime.

Concrètement, côté connecteur:
- **NARROW natif** (moins cher que filtrer): `filter: { needs: { some: { customer: { id: { eq: <mission> } } } } }`. Forme lue dans les types d'entrée de `@linear/sdk@90`, pas devinée: `IssueFilter.needs: CustomerNeedCollectionFilter` → `.some: CustomerNeedFilter` → `.customer: NullableCustomerFilter` → `.id: IdComparator` → `.eq: ID`. Un filtre écrit par l'agent est **ANDé** dessous, jamais démonté: `IssueFilter.and` est une conjonction, donc un conjoint ne peut que rétrécir.
- **FILTER** côté réponse: `ownerPath("Issue")` vaut `["needs","nodes","*","customer","id"]`. Le `"*"` du contrat `FilterRule` (packages/core) veut dire « n'importe quel élément de cette collection », et c'est l'extension de contrat que cette décision a rendue nécessaire — un `ownerPath` ne résolvait qu'une feuille unique.

**Rejetées, et pourquoi:**
1. **Stricte (`every`)**: aucune fuite de contexte partagé, mais un bug multi-clients devient invisible pour tout le monde — y compris pour le client légitime, qui est précisément celui qui a besoin de le voir. Le mode d'échec est silencieux (une issue manquante ne se signale pas), ce qui est pire qu'une fuite de contexte visible dans un titre.
2. **Autre unité de scope (projet, équipe)**: change la promesse produit (« scope client ») pour contourner une difficulté d'implémentation, et l'entity map (§4.6) est déjà écrite en `customer:`. À reconsidérer si l'objet `Customer` de Linear s'avère peu utilisé chez les vrais clients — c'est une question de terrain, pas de schéma.

### 4.5 Connecteur GitHub (REST read-only)

- Catalog v0 (allowlist stricte, tout le reste DENY): `GET /repos/{o}/{r}`, `/issues`, `/issues/{n}`, `/issues/{n}/comments`, `/pulls` (list/get), `/contents/{path}`, `/search/issues` (avec `repo:` forcé).
- Scope: liste de repos de la mission. Repo hors mission → 404 (anti-énumération).
- `/search/issues`: qualifier `repo:` injecté; qualifiers élargissants retirés.
- URLs signées / redirects vers domaines publics: réécrits ou bloqués (PRD §20.7).

### 4.6 Le graphe d'entités — l'objet central, et il est vivant

Le mapping cross-system n'est pas une config d'appoint: c'est **l'entité principale du produit**. Une mission ne sait ce qu'elle couvre que parce que le graphe dit qu'un client vit à tel endroit dans Zendesk, tel autre dans Linear, tel autre dans GitHub. Tout le reste — narrowing, filtrage, refus — n'est que l'exécution de ce que le graphe affirme.

Un graphe: des **entités** (`customer:adeo`), et pour chacune des **liens** vers un système, chaque lien portant son id natif, son **évidence** (la phrase qui dit pourquoi on y croit), sa **méthode** (`deterministic` | `inferred` | `manual`) et son **statut** (`proposed` | `confirmed` | `rejected` | `broken`).

```json
"customer:adeo": {
  "displayName": "ADEO",
  "domains": ["adeo.com", "leroymerlin.fr", "leroymerlin.es"],
  "links": [
    { "system": "zendesk", "id": "360000123456", "method": "deterministic", "status": "confirmed",
      "evidence": "domain leroymerlin.es matches requester email",
      "confirmedBy": "ops@missura.dev", "confirmedAt": "2026-08-14T09:12:03.000Z" },
    { "system": "linear", "id": "c_18", "method": "inferred", "status": "proposed",
      "evidence": "Linear customer name \"Adeo\" matches display name" }
  ]
}
```

**Règle unique et non négociable: seul un lien `confirmed` élargit une mission.** Un lien `proposed` — donc toute inférence automatique — est visible, auditable, et sans effet sur l'enforcement. Le produit peut suggérer autant qu'il veut; il ne peut jamais s'auto-autoriser. C'est la réponse au risque de fond (un mapping faux = une fuite cross-client): l'inférence porte le coût de la découverte, l'humain porte le coût de l'engagement, et les deux sont séparés dans le temps.

Une entité peut être ancrée sur des **domaines** (le seul matching sûr en pratique: le domaine de l'email du demandeur), et un domaine ne peut appartenir qu'à une seule entité — sinon la clé de jointure n'est plus une clé. Deux entités qui revendiquent le même domaine, ou deux liens Linear `confirmed` sur une même entité, sont une erreur de chargement: le graphe refuse de s'ouvrir avant qu'un token existe.

**Un fichier aujourd'hui, une base demain — derrière une interface, dès maintenant.** La résolution ne reçoit jamais un chemin, elle reçoit un lecteur (`entities()`, `entity(key)`, `entityForDomain(domain)`, `linksTo(system, id)`). Le POC lit un JSON versionné dans git; la version suivante lit une table avec un historique d'états, sans qu'aucune ligne de la résolution ne bouge. La seule écriture qui peut produire un `confirmed` est celle qui exige un nom d'humain.

**Trois directions de résolution**, parce que le déclencheur n'est pas toujours le même:
- depuis une entité (`customer:adeo`) — le cas nominal, opérateur ;
- depuis un id natif (`zendesk:360000123456`) — le cas webhook: un ticket arrive, on ne connaît que l'organisation Zendesk ;
- depuis un domaine (`leroymerlin.es`) — le cas email: on ne connaît que le demandeur.

Principe produit inchangé: **l'agent n'a pas besoin de savoir où vit le client — la mission le sait.** Le graphe sert l'enforcement ET la découverte (introspection §4.8). Limite non négociable (PRD §2, §8): pas d'API unifiée, pas de requête « tout Adeo » en un appel, pas d'index de données — l'agent parle toujours l'API de chaque vendeur.

### 4.6bis Missions dégradées — ne jamais bloquer, toujours signaler

Un flux automatique n'a pas d'humain dedans. Un ticket qui arrive à 3h du matin ne peut pas attendre une validation, et « le mapping n'est pas confirmé donc rien ne part » est un incident produit, pas une posture de sécurité.

La règle: **une mission se mint toujours, sur ce qui est prouvé, et rien d'autre.** Les liens `confirmed` entrent dans le scope. Les liens `proposed`, `rejected`, `broken` n'y entrent pas et deviennent chacun une **dégradation** enregistrée sur la mission. L'agent travaille sur un périmètre strictement plus étroit; les systèmes non résolus lui répondent comme s'ils n'existaient pas pour lui.

| Situation | Ce qui se passe |
|---|---|
| Aucun lien confirmé, id natif connu | Scope = ce seul id natif, un seul système. L'agent travaille chez lui, nulle part ailleurs. |
| Id natif inconnu du graphe | Idem, dégradation `no_entity`. Le système d'origine reste accessible; aucun autre ne s'ouvre. |
| Deux entités revendiquent le même id | Le graphe **ne choisit pas et ne fusionne pas**. Scope natif seul, dégradation `ambiguous_entity`. |
| Lien seulement `proposed` | Ce système est hors mission, dégradation `link_proposed`. |
| Entité disparue du graphe | **Échec du mint.** Une entité qu'on ne sait plus décrire ne peut pas être un périmètre. |

L'asymétrie de la dernière ligne est délibérée: un id natif inconnu est une **ignorance** (on dégrade), une entité nommée qui n'existe plus est une **incohérence** (on refuse). La provenance de tout ça vit sur la mission et dans le journal de décision: par quelle direction le scope a été résolu, quels liens l'ont construit, lesquels ont été refusés et pourquoi. L'évidence d'un lien est du texte écrit par un opérateur et n'atteint jamais une ligne de log — les événements sont reconstruits champ par champ, jamais copiés par référence.

**Une mission dégradée n'est pas un incident, c'est un signal.** Elle dit exactement l'une de deux choses: soit un mapping attend une confirmation humaine, soit — et c'est le cas intéressant — **ce cas d'usage n'est pas sécurisable en l'état**, parce que le lien qu'il exige n'existe dans aucun système sous une forme prouvable. Un taux de dégradation qui ne baisse jamais sur un flux donné n'est pas un défaut de remplissage: c'est la découverte que ce flux demande à un agent de traverser une frontière que personne n'a jamais matérialisée.

### 4.6ter Remonter la dégradation à qui peut la corriger

Une dégradation silencieuse est une régression invisible: l'agent devient discrètement moins utile et personne ne l'apprend. Trois étages, dans cet ordre de construction:

1. **Métriques** (immédiat) — compteurs par système, par raison, par entité. Suffit à répondre « est-ce que ça empire ? ».
2. **Une table et une UI** — les dégradations deviennent des lignes durables, avec l'entité, le système, la raison, la première et la dernière occurrence, et le lien `proposed` en attente. C'est là que se fait la confirmation: un humain lit l'évidence, confirme ou rejette, et le graphe change d'état.
3. **Un email à l'auteur de l'agent** — pas à une boîte d'ops anonyme: à la personne qui a programmé l'agent, celle qui constatera qu'il rend des réponses incomplètes. Le mail porte le chemin de correction exact (l'entité, le lien à confirmer, ce que la mission gagnerait), jamais la donnée du système concerné.

Non-fuite: ces trois canaux parlent de **structure** (une entité, un système, un statut), jamais de contenu. Un opérateur qui n'a pas accès au Zendesk du client ne doit rien apprendre de son contenu en lisant nos alertes.

### 4.6quater Le contrat côté agent: nomme l'entité sur laquelle tu travailles

Corollaire des deux sections précédentes, et c'est ce que le produit demande en échange de ce qu'il donne: **une mission doit nommer une entité, ou un id natif qui en tient lieu.** Un agent « généraliste », sans entité, ne reçoit rien — non par punition, mais parce qu'il n'existe aucun périmètre à lui accorder. Le scope-all n'est pas un mode dégradé du produit, c'est son contraire.

Ce contrat est aussi ce qui rend le reste possible: parce que l'agent nomme son entité et rien d'autre, il n'a pas besoin de connaître les systèmes, les ids, ni la topologie — et il ne peut pas les découvrir par tâtonnement.

### 4.7 Decision log — provenance tamper-evident

- JSONL local (`~/.missura/decisions/`), schéma PRD §26: mission, purpose, actor, provider, operation, action, decision, resources, objets retirés, latence, request id.
- **Hash-chaining** (M3): chaque événement référence le hash du précédent (segments scellés). « Immutable audit trail » devient une propriété vérifiable, pas un slogan.
- Pas de corps stockés. `missura tail` = stream lisible avec couleurs ALLOW/NARROW/FILTER/DENY.

### 4.7bis Télémétrie (très important)

- **M2 — propagation `traceparent`** (W3C Trace Context): le proxy relaie les headers de tracing de l'agent vers le vendeur et les corrèle dans le decision log. Trivial, indispensable aux platform teams.
- **M4 — spans OpenTelemetry**: chaque décision émise comme span OTel (mission = trace parente logique); export OTLP standard.
- **M4 — export SIEM** (PRD F-017): stream JSONL/webhook des événements de décision vers Splunk/Datadog/etc.

### 4.8 MCP d'introspection (lecture seule, jamais de minting)

Serveur MCP (`claude mcp add missura`) qui lit `MISSION_TOKEN` dans son env — il vit donc dans la boundary de la mission:

| Tool | Retour |
|---|---|
| `get_mission()` | purpose, scope, **entity map de la mission** (systèmes en scope + actions permises par système), TTL restant |
| `check_access(resource, action)` | allowed / denied + catégorie de raison (jamais de données) |
| `explain_denial(request_id?)` | explication de la dernière décision DENY/FILTER (PRD §9.7) |

C'est de l'introspection de token au sens RFC 7662, exposée en MCP — et c'est aussi la **découverte**: l'agent n'a pas à hardcoder « les infos client sont dans Linear et Zendesk », il le demande, et la réponse est bornée à sa mission.

Valeur: l'agent planifie dans son périmètre, s'auto-corrige après un DENY, brûle moins d'appels. `check_access` ne révèle jamais l'existence d'une ressource, seulement sa position vis-à-vis du scope.

Hors-scope MCP: aucun tool d'accès aux données, aucun tool de création/extension de mission.

### 4.8bis Erreurs actionnables (un DENY doit enseigner, pas seulement bloquer)

Une erreur rendue à un agent **est un prompt**. Un refus diagnostique (« field `team` is outside the mission traversal allowlist ») fait boucler l'agent ou halluciner un contournement; un refus actionnable le fait se corriger en un tour. C'est une exigence produit, pas du confort: elle décide du nombre de tours, donc du coût et du taux de réussite d'une mission. Aujourd'hui: le principe existe (PRD §9.7 « erreur exploitable ») et l'introspection MCP est prévue (§4.8), mais **il n'y a aucun contrat de remédiation** — les `reason` sont diagnostiques.

Contrat (M3): chaque refus porte, en plus de la forme vendeur attendue par le SDK, un bloc missura lisible par une machine ET par un LLM:

```json
{"error": {"code": "missura_denied", "reason": "field `team` cannot be proven to belong to your mission",
  "mission": {"scope": "customer:acme", "allowed_actions": ["search","read"], "expires_in": 1420},
  "remediation": "drop `team` from the selection, or read it via an object already in scope",
  "try_instead": ["issues(filter:{customer:{id:{eq:$missionCustomer}}}) { nodes { id title } }"],
  "introspect": "mcp: get_mission / check_access"}}
```

Règle de non-fuite, non négociable (PRD §9.7): la remédiation se dérive **du périmètre que l'agent connaît déjà** (sa propre mission), jamais de la cible refusée. « Ta mission couvre customer:acme, retire le champ `team` » est permis. « ISS-12 appartient à globex » ne l'est pas — ça confirmerait l'existence d'un objet hors périmètre, et transformerait nos messages d'erreur en oracle d'énumération.

Mesure: **nombre de tours entre un DENY et l'appel réussi qui suit** (cible: 1). C'est la métrique qui dit si l'enforcement est utilisable par un agent, pas seulement correct.

### 4.9 Mode forward proxy (post-v0)

Le mode v0 est un reverse proxy (base URL changée). Le mode 2, prévu post-v0 pour les apps en container: forward proxy transparent (`HTTPS_PROXY=missura`), même pipeline, seule la porte d'entrée change.

- Coût: terminaison TLS avec CA locale trustée par l'env agent (`NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`…), et respect inégal de `HTTP_PROXY` selon les runtimes (Node fetch: non par défaut).
- Gain: couvre curl et toute lib non prévue, et transforme le deny-by-default en **egress control** — avec une NetworkPolicy « seule sortie = missura », l'agent ne peut physiquement pas contourner (PRD §28 renforcée par le réseau). `403` sur host hors catalogue, `404` hors-scope conservé.
- Un changement reste obligatoire même en forward: retirer les vrais credentials de l'app (mission token à la place). `missura exec` pourra injecter `HTTPS_PROXY` + CA automatiquement.

### 4.10 Délégation sub-agents (spécifié, construit post-v0)

Quand un agent spawne un sous-agent, la mission suit une règle unique: le sous-agent hérite du même token, ou d'un **token dérivé strictement plus étroit** (delegation RFC 8693, claim `act` pour la chaîne User → Agent A → Agent B). Jamais plus large, jamais plus long. La chaîne complète apparaît dans la provenance. Rien à coder en v0 — le modèle est posé pour ne pas se peindre dans un coin.

## 5. Non-goals v0

Writes et approbations (PRD §24) · Zendesk, Notion, Slack · multi-tenant SaaS, VPC, SSO · webhooks, subscriptions GraphQL, WebSocket · suggestion automatique de mappings · UI web (CLI only) · mode forward proxy (§4.9) · DPoP · délégation sub-agents (§4.10, spécifié seulement) · registre durable d'agents (§4.2 — cattle, not pets) · outil de découverte/scan de tokens existants.

**Parqué pour plus tard (à ne pas oublier) — entity memory:** les agents raisonnent sur un client et voudront stocker ce raisonnement pour le réutiliser (mémoire par use case). Extension naturelle de l'entity map: un espace d'état par entité métier (`memory:customer:acme`), écrit et lu PAR les missions scopées sur cette entité, avec la même enforcement (une mission acme ne touche jamais la mémoire globex), TTL/purge propres, et provenance des écritures. Ce n'est PAS une copie des données vendeurs (§9.6 PRD reste intact): c'est du contenu produit par l'agent. Règles de contenu à prévoir (risque PRD §48.7: écrire des données sensibles dans la mémoire). Post-v0, après le premier pilote.

**Parqué — dynamic vendor credentials (downscoping natif):** quand le vendeur sait minter des credentials scopés (GitHub Apps: installation tokens par repos/1 h; AWS STS; rôles DB éphémères), missura échange sa connexion root contre un credential éphémère au périmètre de la mission, l'injecte, puis expire/révoque. Réduit le risque « missura détient des god tokens » (défense en profondeur), donne une identité par mission dans l'audit du vendeur, et répond à « auto-provisioning/rotating ephemeral credentials ». Compose avec l'enforcement sémantique (seul mécanisme quand le vendeur n'offre rien: Linear). Couture: `vendorAuthHeader()` devient par-mission. Candidat naturel: connecteur GitHub → GitHub App.

**Parqué — Mission BOM (la tranche accès de l'AI-BOM):** on ne voit ni modèles ni prompts, mais on possède la meilleure tranche: par mission — actor, purpose, modèle déclaré par l'orchestrateur (métadonnée de mission), systèmes touchés, objets lus/retirés/refusés, chaîne de délégation, request IDs vendeurs, policy versions, le tout hash-chained. `missura report <mission>` exportable pour auditeurs et incident responders. TASK: cadrer ce qu'on revendique vs l'AI-BOM complet (models/datasets = hors périmètre, à déclarer, pas à inférer).

**Parqué — intents (intent-aware policy, forme déterministe):** les « mission templates » de la PRD sont renommés **intents**. Un intent est une policy nommée, écrite par un humain, versionnée: `fraud-investigation` = { objets lisibles, actions, TTL max, exports interdits, writes sous approbation }. Au mint: `--intent fraud-investigation --customer acme` → l'intent se compile en catalogues/scopes déterministes, et contraint la forme de la mission elle-même (cohérence vérifiée à la création: cet intent exige un client unique). Les approbations (PRD §24) se branchent sur l'intent. Le triptyque devient: IAM = who, missura = what, intent = why. Post-v0 (avec le control plane). NON-GOAL permanent: l'intent inféré par un LLM au runtime (« cette requête sert-elle vraiment l'investigation? ») — l'intent est choisi côté trusted au mint, jamais deviné.

**Parqué — vector stores comme connecteurs (gouverner le RAG, pas le construire):** les index vectoriels d'entreprise sont l'endroit où les fuites cross-tenant arrivent réellement (un filtre de metadata oublié → les documents d'un autre client dans le contexte). Connecteur vector-store (Pinecone, pgvector, Elastic): missura injecte le filtre de mission dans la requête (`filter: customer = acme` — natif chez ces moteurs) et vérifie les résultats au retour. NARROW/FILTER appliqué à la recherche vectorielle — même logique de délégation native que SQL/Kafka. L'entity map reste notre knowledge graph autoritaire (petit, humain, déterministe — c'est lui qui grounde via l'introspection MCP). L'entity memory pourra recevoir de la retrieval (embeddings sur du contenu PRODUIT PAR L'AGENT uniquement). **Ligne rouge permanente: missura n'embedde ni n'indexe jamais la donnée vendeur (PRD §8/§9.6) — on gouverne l'enrichissement sémantique, on ne le construit pas.**

**Parqué — streaming & databases (TASK de cadrage à discuter):** classe différente (protocoles binaires, sessions stateful — pas HTTP parseable). Position par défaut: délégation native d'abord, jamais de data-path proxy en premier. Databases: rôle éphémère + Row-Level Security portant le contexte de mission (la base enforce, missura orchestre + audite) — pas de SQL rewriting v1. Kafka: gros grain natif (ACLs topic + SASL/OAUTHBEARER — le mission token peut être directement le credential Kafka); grain fin par message = territoire des gateways Kafka existantes (synergie vs conflit à trancher). L'entity map s'étend: `customer:acme → postgres: tenant_id, kafka: topics acme.*`.

**Parqué — substrat télémétrique (tout métadonnées-seules, déterministe — après le PMF):** on s'est cadrés couche d'enforcement; ces 4 items font de missura un substrat dont les AMP/SIEM/gouvernance dépendent, sans jamais toucher la donnée vendeur. PRIORITÉ APRÈS avoir prouvé la valeur cœur (NARROW/FILTER/provenance) — pas dans le chemin critique v0.
1. **OpenTelemetry-first**: chaque décision émise en span OTLP natif (mission = trace, décision = span, allow/narrow/deny/latence en attributs) — missura devient citoyen de première classe de l'observabilité client (déjà dans Grafana), pas un sidecar de logs. À sortir de la note M4 en engagement propre le moment venu. Meilleur ratio levier/risque.
2. **Policy-as-Code portable**: la policy en fichier déclaratif, diffable, signable, lisible par un responsable conformité sans lire notre code — les catalogues/intents compilent DEPUIS cet artefact. Foyer naturel des intents parqués.
3. **API de lecture gouvernance**: surface read-only (style RFC 7662, métadonnées) où un AMP/SIEM demande « que peut atteindre la mission X / qu'a touché l'agent Y / quelle policy effective ». Le positionnement Path 1 sans le data lake. Ère control plane.
4. **Lineage graphe continu**: le Mission BOM parqué est un rapport ponctuel; ici la vue continue entité × mission × système (on tient déjà les deux moitiés: entity map + provenance).
Ligne rouge maintenue: jamais d'ingestion de télémétrie interne agent (prompts, reasoning traces) — ça traverse la frontière API et c'est la ligne embeddings/data-lake.

**Parqué — authentification opérateur en entreprise (le trou de déployabilité):** aujourd'hui la clé opérateur est un secret partagé (fichier hex local). En grande organisation ça ne passe pas: l'orchestrateur doit s'authentifier auprès du control plane avec l'identité de sa plateforme — workload OIDC (Entra ID, Okta, Ping), mTLS ou SPIFFE — et le droit de minter doit être scopé par équipe et par intent (l'équipe support ne mint que des intents support). Le claim `actor` doit alors venir de l'IdP (l'humain qui a déclenché le run), pas d'un flag CLI. PRD F-018 couvre l'authn agent→proxy; ceci est orchestrateur→control plane, non couvert. C'est le point d'intégration que les équipes IAM exigent avant tout déploiement.

**Parqué — plafond de délégation (on-behalf-of, anti privilege creep):** une mission ne doit jamais dépasser les droits de l'humain qui la délègue. Scope effectif = intersection(intent, entitlements de l'`actor`). Sans ça, l'agent devient un chemin d'escalade: un support engineer sans accès au client X pourrait lancer un agent qui y accède. Aujourd'hui `actor` est de la provenance, pas une entrée d'autorisation. Nécessite une source d'entitlements (groupes IdP, ou table locale) → dépend de l'item authentification opérateur. Post-v0, mais c'est la différence entre « missura trace qui a lancé » et « missura empêche de dépasser ».

**Parqué — MCP comme transport (engagement de compatibilité):** notre position ne change pas — MCP = introspection, jamais la data (§4.8). Mais si une organisation standardise MCP comme chemin agent→outils, missura doit pouvoir s'insérer SOUS n'importe quel serveur MCP (déjà vrai: le serveur MCP pointe ses base URLs sur le proxy) et, plus tard, exposer un transport MCP pour les connecteurs sémantiques sans toucher au modèle de décision (PRD §48.5). À énoncer comme engagement explicite pour ne pas être exclu des architectures MCP-first.

**Parqué — mode conteneur / sandbox (le confinement réel):** `missura exec` ne doit **pas** refuser de tourner sans isolation — la friction de test tuerait l'adoption, et le mode local est le chemin d'entrée du produit. La réponse est un mode dédié: lancer l'agent dans un conteneur ou un sandbox où `~/.missura` n'existe simplement pas, seuls `MISSION_TOKEN` + les URLs proxy entrant dans l'environnement (`missura exec --sandbox` / `missura sandbox -- <cmd>`, Docker en premier support). C'est ce qui transforme la limite connue n°1 de M2 (§7) en garantie tenue plutôt qu'en note de bas de page. Post-v0.

**Non-goals permanents (pas seulement v0):** embeddings/index sur la donnée vendeur · intent inféré par LLM au runtime · LLM dans le chemin de décision.

**À étudier à la toute fin (pas avant):** « guardian agents » — un LLM qui surveille les agents. En ligne: jamais (contraire au déterminisme, PRD §9.2). Hors ligne: un LLM qui *propose* des policies qu'un humain valide est déjà permis par la PRD — c'est la seule forme qu'on étudiera.

## 6. Qualité & vérification

- Contract tests contre les vraies APIs (Linear SDK + Octokit officiels) en CI avec des comptes de test; snapshots de schémas pour détecter les dérives vendeur (PRD §33).
- Tests unitaires: parser GraphQL (aliases/fragments/variables), catalog GitHub, filtre de réponse, cycle mission (create/expire/revoke).
- Latence P95 ajoutée mesurée et publiée: PASS < 30 ms, NARROW < 60 ms, FILTER < 100 ms (PRD §32.1).
- Red-team interne avant launch: énumération d'IDs, filtres élargis, qualifiers search, curseurs forgés, token rejoué après revoke.

## 7. Milestones (ordre, pas de dates)

### M0 — Squelette
Monorepo pnpm TS, CI (lint, typecheck, tests), Apache-2.0, README honnête (ce qui marche, ce qui ne marche pas encore).
**Fini quand:** `pnpm test` vert en CI, README publié.

### M1 — Credentials hors de l'agent + passthrough contrôlé — DONE 2026-08-15 (proof validée par l'humain sur workspace réel)
`init` (vault), `run`, catalogues deny-by-default, injection credential, token local signé.
**Fini quand:** le SDK Linear officiel et Octokit fonctionnent à travers le proxy avec **zéro credential vendeur dans l'env agent**; un endpoint hors catalogue → DENY loggé.

### M2 — Missions + exec + NARROW — DONE 2026-08-15 (avec une correction ouverte, voir ci-dessous)

> **CORRECTION 2026-08-15 (découverte en M3, vérifiée à la main):** le NARROW Linear livré en M2 injecte `filter: { customer: { id: { eq: … } } }` et vérifie `issue.customer.id` — **or `Issue` n'expose aucun champ `customer` dans `@linear/sdk@90`**. Le lien client passe par `Issue.needs` → `CustomerNeed.customer` (une issue peut porter plusieurs needs, donc plusieurs clients). Conséquence: le filtre customer ne fonctionne pas contre l'API Linear réelle — il **échoue fermé** (le vendeur rejette la requête, l'agent reçoit une erreur, aucune donnée ne fuit), donc c'est un trou fonctionnel, pas une faille. Personne ne l'a vu parce que `demo:m2` n'a jamais été exécuté sur un workspace réel. C'est exactement ce que la suite de compatibilité (PRD §33, jalon M4) existe pour attraper — argument pour l'avancer. **CORRIGÉ en M3** une fois §4.4.3 tranché: le filtre injecté est `needs: { some: { customer: { id: { eq: … } } } }` et l'appartenance se prouve par `needs.nodes[*].customer.id`.
API opérateur `POST /v1/token` + `/v1/revoke` (formes OAuth, §4.2) — remplace le mint libre `missura token` de M1 (review Codex: docs/reviews) —, claims `purpose` + `actor`, TTL hard cap 60 min, cap 10 MB sur les réponses upstream, input credentials masqué au `init`, `exec --scope --ttl -- cmd` par-dessus, expire/revoke (< 5 s), filtre customer injecté dans l'AST Linear, allowlist repos GitHub, 404 hors-scope, propagation `traceparent` (§4.7bis).
**Fini quand:** une mission `customer:acme` ne peut lire aucun objet d'un autre client via requête directe, recherche globale, ou ID deviné — vérifié par tests d'intégration sur un workspace réel.

**Limites connues de M2 (constatées, pas corrigées — les deux revues de sécurité les ont relevées indépendamment):**

1. **`missura exec` isole l'environnement, pas le système de fichiers.** L'enfant tourne sous le même uid: il peut lire `~/.missura`. `operator.key` lui permet de se minter la mission qu'il veut; `vault.key` + `vault.json` déchiffrent les credentials vendeurs en clair. Retirer `LINEAR_API_KEY`/`GITHUB_TOKEN` de l'env supprime l'accident, pas la capacité. Un vrai confinement demande un utilisateur système distinct ou un conteneur, avec `~/.missura` en dehors — non fait en M2. Déjà dit dans `--help`, le README et un commentaire de `exec.ts`; écrit ici pour que ce soit une limite assumée du produit, pas une note d'implémentation.
2. **Qui peut écrire le fichier d'état des missions peut annuler une révocation, au prochain redémarrage du proxy.** En mémoire, la liste des révocations ne fait que croître: un fichier restauré ou réécrit ne retire jamais une révocation qu'un processus vivant a déjà vue. Mais cette protection meurt avec le processus — un `missura run` redémarré lit le fichier tel qu'il est. Le fichier est en 0600 dans un répertoire 0700; c'est une permission, pas une intégrité (ni signature ni chaînage). Le decision log hash-chained de M3 (§4.7) couvre le journal, pas l'état.
3. **L'écriture de l'état des missions n'est pas sérialisée entre processus.** L'écriture est atomique (fichier temporaire + `rename`) et fusionne ce que le fichier contient avant de le remplacer, donc aucun lecteur ne voit un fichier à moitié écrit et deux mints simultanés ne s'effacent plus l'un l'autre en pratique. Deux écrivains peuvent toujours s'entrelacer à l'intérieur de la fusion: la vraie réponse est un verrou de fichier ou un écrivain unique, non fait en M2.

### M3 — Le moteur sémantique — EN COURS (l'essentiel est livré)
Livré: artefact de schéma Linear épinglé + classification par type · moteur de filtrage des réponses · GitHub qui filtre au lieu de refuser · en-têtes vendeur relayés · erreurs actionnables de forme vendeur · pagination REFILL bornée avec **curseurs opaques possédés par missura** · narrowing Linear piloté par le type (branche `m3-linear-narrowing`).
`InitiativeUpdate`/`ProjectUpdate` classés métadonnée (décision 2026-08-15) — **le document généré intact du SDK officiel passe désormais**, `narrow-sdk.test.ts` l'épingle sur les vrais octets envoyés par le SDK. `demo:m3` est écrit, à lancer par l'humain sur un workspace réel.
Couverture encore incomplète, remontée en M4: `issue.needs()` typé du SDK est refusé (`ProjectAttachment` non classé) et `linear.customer(id)` typé aussi (`CustomerStatus` non classé).
**Fini quand:** les méthodes typées du SDK officiel `@linear/sdk` fonctionnent sous une mission scopée sans renvoyer un seul objet hors périmètre — vérifié en direct sur un workspace réel. Ce critère vaut pour le mode `strict`; c'est lui qui prouve que l'enforcement à l'objet existe.

### M4 — Discriminants natifs + second connecteur
Le jalon qui rend « plein d'entités, plein de systèmes, toutes les industries » atteignable — par le bas (§2.3), pas par la modélisation à la main.
- **Chaque connecteur expose d'abord son discriminant natif.** GitHub: `repo` (déjà). Linear: `team`/`project` en plus du chemin `needs`→customer déjà construit. Zendesk: `organization_id`.
- **Connecteur Zendesk read-only** (organizations, users, tickets, comments, search, pagination) — le système primaire du premier utilisateur réel identifié, et un discriminant natif propre.
- **`--actor` comme second axe**: le claim existe déjà en provenance; ce jalon le rend visible dans le scope et prépare le plafond de délégation.
- **Entity map = couche de confort** au-dessus des discriminants natifs (`customer:acme` → org Zendesk + team Linear + repos GitHub), plus la généralisation de `init` à N connexions.
- **Coverage manifest par connecteur** (PRD F-014) et **suite de compatibilité** (PRD §33): générer les appels depuis les SDKs officiels, les exécuter en direct vendeur ET via le proxy, comparer. C'est exactement ce qui aurait attrapé le `Issue.customer` inexistant avant de le livrer.
**Fini quand:** un agent traverse Linear + Zendesk + GitHub dans une mission unique sans atteindre aucun objet hors périmètre, et la suite de compatibilité tourne en CI.

### M5 — Mode hybride + plafonds + launch
Le jalon d'adoption: on passe d'un produit qui protège à un produit qu'on installe.
- **Plafonds de rayon d'action sans sémantique**: max objets, max requêtes, max octets par mission; refus dur des verbes bulk/export/admin. Aucune modélisation vendeur, **aucun trou de couverture** (contrairement à un filtrage objet partiel), résiste à la dérive des APIs. Devient la garantie mise en avant.
- **Bascule du défaut en `hybrid`** (§2.2), `strict` en opt-in, `audit` pour l'entrée. Les deux partent ensemble: sans plafonds, l'hybride ne garantit rien.
- **Erreur actionnable → mode**: un refus en `hybrid` doit dire quel mode donnerait accès, sans jamais nommer la cible.
- **Détection de contournement, forme minimale** (§7sexies.1): mission expirée avec 0 appel → `mission_unused` dans le journal, et `missura verify` qui échoue quand un host vendeur est en dur dans le code de l'app. Sans ça, rien ne prouve que le proxy est resté dans le chemin — et c'est le mode d'échec observé en vrai chez un utilisateur cible.
- Introspection MCP, Docker, docs, asciinema, repo public, latences publiées.
**Fini quand:** un inconnu fait `init → run → exec -- claude` sur son propre workspace en moins de 15 min, **son code existant ne casse pas**, et il voit ce que son agent a touché. Puis: Show HN + les threads Reddit identifiés.

### Décalé explicitement (après le launch)
Journal hash-chainé · circuit breaker · `missura tail` en commande dédiée · mode conteneur/sandbox · writes + approbations · Notion · forward proxy · entity memory · substrat télémétrique · plafond de délégation (l'`actor` comme entrée d'autorisation) · **provenance de sortie** (writes de l'app routés par le proxy sous le même `mission_id`, Mission BOM = lecture **+** émission — §7sexies.2) · **`missura verify` en CI** (§7sexies.1, la forme (b)).

### Risques que ces décisions n'éliminent pas
1. **« Same API » et le filtrage des réponses sont contradictoires** — déjà payé trois fois (compteurs supprimés, pagination tronquée, champs non-nullables). Le mode `hybrid` contourne le problème en ne filtrant pas par défaut; il ne le résout pas pour `strict`.
2. **Le tapis roulant des connecteurs** est le moat ET le piège. Les discriminants natifs (§2.3) en divisent le coût; ils ne l'annulent pas.
3. **La garde des secrets est le risque qui tue** (un concurrent direct s'est fait exfiltrer des milliers de clés clients en mai 2026). On détient des credentials root de workspace et le downscoping dynamique est parqué: **P0 avant tout hébergement**.

## 7ter. Décisions du 2026-08-15 (suite atlas)

1. **Second saut / bulk / export: REFUSÉ, point.** Ces endpoints sont `never_allow` (déjà la position de la PRD §14). Un agent ne fait pas d'export de masse. On ne prétend jamais filtrer ce qu'on ne voit pas, et on n'ouvre pas le chantier de la réécriture d'URL.
2. **Improuvable en mode hybride: laisser passer, marquer, compter.** Quatrième issue `unscopable` dans le journal + métrique de couverture visible (« N appels, M improuvables »). L'opérateur voit son angle mort au lieu de l'ignorer; c'est ce qui distingue `hybrid` de `strict`. Livré avec le mode hybride (M5).
3. **Egress (message, email, webhook, lien de partage): plus tard, avec les writes.** Tout est read-only, donc l'egress n'est pas atteignable aujourd'hui. À traiter au moment d'ouvrir les écritures, pas avant.
4. **Connecteur suivant: Zendesk, maintenu.** Malgré le classement de l'atlas (Salesforce, famille des requêtes encodées, Postgres devant), on garde le wedge support de la PRD et le système primaire du seul utilisateur réel identifié. `organization_id` est un vrai discriminant natif filtrable.

## 7quinquies. Décisions du 2026-08-16 (positionnement & adoption)

1. **L'histoire qui porte le produit: l'agent client débloqué.** Le besoin où le scoping par entité est un *bloqueur de lancement* — pas un confort — est l'agent multi-tenant face au client (support, success, onboarding). Personne ne déploie un agent qui touche les données de N clients sans garantie d'isolation. On ne vend pas « moins de permissions » (une contrainte ne s'achète pas seule): on vend **l'agent que tu n'osais pas lancer**. La contrainte est le mécanisme, pas la promesse. Conséquence connecteurs: après Zendesk, **Slack**, puis Salesforce ou Notion — le stack de l'agent support, pas celui du dev. GitHub/Linear restent (canal d'installation dev), mais ne pilotent plus la roadmap.
2. **Vis-à-vis de Glean: primitive différente, pas variante.** Glean copie la donnée dans un index et imite les permissions d'un *humain* (impersonation). Missura ne copie rien et crée des permissions **plus étroites que celles de n'importe quel humain** — une mission n'est le miroir de personne. « L'agent n'est pas un utilisateur » est la phrase fondatrice. Le no-copy est l'argument sécurité immédiat.
3. **Onboarding: le graphe n'est jamais un prérequis.** Jour 1, zéro graphe: credentials hors de l'agent, inventaire par mission, plafonds — le produit rend déjà. Les missions dégradées sont la **to-do list du graphe**: chaque dégradation dit « confirme ce lien et l'agent gagne ce système ». Le produit se configure par l'usage. C'est la stratégie d'adoption, à raconter partout (landing, README, CLI).
4. **Dégradation visible, non quantifiée.** Une mission dégradée l'apprend à l'agent: `get_mission` nomme les systèmes hors mission et la raison de classe (`link_proposed`, `no_entity`…), et une réponse dont la vue a été réduite par la politique porte un marqueur (`extensions.missura.reduced: true` en GraphQL, header `missura-reduced: true` en REST) — **jamais un volume, jamais un identifiant**. Justification: l'indiscernabilité protège les *objets hors périmètre*; le statut de la mission décrit le périmètre que l'agent *connaît déjà* — le lui dire ne fuit rien (même raisonnement que §4.8bis). Un agent confidemment faux (« il n'y a rien d'autre ») est le motif n°1 d'arrachage d'un produit de sécurité par ses utilisateurs.
5. **La profondeur d'enforcement est constituée; l'heure marginale va au time-to-value.** L'indiscernabilité au bit près, les curseurs opaques, le registre d'admission des artefacts: c'est la crédibilité (un seul oracle démontré publiquement tue un produit de sécurité), elle est acquise. Priorité désormais: quickstart 10 minutes, boucle dégradation→confirmation visible, `pnpm compat` comme preuve publique.

## 7sexies. Constats terrain — lecture d'un codebase agentique réel (2026-09-07)

Premier agent de production lu en entier: investigation de tickets support, trois systèmes (helpdesk, tracker, dépôts git), boucle tool-use écrite à la main. Rien n'invalide la spec; trois items neufs, deux repriorisations. Seul ce qui change le produit est consigné ici.

1. **TODO — détection de contournement (M5, avant launch).** `spec.md:1679` liste « contournements détectés » comme métrique et aucun mécanisme n'existe nulle part. Le mode d'échec observé en vrai: un gate d'approbation supprimé par un refactor, README et UI le documentant encore, personne ne l'a vu — parce que l'enforcement vivait dans le code applicatif. L'équivalent chez nous: quelqu'un remet la base URL vendeur, tout continue de marcher, l'enforcement est parti. Trois formes par coût croissant: (a) **mission expirée avec 0 appel → événement `mission_unused`** dans le journal, quasi gratuit, à livrer en M5; (b) `missura verify` en CI — hosts vendeurs en dur dans le code de l'app → build rouge; (c) l'egress réel (§4.9), post-v0. Entre v0 et le forward proxy, **rien ne prouve que le proxy est dans le chemin** — c'est ce trou que (a) et (b) bouchent partiellement.

2. **TODO — le trou post-mission: la sortie de l'agent n'est pas dans le périmètre.** La chaîne d'exfiltration observée ne passe pas par l'agent: l'agent lit (bornable), écrit un brouillon, puis **le serveur applicatif** publie une réponse publique chez le client avec son propre credential, hors de tout proxy. Missura aurait borné la lecture et n'aurait rien vu de la publication. À écrire comme limite assumée (PRD §27), avec la réponse produit: quand l'app route aussi ses writes par le proxy sous le même `mission_id`, la provenance se referme — « ce commentaire public dérive de la mission 482, qui a lu 3 organisations ». Extension du **Mission BOM** parqué (§5), qui ne couvre aujourd'hui que les objets *lus*: le BOM devient lecture **+ émission**. C'est aussi le meilleur argument pour sortir les writes du non-goal plus tôt: la valeur du write n'est pas l'action, c'est le chaînage de provenance.

3. **TODO — la copie applicative, trou structurel du modèle proxy.** L'app mirore une fenêtre glissante de tickets (sujet, organisation, email du demandeur) dans une base locale servie à tout utilisateur authentifié, parce qu'il lui faut une liste dans son UI. Une fois la donnée passée légitimement par le proxy, l'app la persiste et la re-sert sans mission. PRD §27 couvre « l'agent copie vers un autre SaaS », pas « l'app copie dans sa propre base » — et c'est le cas fréquent. Missura ne peut pas l'empêcher; la seule réponse honnête est que le decision log rend la copie **attribuable** (qui, quelle mission, combien d'objets, quand). À nommer dans le modèle de menace, pas à découvrir en pilote.

4. **REPRIORISATION — le profil « client fetch maison ».** Toute la doctrine §4.4.1 et le séquencement `hybrid` → `strict` (§2.2) sont calibrés sur les **SDKs officiels**: fragments générés, champs non-nullables, helpers de pagination. Le cas observé n'a aucun SDK — des tools écrits à la main, `fetch` brut, réponses aplaties en texte avant d'atteindre le modèle. Aucun de ces coûts n'existe: rien à casser côté types, la pagination n'est même pas exposée au modèle. **`strict` y est jouable dès le jour 1.** Si ce profil est majoritaire — et on écrit des tools bien plus souvent qu'on ne rebranche un SDK — alors notre défaut est optimisé pour le segment le plus dur et retarde `strict` là où il est gratuit. Question de qualification à ajouter aux entretiens (PRD §42.3): *« vos agents appellent les APIs via le SDK vendeur ou via des tools maison ? »* — la réponse change le mode proposé, donc le pitch.

5. **CONFIRMATION — Zendesk comme second connecteur (§7ter.4 maintenu).** `organization_id` est filtrable dans la recherche Zendesk *et* porté par chaque résultat: NARROW et FILTER tous les deux applicables sans effort, cas idéal §2.3 — à comparer au chemin de croix Linear (`Issue.needs` → `CustomerNeed.customer`). Le premier utilisateur réel identifié en a plus besoin que de Linear.

**Ce qu'on n'ajoute pas.** RBAC absent, contrôles de propriété manquants, token machine partagé: ce sont des bugs applicatifs, et la tentation d'élargir missura pour les couvrir est exactement le « ne construis pas un IAM général » de PRD §51. Un seul point remonte: un token `client_credentials` partagé par tous les utilisateurs est la meilleure preuve terrain que le **plafond de délégation** (parqué, §5) n'est pas un raffinement — sans lui, un compte en lecture seule déclenche un agent qui lit tout le compte vendeur. Ça ne change pas l'ordre, ça durcit l'argument.

## 7bis. Constats terrain (atlas de 13 cas d'usage, 2026-08-15)

Atlas produit par un agent **sans accès au code**, sur 13 cas couvrant tech, finance, santé, retail, industrie, public, médias — et des familles d'API volontairement dissemblables (REST, GraphQL, SQL, SOAP, binaire, batch fichier). Ce qui suit contredit une partie de nos hypothèses; les décisions correspondantes sont dans `QUESTIONS-OUVERTES.md`.

### La règle qui prédit le coût d'un connecteur
**Un discriminant natif existe quand le vendeur vend à des constructeurs multi-tenants; il est absent quand le vendeur vend à des entreprises organisées par organigramme.** GitHub a `repo`, Stripe a les comptes Connect, Kafka a les topics — parce que leurs clients servent *leurs propres* clients. Workday, Confluence, SharePoint, Slack partitionnent par personnes et permissions, pas par tenants. Cette règle prédit le coût d'intégration mieux que tout le reste: à utiliser pour choisir les connecteurs, pas l'inverse.

Sur 13 cas: discriminant natif présent **et pertinent** dans ~5 (Salesforce, ServiceNow, GitHub, entrepôts, compartiments FHIR); présent mais **sans rapport avec le risque réel** dans 3 (`space` Confluence, collections MAM, store Shopify); **absent** dans le reste (enregistrements Kafka, EDI, Workday, Stripe hors Connect, recherche Slack, email, historiens).

### Quatre trous dans notre conception, par ordre de gravité
1. **Le second saut.** Dans près de la moitié des cas, la réponse ne passe jamais par le proxy: FHIR `$export` rend un manifeste d'URLs NDJSON, Shopify `bulkOperation` une URL JSONL sur CDN, BigQuery lit en masse par un endpoint gRPC *différent*, Workday RaaS rend une URL de rapport, S3 présigné est un contournement par construction. **Le mode `strict` y est inapplicable — et les plafonds aussi**: plafonner la requête qui *déclenche* un export ne plafonne rien. Il faut un concept de premier rang: détecter la redirection-vers-stockage, et refuser ou suivre.
2. **Aucune histoire de fail-closed sur l'improuvable.** Rien ne dit ce qui se passe quand missura ne sait pas parser ou scoper (SQL avec CTE, SPL, `sysparm_query` contenant `^NQ`). Sans quatrième issue — **refus-parce-qu'improuvable** — plus une métrique de couverture (« 1240 appels, 310 improuvables »), « le mode hybride ne casse rien » veut dire en creux « le mode hybride laisse passer tout ce qu'il ne comprend pas », soit l'inverse du pitch.
3. **Le refus de verbe est le mauvais primitif contre l'exfiltration.** Le coup fatal passe toujours par une écriture *légitime* utilisée comme canal de sortie: `chat.postMessage`, `issues.create`, `gmail.send`, `COPY INTO s3://`, SPL `| sendemail`, création d'un webhook ou d'un lien de partage. Il faut une **classification d'egress indépendante de lecture/écriture** et un plafond sur le volume sortant.
4. **La délégation se standardise sans nous.** Okta Cross App Access / ID-JAG (RFC 8693) compte 25+ adoptants dont Anthropic, Slack, Atlassian, Salesforce, Box, Datadog. Et « détenir le credential pour que l'agent ne le voie jamais » est devenu **table stakes** (Arcade, Nango, Composio, Scalekit le font déjà). Ce que personne de ce groupe ne fait: injecter un filtre natif, plafonner le rayon d'action, filtrer une réponse. **Être client de XAA/OBO sur l'axe délégation, propriétaire sur le plan de données.**

### Ce que l'atlas retourne dans notre cadrage
- **Les plafonds et le refus de verbe sont le produit; le scoping est l'upsell.** Dans Shopify, Stripe, Kafka, l'incident Replit, Snowflake 2024 et Salesloft Drift, ce qui aurait empêché l'incident est « refuse ce verbe » + « plafonne à N », sans aucun scoping. Notre cadrage a l'ordre inverse.
- **Le coût et le quota sont des dimensions de rayon d'action** au même titre que le nombre d'objets: octets scannés, coût d'une requête GraphQL, limites journalières Salesforce, seaux de points Shopify. « Max objets » est le moins utile des trois.
- **Le temps est une unité de scope qu'on n'a jamais nommée** — « 90 derniers jours », « rien pendant le gel », « rien sous legal hold ». Présent dans 6 cas, injectable partout, gratuit.
- **Les compteurs et l'existence**: notre choix de supprimer les totaux est validé par un incident réel (fuite de comptes ServiceNow en 2024 alors que les ACL d'enregistrement tenaient).
- **Le journal de décision est lui-même un artefact régulé**: il contiendra du PHI, du PAN, du MNPI. Rétention, résidence, WORM, rédaction deviennent des exigences produit.

### Familles structurellement hostiles — réponse honnête à donner
| Famille | Pourquoi | Ce qu'on répond |
|---|---|---|
| AWS / Azure / GCP / K8s | La signature de requête interdit la modification; l'autorisation native par requête existe et est meilleure | « Utilisez les session policies STS / IAM Conditions / Kyverno. On observe et on trace, on n'enforce pas. » |
| Kafka & streaming | Filtrer des enregistrements détruit les offsets, le lag et les garanties de livraison | « ACLs, quotas, refus de verbe au bord du protocole. Jamais de filtrage d'enregistrement. » |
| Bulk/async partout | La charge part par un second saut | « On refuse ces endpoints, ou on proxifie le second saut. On ne prétend pas filtrer ce qu'on ne voit pas. » |
| Email | Aucun scope sous la boîte, et c'est le canal d'exfiltration parfait | « Délégation uniquement, plus contrôle des envois. » |
| EDI / AS2, OT / OPC-UA | Batch fichier, ou temps réel critique pour la sécurité physique | « Mauvaise forme. Le contrôle va au broker d'intégration ou à la passerelle historien. » |
| Vector stores / RAG | La donnée a déjà quitté le système de référence | « On gouverne la lecture, pas la copie — c'est un autre produit. » |

### Planchers réglementaires où « réduire le risque, pas être parfait » ne tient pas
42 CFR Part 2 · PCI DSS 4.0 (si un PAN transite, on entre dans le périmètre) · CJIS 6.0 (FIPS 140-3 exigé pour tout nouveau déploiement après le 21/09/2026) · barrières d'information / MNPI en banque · redistribution de données de marché (contractuel) · aveuglement d'essais cliniques · legal hold et secret professionnel · données employés UE (RGPD art. 9 + comités d'entreprise) · DORA (si on est dans le chemin de données d'une fonction critique, on devient prestataire ICT tiers avec obligations contractuelles). Sur ces cas: mode strict, ou refuser l'intégration.

### Candidats wedge issus de l'atlas (contre notre choix actuel)
1. **Salesforce** — une clause `WHERE` injectable, classification de verbe triviale, délégation native (JWT bearer as-user), et **l'incident de référence est déjà écrit**: Salesloft Drift, août 2025, 700+ orgs, SOQL en masse sur Account/Case/Opportunity. Démonstration en cinq minutes: « le mode hybride en aurait fait 500 enregistrements et une alerte. »
2. **La famille des requêtes encodées** — ServiceNow `sysparm_query`, Jira JQL, Confluence CQL: trois produits, **un seul motif de parseur**, et des pièges de précédence (`^NQ` qui annule un scope ajouté naïvement) que le fait-maison rate subtilement. C'est là qu'est la différenciation démontrable.
3. **Postgres/MySQL derrière une app interne** — protocole documenté, RLS + `SET LOCAL` comme mécanisme natif (donc pas de réécriture SQL), et la limite de lignes du protocole étendu donne un plafond gratuit.
**Explicitement pas des wedges malgré les apparences:** GitHub (le vendeur a déjà résolu, personne ne paie), AWS (les session policies sont meilleures), Stripe (les clés restreintes livrent déjà l'essentiel du mode hybride).

## 7quater. Preuves externes (2026-08-15) — ce qui durcit ou contredit nos positions

Recherche sur sources primaires (docs vendeur, code des connecteurs, textes réglementaires). Ne sont retenus ici que les constats qui changent une décision. Le reste est du contexte.

**Le second saut n'est pas un cas limite, c'est le chemin par défaut des entrepôts.** Le connecteur Python Snowflake télécharge les résultats depuis des URLs S3 pré-signées portées par la réponse, et Snowflake *recommande* de contourner le proxy sur ce chemin (`NO_PROXY=".amazonaws.com"`) tout en interdisant l'interception TLS. Databricks documente le contournement comme une fonctionnalité et demande explicitement de **retirer l'en-tête d'autorisation** avant de tirer les octets ; les formats à haut débit n'existent qu'avec `EXTERNAL_LINKS`. BigQuery a deux hosts et deux protocoles, le plan de données en gRPC streaming, activé par défaut dès qu'on est en pandas ou en Spark. Un proxy devant l'API voit la requête et zéro ligne. → Notre réponse « on refuse, et on le dit » (Q11) est la seule qui ne mente pas. Un mode « on filtre les entrepôts » serait une fausse promesse vérifiable en cinq minutes par un client.

**Personne ne réécrit du SQL arbitraire en sécurité, et la raison est structurelle.** Le prédicat de tenancy est une propriété de la table de base, pas de la requête : il doit s'attacher à chaque référence de table dans chaque portée. Les trois moteurs qui le font correctement le font en interne, et Postgres a eu besoin d'une barrière de planificateur, d'une annotation de pureté et d'un drapeau invoker/definer pour rendre sûre une simple vue filtrée. Un réécrivain de texte n'a aucun de ces leviers. Côté outillage, `sqlglot` se disqualifie lui-même — « the parser is intentionally lenient, so it can accept queries that a real engine would reject » — et un parseur laxiste est la définition d'un contournement ; `libpg_query` achète la fidélité au prix d'un seul moteur et d'une seule version. Redshift publie les limites de son propre réécrivain (`ERROR: RLS policy could not be rewritten` sur les sous-requêtes corrélées). → Confirme notre doctrine: schéma vendeur épinglé et refus au niveau du TYPE, jamais de réécriture de requête libre. Et rend un connecteur SQL « parse + injecte un WHERE » interdit par construction, pas seulement risqué.

**FHIR nomme l'injection de paramètre par un proxy comme la chose contre laquelle se défendre.** R4 §3.1.1.3.1: les serveurs *devraient* ignorer les paramètres inconnus, précisément parce que « various HTTP stacks and proxies may add parameters that aren't under the control of the client ». Fail-open, silencieux, invérifiable côté proxy. Les liens de page suivante sont opaques et propriété du serveur. Les exports bulk sortent par une redirection vers un objet signé, sans en-tête d'autorisation. → La santé n'est pas un connecteur v0. Notre mécanisme de NARROW n'y a aucune garantie.

**Un régulateur a écrit notre discipline de canal auxiliaire.** 42 CFR §2.13(c)(2): un refus doit être formulé « in a way that will not affirmatively reveal that an identified individual has been, or is being, diagnosed or treated for a substance use disorder », et le demandeur « may not be told affirmatively that the regulations restrict the disclosure of the records of an identified patient ». Un système qui répond « 403 / withheld by policy » pour un patient et « 200 / no data » pour un autre fait exactement ce que la seconde phrase interdit. → C'est la meilleure justification externe de l'exigence d'indiscernabilité au bit près (§4.4.x, `response-oracle.test.ts`). À noter honnêtement: aucune guidance HHS n'étend cette phrase aux métadonnées d'API (code, latence, nombre de lignes) — c'est un risque de conception non tranché, pas une prohibition établie.

**Le sur-blocage est une infraction, pas une posture prudente.** ASTP/ONC, décembre 2025: interférer avec l'accès à l'EHI par une « agentic artificial intelligence » peut relever de l'information blocking. Et l'exception sécurité (45 CFR §171.203) se lit comme un cahier des charges: la pratique doit être « tailored to the specific security risk being addressed », appliquée « in a consistent and non-discriminatory manner », et sans « reasonable and appropriate alternative » moins interférente. Un filtre large est par construction non adapté à un risque spécifique, et un filtre qui traite « les agents IA » comme une classe à part échoue au test de non-discrimination. → Argument contre le refus-par-défaut aveugle, et pour notre échelle d'adoption (audit → hybride → strict) : la posture doit être justifiable risque par risque. Note prospective: une exception « Requestor Preferences » proposée (§171.304, décembre 2025, non finalisée) couvrirait une limitation **demandée par le destinataire** — c'est exactement la forme d'une mission mintée par l'opérateur pour son propre agent, et c'est la posture vers laquelle concevoir.

**Kafka: le filtrage d'enregistrement casse à quatre niveaux.** Offsets positionnels (lag et comptes faux), CRC par lot (retirer un enregistrement impose décompression, re-sérialisation, recalcul), transactions (`LastStableOffset`, marqueurs de contrôle in-band), et côté production les numéros de séquence idempotents dont un trou donne une erreur fatale. Depuis KIP-951, les adresses de brokers voyagent aussi dans `ProduceResponse` et `FetchResponse`, pas seulement dans les métadonnées — un proxy qui ne réécrit que `Metadata` fuit de vraies adresses lors des changements de leader. → Renforce la ligne existante: jamais de FILTER sur du streaming.

**Où un plafond est possible sans bufferiser.** Postgres: le message `Execute` porte un nombre maximal de lignes et le serveur répond `PortalSuspended` — le proxy réécrit le maximum, absorbe la suspension, et n'a rien à retenir. ClickHouse: les réglages voyagent dans l'URL, donc le proxy **ajoute** au lieu de réécrire, et les *constraints* serveur empêchent le client de défaire le plafond. BigQuery: `maximumBytesBilled` fait échouer le job **avant** le scan. À l'inverse MySQL n'a aucun équivalent (couper désynchronise la connexion) et Databricks tronque a posteriori avec un délai d'expiration par défaut de deux jours. → Pour nos plafonds de rayon d'action (M5): les primitives natives battent tout ce qu'un proxy peut faire, et la bonne conception est de les **injecter**, pas de les réimplémenter.

**Contraintes qui touchent le modèle de déploiement et le contrat, pas le code.** Le London Stock Exchange interdit que ses données soient consommées « into any AI solutions which are hosted or operated by a third party unless approved » — plaide directement pour un déploiement chez le client plutôt qu'en SaaS. ADP exige mTLS avec certificat client sur chaque appel: un proxy y est structurellement obligatoire pour qu'un agent existe, mais il devient détenteur de la credential. En PCI, l'« exception conduit » souvent invoquée **n'est pas dans le CFR** — elle n'existe que comme glose interprétative, et un proxy qui termine TLS sur un PAN est dans le périmètre ; journaliser un corps contenant un PAN crée une obligation de stockage (3.5.1 vise nommément les journaux d'audit), et pour la SAD le chiffrement ne rachète rien. → Confirme « pas de corps stockés » comme exigence produit et non comme choix d'implémentation. En Allemagne enfin, § 87(1)(6) BetrVG co-détermine « l'introduction **et l'exploitation** » des dispositifs techniques aptes à surveiller le comportement des salariés: **notre propre journal de décision peut en être un**, pour les opérateurs. Conséquence de conception: séparer les traces d'action de l'agent des traces identifiant l'humain.

**Un cadeau: notre journal ressemble déjà à ce que la SEC accepte.** Depuis mai 2023, 17 CFR §240.17a-4(f)(2)(i)(A) admet une alternative au WORM — un système à piste d'audit horodatée couvrant les modifications, les suppressions, l'identité de l'acteur et la recréation de l'enregistrement original. C'est la description de notre journal chaîné par hachage. Le coût marginal de le rendre conforme est faible, et cela supprime une question de classification au lieu d'y répondre.

**Une correction de calendrier à ne pas rater en communication.** Les obligations « haut risque » de l'AI Act ne s'appliquent plus au 2 août 2026: reportées au 2 décembre 2027 (annexe III) et au 2 août 2028 (annexe I). Ce qui lie *aujourd'hui* et sert un discours honnête: l'interdiction d'inférence d'émotions au travail (art. 5(1)(f), depuis février 2025), le RGPD art. 9 et 88, et le BetrVG. Ne pas vendre une échéance qui a bougé.

## 8. Risques v0

| Risque | Mitigation |
|---|---|
| AST Linear plus dur que prévu (fragments, non-nullables) | Catalog étroit; DENY tout cas non prouvé; élargir ensuite |
| Recherche Linear/GitHub contourne le filtre | Qualifiers/filtres injectés + FILTER systématique en second contrôle |
| Latence du double contrôle | Décision locale in-process, pas de hop réseau; mesurer dès M1 |
| Dérive API vendeur | Contract tests CI + version pinning des schémas |
| « Encore un proxy » (adoption) | Le README ouvre sur `exec -- claude` et le tail — la garantie visible en une commande |
