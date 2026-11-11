<div align="center">
  <img src="https://raw.githubusercontent.com/Bin-E-Commerce/Bin-E-Commerce-UI-Web/main/public/images/logo/logo_background_white.png" alt="Bin E-Commerce" width="220" />

# Recommendation Service

Ranks relevant products for each customer using profile, session, catalog, and interaction signals with a trained LambdaRank model.

  <p>
    <img src="https://img.shields.io/badge/NestJS-11-E0234E?logo=nestjs&logoColor=white" alt="NestJS 11" />
    <img src="https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white" alt="TypeScript 5.7" />
    <img src="https://img.shields.io/badge/PostgreSQL-336791?logo=postgresql&logoColor=white" alt="PostgreSQL" />
    <img src="https://img.shields.io/badge/TypeORM-FE0803?logo=typeorm&logoColor=white" alt="TypeORM" />
    <img src="https://img.shields.io/badge/Kafka-231F20?logo=apachekafka&logoColor=white" alt="Kafka" />
    <img src="https://img.shields.io/badge/Redis-DC382D?logo=redis&logoColor=white" alt="Redis" />
    <img src="https://img.shields.io/badge/Qdrant-semantic-FF4F64" alt="Qdrant" />
    <img src="https://img.shields.io/badge/AI-LambdaRank-7C3AED" alt="AI LambdaRank" />
  </p>

