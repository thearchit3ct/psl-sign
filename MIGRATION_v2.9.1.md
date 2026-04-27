# Migration Documenso v2.3.2 → v2.9.1

PSL self-hosted Documenso (sign.pslconferences.com) — upgrade tracking
checklist. Migration de **2025-12-24 (v2.3.2)** vers **2026-04-23 (v2.9.1)**.

## Pourquoi maintenant

- **4 CVE de sécurité** corrigées dans la fenêtre (deps transitives auth/trpc)
- **Signing reminders** (#1749, v2.9.0) — supprime le suivi manuel des relances
- **More webhook events** (#2125) — débloque la création d'Activity CRM sur les étapes intermédiaires (gap connu côté psl-backend)
- 220 commits / 6 versions mineures / 8 migrations DB de retard

## Phase 1 — Audit (en cours)

- [x] Audit des 220 commits via `git log v2.3.2..v2.9.1`
- [x] Liste des migrations DB (8 nouvelles)
- [x] Identification des features pertinentes pour PSL
- [x] Liste des CVE corrigées (CVE-2026-22817, 22818, 23527, 29045)
- [ ] Lecture des release notes intermédiaires (`gh release view v2.4.0` … `v2.9.1`)
- [x] **Inventaire des nouvelles env vars — toutes optionnelles, aucune requise pour PSL**
  - License (`NEXT_PRIVATE_DOCUMENSO_LICENSE_KEY`) — paid features, n/a
  - GCloud HSM signing (4 vars) — pas utilisé, signing local
  - `NEXT_PRIVATE_USE_LEGACY_SIGNING_SUBFILTER` — backward compat flag, défaut OK
  - `NEXT_PRIVATE_ALLOWED_SIGNUP_DOMAINS` — signup déjà désactivé via `NEXT_PUBLIC_DISABLE_SIGNUP=true`
  - BullMQ (`NEXT_PRIVATE_REDIS_URL`, `_REDIS_PREFIX`, `_BULLMQ_CONCURRENCY`) — on reste sur `local` provider
  - Turnstile captcha (`NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `NEXT_PRIVATE_TURNSTILE_SECRET_KEY`) — opt-in, no-op si absent
  - **Conclusion** : `docker-compose.prod.yml` peut rester inchangé

## Phase 2 — Merge upstream

- [x] Branche `upgrade/documenso-v2.9.1` créée depuis `main`
- [x] `git merge v2.9.1` — fast-forward réussi sans conflit sur le code Documenso
- [x] Conflit `.gitignore` résolu (PSL `.env*.local` + upstream additions)
- [x] `npm install` — clean (lockfile minor delta, libc field normalization)
- [x] `prisma generate` — succès (v6.19.3, 156 migrations détectées)
- [ ] **Build complet local** — non vérifié localement, sera fait sur le VPS via `docker compose build`
- [x] Commit du lockfile mis à jour

## Phase 3 — Test sur dump DB

⚠️ **Backup Supabase obligatoire avant tout** — la base Documenso vit dans le même cluster Supabase que le portail PSL.

- [ ] `pg_dump` de la DB Documenso (schéma `documenso` ou base dédiée — à vérifier)
- [ ] Restore sur une copie locale
- [ ] `npx prisma migrate deploy` sur la copie pour appliquer les 8 nouvelles migrations
- [ ] Smoke test : créer un doc → signer → audit log → upload R2

## Phase 4 — Déploiement Contabo

VPS host : `sign.pslconferences.com` (Contabo)

- [ ] Backup DB Supabase + bucket R2 `psl-documents`
- [ ] SSH sur le VPS, vérifier que le repo est sur `main`
- [ ] `git pull origin main` après merge de la PR
- [ ] `docker compose -f docker-compose.prod.yml build` (long — Alpine + Chromium + dépendances)
- [ ] `docker compose -f docker-compose.prod.yml up -d`
- [ ] Surveiller `docker logs documenso` pour erreurs migration / encryption / auth
- [ ] Health check : https://sign.pslconferences.com/api/health
- [ ] Smoke test e2e : signer un doc test depuis le portail

## Phase 5 — Intégration features (post-déploiement)

Travail côté **psl-backend** une fois Documenso v2.9.1 en prod. Tracker via une issue dédiée sur le repo psl-backend.

- [ ] **More webhook events** (#2125) — wire `DOCUMENT_SENT`, `RECIPIENT_VIEWED`, `RECIPIENT_SIGNED` → création d'Activity CRM sur le Lead lié (comble le gap noté 2026-04-26)
- [ ] **Signing reminders** (#1749) — configurer les paramètres de relance par défaut au niveau organisation Documenso
- [ ] **Per-recipient envelope expiration** (#2519) — option de date de validité côté UI quote-signing du portail
- [ ] **Document rename** (#2542) — exposer dans l'UI portail si pertinent

## CVE corrigées dans la fenêtre

| CVE              | Date       | Files touched                                      |
| ---------------- | ---------- | -------------------------------------------------- |
| CVE-2026-22817   | 2026-01-15 | `apps/remix/`, `packages/auth/` (deps)             |
| CVE-2026-22818   | 2026-01-15 | (idem)                                             |
| CVE-2026-23527   | 2026-01-27 | `packages/prisma/`, `packages/trpc/` (deps)        |
| CVE-2026-29045   | 2026-03-09 | `apps/remix/`, `packages/auth/` (deps)             |

## Migrations DB ajoutées

```
4935f387b feat: signing reminders (#1749)
7cb64c3d0 fix: allow nullable document audit logs (#2682)
36bbd9751 feat: add organisation template type (#2611)
70fb834a6 feat: add more webhook events (#2125)
0ce909a29 refactor: find envelopes (#2557)
c112392da feat: add admin email domain management and sync job (#2538)
653ab3678 feat: better ratelimiting (#2520)
006b1d0a5 feat: per-recipient envelope expiration (#2519)
```

Schema Prisma : +105 / -27 lignes.

## Risques identifiés

- **Encryption keys** (`NEXT_PRIVATE_ENCRYPTION_KEY` / `_SECONDARY_KEY`) — vérifier qu'aucun changement de format/rotation n'est introduit
- **Auth flow** — Turnstile captcha (v2.9.0) ajoute potentiellement `TURNSTILE_SITE_KEY` / `_SECRET` env vars — à confirmer
- **Storage R2** — refactor `find envelopes` (#2557), à smoke-tester
- **Build time** — premier build après 4 mois de deps va être long
- **Schema migration cascade** — tester sur une copie avant prod, jamais directement
