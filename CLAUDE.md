# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The migration/build workflow lives in @.claude/rules/setup.md — read it before starting any conversion work. Current batch status and where to resume lives in @.claude/rules/progress.md — read it at the start of every batch (each batch begins a fresh context window).

## What this is

Numera is a South African accounting app. The original single-file vanilla-JS version **Numera.html** (~5900 lines) is frozen at `legacy/` and serves as the **parity oracle**: every converted feature is validated against it, and it is the place to trace legacy logic (`LS` wrapper, `sk()` key suffixing, `ROLES/ACCESS` ACL at 2524, FY validation 2769–2850, COA 4628–4698, export engine ~4175).

The rewrite lives in `apps/` (npm workspaces, started with batch 1):

```
apps/shared/   @numera/shared  — ACL (ROLES/ACCESS/MODS/SECN, accOf/canSec), COA groups/types, ported verbatim from legacy
apps/api/      @numera/api     — Express 5 + TS + pg, Neon Postgres. Raw SQL migrations in migrations/ (numbered, sha256-locked by scripts/migrate.mjs)
apps/web/      @numera/web     — Angular 22 (zoneless, standalone, signals)
```

- Run API: `npm run dev:api` (:8788, tsx watch). Run web: `npm run dev:web` (:4200, `proxy.conf.json` sends /api → 8788). Neon connection string in `apps/api/.env` (gitignored, never echo it).
- Verify: `npm run migrate -w @numera/api` / `npm run seed -w @numera/api`; `npx tsc --noEmit` per package; `npm run build -w @numera/web`.
- Validation contract (setup.md): every feature is exercised in the browser with Playwright before it counts as done.

### Backend conventions

- Errors are `{error: string}` with status 400/401/403/404/409; 500 never leaks SQL. `requireCan(mod, sec)` is the guard (admin bypasses); every mutation logs via `logEv`.
- pg: DATE columns parse to plain `YYYY-MM-DD` strings (global type parser in `db.ts`, never JS Date); NUMERIC arrives as string — `Number()` at the edges.
- `financial_years`: `end_date`, aliased as `"end"` in queries; `withHistory()` normalizes dates + parses the jsonb history. Versioned migration files only — never reorder applied ones.
- ACL is `accOf(u)`: overrides replace the whole ACCESS map (wholesale, not merged); no access rows in `user_company_access` = all companies (legacy `userCos` semantics).
- Email settings: SMTP password AES-256-GCM at rest, never returned — `has_password` boolean only.

### Angular conventions (zoneless!)

- Zoneless change detection: **async assignments to plain properties do not render** — either use signals or call `inject(ChangeDetectorRef).detectChanges()` after the await.
- Strict templates: TS4111 — index signatures (e.g. `Record`s) need bracket access; use `@if/@for` control flow.
- Auth in `core/auth.store.ts` (signals user/access/companies/company/fyName); guards in `core/guards.ts` (`canSecGuard` reads `route.data {mod, sec}`); `deny()` toast + `/dashboard` redirect. Route gating mirrors legacy `canSec`.
- Legacy parity: error strings, tab names (`SECN`), sidebar labels/order, role chips are ported verbatim — when a UI string differs from legacy, that's a bug unless deliberate.

### Batch status

Done: batch 1 (auth, roles, multi-company, settings, COA, GL foundation) on branch `batch-1/auth-gl-foundation`; batch 2 (customers/suppliers/inventory + AR/AP + GL transactions/enquiries + procurement PI/DN) on branch `batch-2/masterdata-ar-ap-gl`. Next: batch 3 (contracts + billing). Full table, deviations, demo credentials and resume pointers: @.claude/rules/progress.md.

## Legacy reference (frozen)

Details below apply to `legacy/Numera.html` only — kept for parity tracing; the rewrite uses Postgres FKs instead of localStorage suffixes, Express routes instead of global functions.

- Persistence lived in localStorage (`LS`/`sk()` ~2513), per-company suffix `@<CO_ID>`; module data in `DATA`/`DKEY` (~3208); seeding functions started with `if(CO_BLANK()) return []`.
- Export engine (~4175) built real .pdf/.xlsx byte-by-byte (`zipStore`, `buildXlsx`, hand-rolled PDF writer) — same approach will be used for batch 7 reports.
- The last `<script>` block (~5888) is the boot sequence; `migrateCoaStorage()` (~5877) was the one-time COA renumber (not ported — seeds use post-renumber codes).
- Email modes: simulate/mailto/relay (POST JSON + Bearer to the Node relay, `numera-mail-relay.js` — keep its validation/rate-limit/scrub properties if touched).

## Conventions

- South African context throughout: ZAR formatting, VAT (15%, returns), PAYE, 4-monthly provisional tax, company registration/VAT number formats. Keep new sample data realistic for SA (names, rates, terminology).
- Legacy code style: dense inline functions with short cryptic names — ported verbatim where it matters. New code follows the rules in `.claude/rules/`.