[Portfolio](https://daongocanh.site)

</div>

---

## Table of contents

1. [Problem](#1-problem)
2. [Service at a glance](#2-service-at-a-glance)
3. [Responsibility and boundaries](#3-responsibility-and-boundaries)
4. [Trust surface](#4-trust-surface)
5. [See it work](#5-see-it-work)
6. [Installation](#6-installation)
7. [Architecture](#7-architecture)
8. [Recommendation request flow](#8-recommendation-request-flow)
9. [Identity, profiles, and sessions](#9-identity-profiles-and-sessions)
10. [Candidate pipeline](#10-candidate-pipeline)
11. [LambdaRank model-only ranking](#11-lambdarank-model-only-ranking)
12. [Ranking model contract](#12-ranking-model-contract)
13. [Ranking observability](#13-ranking-observability)
14. [Catalog and semantic intelligence](#14-catalog-and-semantic-intelligence)
15. [Interaction ingestion and attribution](#15-interaction-ingestion-and-attribution)
16. [Persistence model](#16-persistence-model)
17. [Cache strategy](#17-cache-strategy)
18. [REST API](#18-rest-api)
19. [Admin Recommendation Center](#19-admin-recommendation-center)
20. [Event contracts](#20-event-contracts)
21. [Project structure](#21-project-structure)
22. [Configuration](#22-configuration)
23. [Local development](#23-local-development)
24. [Testing](#24-testing)
25. [Security and privacy](#25-security-and-privacy)
26. [Operations and rollout](#26-operations-and-rollout)
27. [FAQ](#27-faq)
28. [Ownership](#28-ownership)

---

## 1. Problem

A product catalog can contain thousands of valid items, but a customer usually needs a small, relevant set for the current moment. The useful signal is distributed across recent views, clicks, searches, cart actions, purchases, returns, product similarity, popularity, freshness, quality, and the page where the request happens.

Recommendation Service turns those signals into a bounded and explainable product list for:

- the home page;
- product detail pages;
- the dedicated recommendations page;
- guest sessions and authenticated users;
- seller and admin analytics workflows.

Candidate sources create a bounded pool; a trained LambdaRank artifact scores each candidate and diversity rules shape the returned list. If a valid model is unavailable, the recommendation request fails instead of silently using another scoring formula.

---

## 2. Service at a glance

| Property                  | Value                                    |
| ------------------------- | ---------------------------------------- |
| Runtime                   | Node.js with NestJS 11                   |
| Language                  | TypeScript                               |
| Default HTTP port         | 3006                                     |
| HTTP prefix               | /api                                     |
| URI version               | /v1                                      |
| Primary database          | PostgreSQL                               |
| ORM                       | TypeORM                                  |
| Event transport           | Kafka                                    |
| Cache and session context | Redis                                    |
| Semantic retrieval        | Qdrant                                   |
| AI ranking adapter        | AI Service                               |
| Product catalog source    | Internal catalog projection              |
| Health endpoints          | /api/health/live and /api/health/ready   |
| API documentation         | /docs outside production                 |
| Database schema policy    | Migrations only; synchronize is disabled |

### What this service provides

- recommendation serving for multiple surfaces;
- personalized, session-based, and cold-start strategies;
- guest session context;
- merge of guest behavior into a user profile after login;
- interaction ingestion as single events or bounded batches;
- profile projection and preference decay;
- popularity aggregates;
- semantic candidate retrieval;
- co-view, co-cart, and co-purchase candidates;
- deterministic candidate union and deduplication;
- diversity constraints by category, brand, and shop;
- eight documented ranking criteria plus an auxiliary negative signal;
- LambdaRank-only final scoring;
- tracking tokens and attribution context;
- catalog bootstrap and event-based catalog updates;
- admin analytics, read-only model status, and historical policy inspection;
- replay and retention maintenance workflows.

### What this service does not own

- product content, price, stock, or seller ownership;
- user authentication or permission issuance;
- binary media or embedding model training;
- payment, order, or shipping state;
- final frontend presentation;
- arbitrary SQL access for consumers;
- a guarantee that a model artifact is always available; the request reports unavailable if the LambdaRank contract cannot be met.

---

## 3. Responsibility and boundaries

### Recommendation Service owns

| Area                    | Responsibility                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| Recommendation query    | Build context, generate candidates, rank, diversify, paginate                                      |
| User profile projection | Maintain preference signals from interaction events                                                |
| Session context         | Store recent guest or user activity in Redis                                                       |
| Catalog projection      | Maintain serving-ready product fields locally                                                      |
| Candidate generation    | Combine profile, session, popularity, semantic, and relation sources                               |
| Ranking                 | LambdaRank model-only scoring with an explicit unavailable state when no valid artifact is mounted |
| Attribution             | Sign and validate recommendation tracking context                                                  |
| Analytics               | Aggregate impressions, clicks, conversions, and ranking-mode data                                  |
| Embedding jobs          | Dispatch product embedding work and consume generated results                                      |
| Maintenance             | Retention, replay jobs, checkpoints, and admin observability                                       |

### Other services own

| Concern                  | Owner                      | Recommendation interaction                                 |
| ------------------------ | -------------------------- | ---------------------------------------------------------- |
| Product truth            | Product Service            | Publishes catalog changes and provides bootstrap snapshots |
| User identity            | Auth Service / API Gateway | Supplies trusted user or session context                   |
| Order and purchase truth | Order Service              | Publishes purchase and return events                       |
| Cart truth               | Cart Service               | Publishes cart interaction events                          |
| Media and source assets  | Media / Product services   | Not copied into recommendation serving                     |
| Embedding inference      | AI Service                 | Receives internal embedding/ranking requests               |
| Client routing           | API Gateway                | Authenticates, forwards, and protects internal routes      |
| Admin permission         | Auth Service / Gateway     | Injects permission context for admin endpoints             |

Recommendation serving uses its local catalog projection. It does not query Product Service synchronously for every recommendation request.

---

## 4. Trust surface

Recommendation Service handles behavioral data and internal model infrastructure. Its boundaries are intentionally separated:

- public serving routes require a valid user ID or UUID v4 guest session;
- a client cannot submit a different user ID in the interaction body;
- guest users can receive the first recommendation page, while later pages require login;
- admin endpoints require an internal service token and the corresponding permission;
- catalog bootstrap is internal and token-protected;
- AI Service calls use an internal token and send normalized features rather than catalog text or raw user data;
- recommendation tracking tokens are signed with a server-side secret;
- Qdrant and Redis are server-side dependencies and are never called directly by the browser;
- PostgreSQL schema changes run through migrations.

The global ValidationPipe rejects unknown DTO fields and transforms bounded query values. Helmet is enabled at the HTTP boundary.

<details>
<summary><b>Caller permissions and data exposure</b></summary>

| Caller                                           | Allowed operation                                               |
| ------------------------------------------------ | --------------------------------------------------------------- |
| Storefront client through Gateway                | Request recommendations and submit interactions                 |
| Authenticated user                               | Read personalized recommendations and merge a guest session     |
| Guest session                                    | Read first-page recommendations and submit session interactions |
| Internal bootstrap worker                        | Load a catalog snapshot from Product Service                    |
| Recommendation admin with analytics permission   | Read overview, actors, activity, and ranking performance        |
| Recommendation admin with policy-read permission | Read active policy and policy history                           |
| AI Service                                       | Receive internal ranking or embedding requests only             |

Serving responses contain product card fields, ranking metadata, source labels, and safe reason codes. They do not expose profile internals, raw event payloads, private tokens, database entities, or model credentials.

</details>

---

## 5. See it work

### Start the service

```powershell
cd services/recommendation-service
Copy-Item .env.example .env
npm install
npm run dev
```

### Check process liveness

```powershell
curl http://localhost:3006/api/health/live
```

### Check dependency readiness

```powershell
curl http://localhost:3006/api/health/ready
```

Readiness checks the dependencies needed for serving, including PostgreSQL, Redis, Kafka producer state, and vector-index status. The live endpoint only confirms that the HTTP process is running.

### Request guest recommendations

Use a UUID v4 session ID:

```powershell
curl "http://localhost:3006/api/v1/recommendation/recommendations?surface=home&page=1&pageSize=12" -H "x-session-id: 2f4d3e17-1c1e-4ab3-8f06-0b2e25f7a7bd"
```

### Request product-detail recommendations

```powershell
curl "http://localhost:3006/api/v1/recommendation/recommendations?surface=product_detail&productId={productId}&page=1&pageSize=6" -H "x-session-id: 2f4d3e17-1c1e-4ab3-8f06-0b2e25f7a7bd"
```

### Record an interaction

```powershell
curl -X POST http://localhost:3006/api/v1/recommendation/events -H "Content-Type: application/json" -H "x-session-id: 2f4d3e17-1c1e-4ab3-8f06-0b2e25f7a7bd" -d "{\"interactionType\":\"PRODUCT_VIEWED\",\"productId\":\"{productId}\",\"surface\":\"home\"}"
```

A successful interaction response is HTTP 202. It means the event was accepted for Kafka processing; profile and aggregate updates happen asynchronously.

### Read a recommendation response

```json
{
    "requestId": "req_01J...",
    "strategy": "SESSION_BASED",
    "profileState": "GUEST",
    "items": [
        {
            "product": {
                "id": "product-123",
                "name": "Example product",
                "displayPrice": "299000"
            },
            "recommendationItemId": "rec_01J...",
            "rank": 1,
            "score": 0.8421,
            "source": "SEMANTIC_SIMILARITY",
            "reasons": ["similar_to_recent_view"]
        }
    ],
    "rankingMode": "AI_MODEL",
    "rankingModelVersion": "ranking-lambdarank-v2"
}
```

This response is available only when the configured LambdaRank artifact is ready. Otherwise the recommendation endpoint returns an unavailable error; it does not produce a formula-scored list.

---

## 6. Installation

### Prerequisites

- Node.js version supported by the monorepo;
- npm or the repository package manager;
- PostgreSQL;
- Redis;
- Kafka;
- Qdrant when semantic retrieval is enabled;
- Product Service for catalog bootstrap;
- AI Service when testing embeddings or ML ranking;
- Auth and Gateway services for authenticated and admin flows.

### Install dependencies

From the repository root:

```bash
npm install
```

### Configure local environment

```powershell
Copy-Item .env.example .env
```

Set database, broker, Redis, Qdrant, internal service, and ranking values. Configure the mounted LambdaRank artifact and its version before testing recommendations:

```text
RANKING_MODEL_PATH=/mounted/models/ranking-lambdarank-v2.txt
RANKING_MODEL_VERSION=ranking-lambdarank-v2
```

The model is used for every recommendation request. If AI Service or its artifact is not ready, the request returns unavailable until the model is restored.

> [!IMPORTANT]
> Recommendation Service stores behavioral events and derived profiles in PostgreSQL, session context and result caches in Redis, and may call Qdrant, Product Service, Auth Service, and AI Service. It also publishes and consumes Kafka events. All of these are server-side connections. To disable recommendation processing, stop the service or disable its deployment. To remove local data, delete only the dedicated development database and Redis logical database after checking that they are not shared.

### Database migration

The service runs TypeORM migrations on startup and keeps synchronize disabled. Review migrations before production deployment and apply them using the same release process as the service binary.

### Production build

```bash
npm run type-check
npm run lint
npm test -- --runInBand
npm run build
npm run start
```

---

## 7. Architecture

```text
+--------------------+       HTTP        +-------------------------+
| Web / API Gateway  | ----------------> | Recommendation Service  |
+--------------------+                    |                         |
                                          | Query orchestration     |
+--------------------+       Kafka       | Candidate generation    |
| Product / Order    | ----------------> | LambdaRank model        |
| Cart / Auth        |                    | Profile and analytics   |
+--------------------+                    +-----+-------+-------+---+
                                                |       |       |
                                                v       v       v
                                          PostgreSQL Redis   Qdrant
                                          read models cache  vectors
                                                |
                                                v
                                          Kafka consumers
                                          and producers
                                                |
                                                v
                                            AI Service
```

### Bounded contexts

- recommendation serving handles the request-time path;
- interactions handles validation and event ingestion;
- profiles handles user preferences, session context, and popularity;
- catalog handles local product projection and embedding jobs;
- relations handles co-behavior graph signals;
- maintenance handles replay, retention, and operational repair;
- admin-recommendation handles analytics and ranking policy control;
- Kafka and Redis modules provide infrastructure adapters.

---

## 8. Recommendation request flow

```text
Request
  -> validate surface, page, pageSize, productId, user/session identity
  -> select actor and strategy
  -> load profile preferences and session context
  -> build exclusions
  -> generate candidates from enabled sources
  -> union and deduplicate candidates
  -> compute the 8 criteria and auxiliary negative feature
  -> request LambdaRank scores for the candidate batch
  -> fail the recommendation request if the model is unavailable or invalid
  -> apply cold-start mix and diversity limits
  -> paginate the canonical result
  -> issue tracking context and response metadata
```

### Surfaces

| Surface              | Intended use                               | Serving limit              |
| -------------------- | ------------------------------------------ | -------------------------- |
| home                 | Personalized or session-aware home feed    | Up to 24 items per request |
| product_detail       | Similar or related products near a product | Up to 6 items              |
| recommendations_page | Full recommendation browsing page          | Up to 24 items             |

The backend owns candidate selection, ranking, diversity, and pagination. The frontend renders the response and sends attribution events.

### Strategies

| Strategy      | When selected                             |
| ------------- | ----------------------------------------- |
| PERSONALIZED  | Authenticated actor with a usable profile |
| SESSION_BASED | Guest or user with recent session context |
| COLD_START    | No meaningful profile or session signals  |

Cold start uses stable trending, newest, best-selling, and exploration mixes before the normal diversity pass.

---

## 9. Identity, profiles, and sessions

### Actor identity

A request can use:

- x-user-id for an authenticated user;
- x-session-id for a guest or session actor.

The session ID must be UUID v4. A request without either identity is rejected. A guest may request page one, but page two and later require authentication to limit uncontrolled browsing and pagination abuse.

### Profile projection

Interaction events are consumed asynchronously and projected into:

- product preferences;
- category preferences;
- brand preferences;
- recent behavior;
- negative signals;
- profile state and timestamps.

Preference values decay over time so an old click does not permanently dominate current intent. Interaction weights are configured independently for impressions, views, clicks, search, cart, completed purchases, and returns.

### Session context

Redis stores bounded recent context:

- recent product IDs;
- recent interaction signals;
- session expiration;
- maximum recent items.

The context is used for session-based candidates and product-detail anchors. Cache expiration limits stale behavior and memory growth.

### Guest merge

After login, the Gateway calls profile merge with the authenticated x-user-id and guest session ID. The service:

1. validates the authenticated actor and UUID v4 session;
2. merges session preferences and recent context;
3. persists the merge;
4. invalidates affected session and user recommendation caches;
5. deletes or closes the guest context only after a successful merge.

The target user comes from the trusted header, not from the request body.

---

## 10. Candidate pipeline

Candidate generation answers: which products are eligible to be ranked? Ranking answers: in what order should those products be shown?

### Candidate sources

| Source              | Signal                                                             |
| ------------------- | ------------------------------------------------------------------ |
| PROFILE_AFFINITY    | Products aligned with user product, category, or brand preferences |
| SESSION_CONTEXT     | Products related to current recent session behavior                |
| POPULARITY          | Trending, best-selling, or high-quality catalog items              |
| FRESHNESS           | Newly available items suitable for exploration                     |
| SEMANTIC_SIMILARITY | Vector-nearest products from Qdrant                                |
| CO_VIEW             | Products viewed by the same audience                               |
| CO_CART             | Products added to cart in related journeys                         |
| CO_PURCHASE         | Products purchased together or in related journeys                 |
| EXPLORE             | Controlled cold-start and discovery candidates                     |

### Source gates

Advanced sources are enabled by default. Environment master switches are emergency operational controls:

```text
semantic candidates = CANDIDATE_PIPELINE_V3_ENABLED
                      AND SEMANTIC_CANDIDATES_ENABLED

co-behavior candidates = CANDIDATE_PIPELINE_V3_ENABLED
                         AND CO_BEHAVIOR_CANDIDATES_ENABLED
```

A policy cannot override an environment master switch. If a source is unavailable, the pipeline continues with remaining sources.

### Candidate union

The union service:

- excludes the anchor product and already-seen exclusions;
- deduplicates by product ID;
- preserves source coverage;
- keeps contribution scores and reason codes;
- uses bounded source pools;
- prioritizes candidates appearing in multiple sources;
- returns a maximum candidate pool before ranking.

This prevents one noisy source from flooding the entire ranking input.

### Candidate failure behavior

- Qdrant timeout removes semantic candidates for that request;
- missing relation data removes co-behavior candidates;
- empty profile falls back to session or cold-start sources;
- an empty candidate pool returns a safe empty result or configured baseline behavior;
- serving never calls Product Service synchronously to fill a missing candidate.

---

## 11. LambdaRank model-only ranking

Recommendation Service builds one bounded vector per candidate. The eight criteria describe long-term profile affinity, current session intent, semantic similarity, co-behavior, popularity, freshness, quality, and exploration. `negativePenalty` is an auxiliary ninth model input.

The exact equations, mathematical properties, citations, and limits of research support are documented in [the eight-criteria proof](../../docs/recommendation/Sở thích trong hồ sơ/01-co-so-toan-hoc-va-nghien-cuu.md).

### Serving order

1. Candidate sources return a bounded pool; the union removes duplicate products while retaining source attribution.
2. `RankingFeatureService` computes finite inputs in the fixed feature order documented below.
3. `RecommendationMlRankingService` sends only item IDs and normalized feature arrays to AI Service.
4. LambdaRank returns one finite raw relevance score per item. The service rejects missing/duplicate IDs and non-finite scores; it does not clamp predictions or reinterpret them as probabilities.
5. Candidates are sorted by model score, with stable tie-breakers. Diversity caps then constrain repeated category, brand, or shop before pagination.

### Input feature order

| Position | Feature              |      Range |
| -------: | -------------------- | ---------: |
|        1 | `profileAffinity`    |    `[0,1]` |
|        2 | `sessionContext`     |    `[0,1]` |
|        3 | `semanticSimilarity` |    `[0,1]` |
|        4 | `coBehavior`         |    `[0,1]` |
|        5 | `popularity`         |    `[0,1]` |
|        6 | `freshness`          |  `[0.1,1]` |
|        7 | `quality`            |    `[0,1]` |
|        8 | `exploration`        |    `{0,1}` |
|        9 | `negativePenalty`    | `[0,0.15]` |

Each feature remains an input signal. There is no hand-written weighted sum of the eight criteria in the serving path.

### Diversity and pagination

After model sorting, the service applies deterministic category, brand, and seller-shop limits. It builds a canonical result window before pagination so changing `pageSize` does not alter the leading order.

## 12. Ranking model contract

AI Service accepts a batch only when every item has exactly nine finite feature values in `[0,1]`. It returns raw finite scores and a model version. The loaded artifact must have objective `lambdarank`, the configured model version, nine features in the expected order, and training metadata declaring monotone increasing `profileAffinity` and monotone decreasing `negativePenalty` constraints.

Training groups candidates by recommendation `requestId`, uses binary relevance labels, keeps requests wholly inside one split, and requires strict chronological train → validation → test ranges. Validation NDCG@10 selects the early-stopping iteration; test data stays held out. Training/evaluation details and the current evidence status are in [the code and ranking evaluation report](../../docs/recommendation/Sở thích trong hồ sơ/02-kiem-chung-code-va-xep-hang.md).

### Failure contract

If AI Service is unreachable, no valid artifact is loaded, prediction is malformed, scores are non-finite, or item IDs do not match the request, Recommendation Service returns an unavailable error. It does not use a Standard/Hybrid scoring fallback or attach a false model version to the response. Admin model status distinguishes unreachable service from reachable service without a ready artifact.

### Response observability

Successful responses include the request ID, strategy, profile state, rule version, `rankingMode: "AI_MODEL"`, and the loaded model version. Legacy `HYBRID` and `ML_HYBRID` values remain accepted only when reading historical attribution data.

## 13. Ranking observability

The Admin Recommendation Center exposes read-only ranking status and historical attribution analytics. It shows whether AI Service is reachable, whether a compatible artifact is ready, the model version, and the feature count. It does not tune ranking weights, blend scores, or roll back a formula-based policy.

Request counts and click/cart/purchase events in this dashboard are operational analytics. They are not offline ranking metrics and must not be presented as proof that a formula or model improved ranking quality.

---

## 14. Catalog and semantic intelligence

### Local catalog projection

Serving reads a local catalog projection containing:

- product identity and slug;
- name and normalized descriptions;
- category, brand, and seller shop;
- price range;
- rating, review count, and total sold;
- status and in-stock state;
- image reference;
- created and updated timestamps;
- catalog revision;
- semantic content hash.

Recommendation requests do not query Product Service for each item.

### Bootstrap

An internal bootstrap operation reads Product Service catalog snapshots page by page and stores a checkpoint. It is used for initial population or controlled recovery.

```text
POST /api/v1/recommendation/catalog/bootstrap
x-internal-service-token: internal secret
```

### Catalog events

Catalog events update the projection after:

- product creation;
- product update;
- status changes;
- inventory availability changes;
- relevant media or semantic content changes.

Catalog revisions allow consumers to reject stale updates that arrive out of order.

### Embedding pipeline

The embedding workflow:

1. detect a new or changed semantic content hash;
2. create a durable embedding job;
3. lease the job to prevent duplicate dispatch;
4. publish an embedding request to Kafka;
5. receive generated vectors from AI Service;
6. write the vector to the active Qdrant collection;
7. update job status and coverage metadata;
8. make the vector available to semantic candidate retrieval.

Qdrant aliases and collection versions support controlled index changes without forcing request-time downtime.

---

## 15. Interaction ingestion and attribution

### Accepted interaction signals

The service can process signals such as:

- product impression;
- product view;
- product click;
- search performed;
- product added to cart;
- product removed from cart;
- purchase completed;
- purchase returned.

The exact DTO and shared event contract are authoritative for allowed values.

### Single and batch ingestion

| Endpoint                          | Behavior                              |
| --------------------------------- | ------------------------------------- |
| POST /recommendation/events       | Accept one validated interaction      |
| POST /recommendation/events/batch | Accept 1 to 50 validated interactions |

Both return HTTP 202 after Kafka accepts the event. The response is not a promise that all projections have finished.

### Attribution

Recommendation items carry a recommendation item ID and safe source/reason information. The service can create a signed tracking token that binds attribution to:

- actor;
- recommendation request;
- item;
- rank;
- surface;
    - strategy;
    - ranking mode;
- policy/model version.

The tracking secret is required in production and must not be exposed to the browser.

### Event processing

Kafka consumers validate event envelopes before projection. Invalid messages are routed to the appropriate dead-letter topic or error path. Replayable topics and replay jobs allow operators to rebuild derived data without changing the source business records.

---

## 16. Persistence model

Recommendation Service uses PostgreSQL for durable projections, analytics, jobs, and policy state.

### Main data groups

| Group        | Examples                                                        |
| ------------ | --------------------------------------------------------------- |
| Profiles     | actor profile, actor preference, projection event               |
| Interactions | normalized interaction events                                   |
| Catalog      | catalog product, sync checkpoint                                |
| Popularity   | current and daily popularity aggregates                         |
| Relations    | product relation, relation signal, pair event, projection event |
| Embeddings   | embedding job and model/version status                          |
| Maintenance  | replay job and replay job event                                 |
| Admin        | ranking policy and observability aggregates                     |

### Important invariants

- raw interaction events retain a stable event ID;
- profile projections are derived and can be replayed;
- catalog projection is version-aware;
- relation pair events are processed idempotently;
- embedding jobs have lease, attempt, acknowledgment, and failure state;
- policy history is append-only from the API perspective;
- cache keys include relevant policy and ranking versions;
- user and session identity are not mixed accidentally during guest merge.

### Retention

Retention is configurable and disabled by default in the local template. When enabled, maintenance can remove:

- old raw interaction events;
- old aggregate data;
- completed embedding jobs;
- old replay jobs and replay event records;
- stale relation safety data.

Retention affects derived recommendation data, not product, order, payment, or user source-of-truth records.

---

## 17. Cache strategy

Redis stores:

- session context;
- recommendation result cache;
- profile/session invalidation markers where configured;
- bounded recent item signals.

### Cache key principles

Keys include enough context to prevent cross-result reuse:

- actor type and actor ID;
- surface;
- product anchor;
- page and page size;
- relevant strategy;
- catalog/ranking policy version;
- candidate-source state when it affects the result.

### Invalidation

The service invalidates affected caches when:

- a user profile changes;
- a guest session is merged;
- ranking policy changes;
- catalog revision changes in the serving scope;
- operational candidate-source master-switch changes.

It does not flush the entire Redis deployment for one policy or profile change.

### Failure behavior

- Redis unavailable: serving may use a cold context or bypass result cache according to the application path;
- stale cache: versioned keys prevent reuse after a policy change;
- session expiration: actor falls back to profile or cold-start behavior;
- cache TTL is bounded to avoid permanent stale recommendations.

---

## 18. REST API

All routes use /api/v1 when URI versioning is enabled.

### GET /recommendation/recommendations

Returns a ranked recommendation page.

| Parameter    | Meaning                                       |
| ------------ | --------------------------------------------- |
| surface      | home, product_detail, or recommendations_page |
| productId    | Optional anchor product for product detail    |
| page         | Page number                                   |
| pageSize     | Requested page size within surface limits     |
| x-user-id    | Authenticated identity from Gateway           |
| x-session-id | UUID v4 guest/session identity                |

The response includes products, rank, score, source, reasons, strategy, profile state, pagination, request ID, policy version, ranking mode, and model version.

### POST /recommendation/profile/merge

Merges a guest session into the authenticated user profile.

- user identity comes from x-user-id;
- body contains the guest session UUID v4;
- the client cannot choose a different target user;
- affected profile and recommendation caches are invalidated after a successful merge.

### POST /recommendation/events

Accepts one interaction and returns HTTP 202 with eventId and queued status.

### POST /recommendation/events/batch

Accepts 1 to 50 interactions and returns HTTP 202 with event IDs. The whole input is validated before publishing.

### POST /recommendation/catalog/bootstrap

Internal catalog bootstrap. Requires x-internal-service-token and should be run by an operator or controlled job, not by the browser.

### Health

| Route               | Purpose                                |
| ------------------- | -------------------------------------- |
| GET /health/live    | Process liveness only                  |
| GET /health/ready   | Dependency readiness and serving state |
| GET /health/metrics | Service metrics when enabled           |

### Error expectations

- 400 for invalid query, body, date range, UUID, or pagination;
- 401 for missing identity or internal token;
- 403 for missing admin permission;
- 503 when LambdaRank is unavailable, an event cannot be accepted by Kafka, or a required dependency is unavailable.

---

## 19. Admin Recommendation Center

The Admin Recommendation Center is served below /api/v1/admin/recommendation and is protected by an internal token guard plus permission checks.

### Analytics endpoints

| Method | Route                                        | Permission                          |
| ------ | -------------------------------------------- | ----------------------------------- |
| GET    | /admin/recommendation/overview               | ADMIN_RECOMMENDATION_ANALYTICS_READ |
| GET    | /admin/recommendation/users                  | ADMIN_RECOMMENDATION_ANALYTICS_READ |
| GET    | /admin/recommendation/users/:userId/activity | ADMIN_RECOMMENDATION_ANALYTICS_READ |
| GET    | /admin/recommendation/ranking-performance    | ADMIN_RECOMMENDATION_ANALYTICS_READ |

Analytics ranges default to the most recent 30 days and are limited to 31 days.

### Policy endpoints

| Method | Route                                | Permission                       |
| ------ | ------------------------------------ | -------------------------------- |
| GET    | /admin/recommendation/config         | ADMIN_RECOMMENDATION_POLICY_READ |
| GET    | /admin/recommendation/config/history | ADMIN_RECOMMENDATION_POLICY_READ |

### Read-only model status

```json
{
    "rankingMode": "AI_MODEL",
    "objective": "lambdarank",
    "version": "ai-lambdarank-profile-v2",
    "runtime": {
        "model": {
            "reachable": true,
            "ready": true,
            "modelVersion": "ranking-lambdarank-v2",
            "featureCount": 9
        }
    }
}
```

The config endpoint only reports model readiness and candidate-source switches. The history endpoint is for reading archived configuration records; ranking weight updates and policy rollback are not supported.

Candidate-source ENV switches are operational controls. They do not change the final scorer: every successful request uses LambdaRank.

### Model readiness fields

The status distinguishes:

- AI Service reachable;
- compatible artifact loaded;
- model version and feature count;
- enabled candidate sources.

If the artifact is not ready, recommendations return unavailable. Historical `HYBRID`/`ML_HYBRID` attribution values may still appear in analytics.

---

## 20. Event contracts

### Consumed event families

| Family                     | Purpose                                                     |
| -------------------------- | ----------------------------------------------------------- |
| Interaction events         | Update profiles, session signals, popularity, and analytics |
| Catalog events             | Upsert or invalidate the local product projection           |
| Purchase events            | Strengthen co-purchase and user preference signals          |
| Embedding-generated events | Complete embedding jobs and update vectors                  |
| Replay events              | Reprocess supported historical topics                       |

### Produced event families

| Family                                 | Purpose                                             |
| -------------------------------------- | --------------------------------------------------- |
| Interaction events                     | Forward normalized behavior to Kafka                |
| Embedding-requested events             | Ask AI Service to generate product vectors          |
| Replay/dead-letter events              | Isolate invalid or failed processing                |
| Catalog or relation integration events | Support downstream synchronization where configured |

Kafka topics, consumer groups, retry delays, and dead-letter names are centralized in the service Kafka configuration and shared contracts. Do not invent a new topic name in a controller or application service.

### Processing guarantees

- interaction APIs acknowledge only after publish succeeds;
- consumers validate event identity and payload;
- derived writes are designed for replay;
- failed messages are isolated instead of silently discarded;
- consumer group separation prevents embedding, relation, and interaction workloads from sharing offsets accidentally.

---

## 21. Project structure

```text
services/recommendation-service/
+-- src/
|   +-- main.ts
|   +-- app.module.ts
|   +-- database/
|   |   +-- catalog/
|   |   +-- embedding/
|   |   +-- interactions/
|   |   +-- maintenance/
|   |   +-- policies/
|   |   +-- popularity/
|   |   +-- profiles/
|   |   +-- relations/
|   |   +-- migrations/
|   +-- infrastructure/
|   |   +-- redis/
|   +-- kafka/
|   |   +-- config/
|   |   +-- consumers/
|   |   +-- producers/
|   +-- modules/
|       +-- admin-recommendation/
|       |   +-- application/
|       |   +-- infrastructure/
|       |   +-- presentation/
|       +-- catalog/
|       +-- health/
|       +-- interactions/
|       +-- maintenance/
|       +-- profiles/
|       +-- recommendation/
|       |   +-- application/
|       |       +-- services/
|       |           +-- candidates/
|       |           +-- ranking/
|       |           +-- query/
|       |           +-- tracking/
|       +-- relations/
+-- .env.example
+-- package.json
+-- tsconfig.json
+-- README.md
```

### Module responsibilities

- application services contain use-case and policy logic;
- presentation controllers validate transport input and call application boundaries;
- infrastructure clients isolate AI, Product, Auth, Qdrant, Redis, and persistence details;
- database entities and migrations define durable state;
- Kafka consumers adapt events into processors;
- admin modules never bypass the same runtime policy used by serving.

---

## 22. Configuration

Use [.env.example](./.env.example) as the canonical local template.

### Runtime and database

| Variable          | Purpose                    |
| ----------------- | -------------------------- |
| NODE_ENV          | Environment behavior       |
| PORT              | HTTP port, default 3006    |
| APP_VERSION       | Version returned by health |
| TYPEORM_LOGGING   | Enable SQL logging         |
| POSTGRES_HOST     | PostgreSQL host            |
| POSTGRES_PORT     | PostgreSQL port            |
| POSTGRES_USER     | PostgreSQL user            |
| POSTGRES_PASSWORD | PostgreSQL password        |
| POSTGRES_DB       | Recommendation database    |

### Kafka

| Variable                  | Purpose                                 |
| ------------------------- | --------------------------------------- |
| KAFKA_BROKERS             | Comma-separated brokers                 |
| KAFKA_CLIENT_ID           | Kafka client identifier                 |
| KAFKA_CONSUMER_GROUP      | Main interaction/profile consumer group |
| KAFKA_RECONNECT_DELAY_MS  | Consumer reconnect delay                |
| KAFKA_RETRY_BASE_DELAY_MS | Initial retry delay                     |
| KAFKA_RETRY_MAX_DELAY_MS  | Maximum retry delay                     |

### Redis

| Variable                                | Purpose                   |
| --------------------------------------- | ------------------------- |
| REDIS_HOST                              | Redis host                |
| REDIS_PORT                              | Redis port                |
| REDIS_PASSWORD                          | Redis password            |
| REDIS_DB                                | Isolated logical database |
| RECOMMENDATION_CACHE_TTL_SECONDS        | Result cache TTL          |
| RECOMMENDATION_SESSION_TTL_SECONDS      | Session context TTL       |
| RECOMMENDATION_SESSION_MAX_RECENT_ITEMS | Recent-item bound         |

### Internal services

| Variable               | Purpose                                |
| ---------------------- | -------------------------------------- |
| PRODUCT_SERVICE_URL    | Catalog bootstrap source               |
| AUTH_SERVICE_URL       | Account directory for admin analytics  |
| AI_SERVICE_URL         | Internal embedding and ranking service |
| INTERNAL_SERVICE_TOKEN | Service-to-service credential          |

### Candidate and embeddings

| Variable                       | Purpose                               |
| ------------------------------ | ------------------------------------- |
| CANDIDATE_PIPELINE_V3_ENABLED  | Master switch for advanced candidates |
| SEMANTIC_CANDIDATES_ENABLED    | Semantic candidate source             |
| CO_BEHAVIOR_CANDIDATES_ENABLED | Relation candidate source             |
| EMBEDDING_DISPATCHER_ENABLED   | Enable embedding job dispatch         |
| EMBEDDING_MODEL                | Embedding provider model              |
| EMBEDDING_MODEL_VERSION        | Stored vector version                 |
| QDRANT_URL                     | Qdrant endpoint                       |
| QDRANT_COLLECTION_ALIAS        | Active collection alias               |
| QDRANT_COLLECTION_VERSION      | Physical collection version           |
| QDRANT_VECTOR_SIZE             | Vector dimension                      |
| QDRANT_DISTANCE                | Cosine, Dot, or Euclid                |
| QDRANT_TIMEOUT_MS              | Fail-soft vector request timeout      |

### Profile and ranking

| Variable                               | Purpose                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| RECOMMENDATION_RANKING_POLICY_VERSION  | Ranking/cache contract version                                                                                |
| RECOMMENDATION_PROFILE_HALF_LIFE_DAYS  | Must remain `7`; other values are rejected because stored aggregates require replay before changing half-life |
| RECOMMENDATION_PROFILE_*_WEIGHT        | Product/category/brand profile mix                                                                            |
| RECOMMENDATION_PROFILE_*_SCALE         | Profile dimension normalization                                                                               |
| RECOMMENDATION*WEIGHT*\*               | Interaction weights                                                                                           |
| RECOMMENDATION_TRACKING_SECRET         | Signed attribution secret                                                                                     |
| AI_SERVICE_URL                         | Internal AI Service URL                                                                                       |
| ML_RANKING_TIMEOUT_MS                  | AI ranking request budget                                                                                     |
| RECOMMENDATION_POLICY_SYNC_INTERVAL_MS | Policy polling interval                                                                                       |

### Maintenance

| Variable                                    | Purpose                 |
| ------------------------------------------- | ----------------------- |
| RECOMMENDATION_RETENTION_ENABLED            | Enable retention worker |
| RECOMMENDATION_RAW_RETENTION_DAYS           | Raw event retention     |
| RECOMMENDATION_AGGREGATE_RETENTION_DAYS     | Aggregate retention     |
| RECOMMENDATION_EMBEDDING_JOB_RETENTION_DAYS | Embedding job retention |
| RECOMMENDATION_REPLAY_JOB_RETENTION_DAYS    | Replay job retention    |
| REPLAY_MAX_ATTEMPTS                         | Replay attempt limit    |

Infrastructure credentials and model endpoints remain environment-owned. Admin can inspect model status and historical policy records, but cannot change ranking behavior, model paths, internal tokens, or candidate-source emergency switches.

---

## 23. Local development

### Commands

```bash
npm run dev
npm run type-check
npm run lint
npm test
npm run build
npm run start
```

### Recommended sequence

1. Start PostgreSQL and create the dedicated recommendation database.
2. Start Redis and Kafka.
3. Start Qdrant if semantic candidates or embeddings are enabled.
4. Start Product Service and the internal Auth/Gateway dependencies.
5. Copy .env.example to .env.
6. Mount a LambdaRank artifact whose version/schema match AI Service configuration.
7. Verify AI Service reports a ready model before testing recommendation serving.
8. Start Recommendation Service and verify live/ready health endpoints.
9. Run catalog bootstrap once for an empty catalog projection.
10. Produce interaction and catalog events.
11. Request recommendations for a guest UUID v4 session.
12. Log in and test profile merge.
13. Inspect `rankingMode: AI_MODEL`, policy version, reasons, and model metadata.

### Swagger

When NODE_ENV is not production:

```text
http://localhost:3006/docs
```

Swagger documents the HTTP routes. Kafka event schemas remain defined by shared event contracts and the service's Kafka configuration.

---

## 24. Testing

### Candidate and ranking unit tests

Cover:

- source enable/disable rules;
- candidate deduplication and source coverage;
- exclusion of anchor and previously seen items;
- feature normalization and score bounds;
- LambdaRank-only serving and unavailable-model behavior;
- negative penalty;
- cold-start source quotas;
- category, brand, and shop diversity;
- deterministic tie-breaking;
- empty and degraded candidate sources.

### Profile and session tests

Cover:

- interaction weight application;
- preference decay;
- session TTL and maximum recent items;
- guest merge into the authenticated user;
- invalidation after merge;
- actor separation between user and session;
- new-user and cold-start strategy selection.

### AI ranking tests

Cover:

- every successful request calls AI Service;
- unavailable model or invalid output fails the request;
- response metadata reports `AI_MODEL` and the loaded version;
- finite raw score ordering is preserved;
- model feature order contains all nine features.

### Admin policy tests

Cover:

- model status shows readiness, reachability, version and feature count;
- config/history endpoints remain read-only;
- candidate-source switches match environment controls;
- legacy policy history does not alter the serving algorithm.

### Integration and E2E

Use real or test instances of PostgreSQL, Kafka, Redis, Qdrant, and AI Service stubs to verify:

- catalog bootstrap and checkpoint continuation;
- interaction publish and asynchronous projection;
- relation and embedding consumers;
- cache invalidation;
- recommendation response metadata;
- admin model status and read-only policy history;
- LambdaRank scoring and unavailable behavior when AI Service is unavailable.

### Commands

```bash
npm run type-check
npm run lint
npm test -- --runInBand
npm run build
```

---

## 25. Security and privacy

- keep Recommendation Service behind API Gateway in production;
- trust x-user-id, x-session-id, and permission headers only from the Gateway boundary;
- never accept a target user ID from the guest-merge body;
- require UUID v4 guest sessions;
- require internal tokens for catalog bootstrap and admin routes;
- keep tracking secrets, service tokens, and AI credentials in deployment secrets;
- never send raw user event history or catalog text to the AI ranking endpoint;
- do not expose Redis, Kafka, Qdrant, PostgreSQL, or AI Service publicly;
- avoid logging product-level behavioral payloads when a request ID is sufficient;
- do not log tracking secrets or authorization headers;
- apply DTO whitelist and forbid unknown properties;
- use Helmet security headers;
- use least-privilege database and Qdrant credentials;
- use TLS for production service-to-service connections;
- bound pagination, batch sizes, candidate pools, and analytics date ranges;
- redact or aggregate user identifiers in admin exports;
- retain raw behavioral data only for the configured operational period;
- do not use the assignment hash for authentication or authorization.

---

## 26. Operations and rollout

### Health probes

- use /api/health/live for process liveness;
- use /api/health/ready before routing traffic;
- alert on PostgreSQL, Redis, Kafka, Qdrant, or AI readiness failures;
- monitor memory because candidate pools and batch processing are bounded but still workload-sensitive.

### Key metrics

Track:

- recommendation request count and latency by surface;
- empty-result rate;
- strategy distribution;
- candidate source contribution and failure rate;
- successful `AI_MODEL` response count;
- model unavailable, timeout, and invalid-response count;
- model readiness and model version;
- cache hit/miss and invalidation rate;
- interaction publish and consumer lag;
- profile projection delay;
- catalog checkpoint age and event lag;
- embedding job success, lease expiry, and DLQ count;
- replay success and retention batch duration;
- model-status checks and historical attribution modes.

### Safe rollout

1. Validate the LambdaRank artifact on held-out data before deployment.
2. Confirm candidate sources, catalog projection, profile feature tests, and tracking.
3. Verify AI Service health and exact model version/schema.
4. Start recommendation traffic only after Admin reports the artifact ready.
5. Monitor latency, unavailable errors, exposure/click attribution, and model version.
6. If the model is unhealthy, remove recommendation traffic until a validated artifact is restored; the service does not switch scorers.

### Multi-instance behavior

- instances share PostgreSQL, Redis, Qdrant, and Kafka;
- interaction consumers use stable consumer groups;
- runtime policy sync propagates the active cache/attribution contract version across instances;
- versioned cache keys prevent old ranking results from being reused;
- do not flush all Redis for a policy update;
- old cache entries expire naturally;
- outbox, lease, and idempotency state prevent duplicate derived work.

### Incident response

When recommendation quality or availability drops:

1. inspect health and consumer lag;
2. check candidate-source and Qdrant errors;
3. confirm model version and artifact status;
4. stop recommendation traffic while the model is unavailable;
5. inspect cache and catalog projection freshness;
6. replay only the affected derived topic or job;
7. restore traffic after artifact and schema validation.

---

## 27. FAQ

### What happens if the LambdaRank model is unavailable?

Recommendation returns an unavailable response. It does not create a list with a formula scorer or mark a fallback as a model result. Restore a validated artifact before sending recommendation traffic.

### Why does an old event say HYBRID or ML_HYBRID?

Those values are accepted only for historical attribution. Successful recommendations from the current serving path report `AI_MODEL` with the loaded model version.

### Why is a guest unable to request page two?

Guest serving is intentionally limited to the first page. Login and profile merge provide a stable actor identity for deeper pagination and personalization.

### Why does a new catalog product not appear immediately?

Recommendation uses a local catalog projection. The product must arrive through bootstrap or catalog events before it can enter candidate generation.

### What happens when Qdrant is down?

Semantic candidates are skipped for the affected request. If another source provides candidates and LambdaRank is ready, the model still ranks them.

### What happens when Redis is down?

Session context or result-cache reads may be degraded, but durable profile and catalog data remain in PostgreSQL. Candidate generation may use the remaining available context; final scoring still requires LambdaRank.

### Can Admin change AI service URL or model path?

No. Those are infrastructure settings owned by deployment configuration. Admin controls ranking policy; candidate sources are controlled only by operational ENV switches.

### Can Admin edit ranking weights or the model path?

No. Admin only reads model readiness and archived policy history. Model path/version are deployment configuration, and final scoring always uses LambdaRank.

### Is a 202 interaction response proof that the profile has updated?

No. It confirms that Kafka accepted the event. Projection, relation, popularity, and profile updates happen asynchronously.

### Can an old policy be edited in place?

No. Legacy policy history is read-only and retained for audit; the current admin API does not update or roll back those scoring rules.

---

## 28. Ownership

### Engineering

**Đào Ngọc Anh**

**Software Engineer**

[View portfolio](https://daongocanh.site)

Software Engineer responsible for the architecture, implementation, integration, and maintenance of this service.

### Architecture and API design

**Đào Ngọc Anh**

Designed the recommendation serving pipeline, profile projection, candidate sources, LambdaRank model-only scoring, attribution boundary, catalog intelligence, and read-only model observability for the Bin E-Commerce ecosystem.
