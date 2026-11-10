# Numera conversion progress

State of the setup.md migration. Read this first when resuming work — each batch starts a fresh context window.
Plan of record: `C:\Users\James\.claude\plans\start-converting-the-app-robust-leaf.md`.

## Locked decisions

- Strangler approach: convert feature-by-feature, validate each with Playwright against the frozen oracle `legacy/Numera.html`.
- Stack: Angular 22 (zoneless, signals) + Express 5 + TS + Neon Postgres (raw SQL migrations, no ORM).
- Journals materialize as `journal_lines` rows on posting (legacy derived them at render).
- Fresh start: legacy PBKDF2 hashes not ported; new scrypt auth + DB sessions.
- One branch per batch on GitHub; `main` updates only when the whole conversion is done.

## Batch status

| Batch | Scope | Status |
|---|---|---|
| 1 | auth + roles + multi-company + settings + COA + GL foundation | ✅ done, commit `5d6978e` on `batch-1/auth-gl-foundation` (2026-11-10) |
| 2 | customers/suppliers/inventory + AR/AP + GL transactions & enquiries (glJournalBase → posting-time journal inserts) | next |
| 3 | contracts + billing (+Employees stays 4) | |
| 4 | service/work orders (+ employees, service types) | |
| 5 | procurement/buybacks/conversions (glBB/glCV) | |
| 6 | VAT (vat_periods table + assertPostingDate port of checkPostingDate 2791) | |
| 7 | reports/budgets/exports + closing journal + FY totals recompute | |
| after | statements/outbox/dashboard KPIs, PAYE, tax calendar, localStorage importer option | deferred |

## Batch 1 — what exists now

- Branch `batch-1/auth-gl-foundation`, commit `5d6978e`. Dev servers: `npm run dev:api` (:8788) + `npm run dev:web` (:4200).
- API: auth (login/lockout/must_change/change-password), users CRUD + access-override PATCH, companies + profile + switch/delete, FYs (validate/close/reopen/set-current/delete), email settings (AES-256-GCM password, `has_password` only, relay test), accounts CRUD, activity log, `/api/gl/summary`. Sessions = `sessions` table + httpOnly `numera_sid` cookie, idle timeout from `app_settings`.
- Web: login, change-password, company picker, shell (16-module sidebar, unconverted modules dimmed), dashboard stub, settings tabs (company/years/companies/users/roles/email/log; ctypes/sitypes/svctypes/employees render as disabled pills), COA CRUD, toast.
- Migrations 001–006 applied to Neon; seed run (demo company, 26-account COA, 3 FYs 2023/24 closed · 2024/25 current · 2025/26 open, 4 demo users).
- Validated with Playwright: login negatives + lockout, must_change flow, per-role gating matrix (accountant/bookkeeper/viewer nav + API 403s), COA CRUD + system-account rules, users CRUD, roles save/reset, companies switch-without-reload + delete guards, FY gap/close/reopen/set-current/delete, email save + relay-test error, activity log ('—' for failed sign-ins), GL summary.
- Gates green: `ng build` (385 kB), `tsc --noEmit` (api).

### Batch 1 deviations (deliberate)

- Blank companies seed the full 26-account chart at zero balances (legacy blank = empty COA via `CO_BLANK()`) so posting works out of the box.
- FY table Income/Expenses/Net columns read zeros until the report batch (batch 7).
- Legacy COA renumber `COA_OLD2NEW` not ported — seeds use post-renumber codes.

### Demo credentials (demo-grade — change before real use)

admin/N@mera2026 · nomsa/Numera@2026nx · thabo/Mokoena@2026 · pieter/DeWet@2026. All except admin had `must_change` cleared during validation.

## Batch 2 entry pointers

- Legacy sources to port first: customers/suppliers/inventory maintenance + transaction capture; `glJournalBase` (5533–5545) decides which posting rules each doc type uses; `TB_BASE` balances already became `opening_balance`.
- Recurring conventions in hand (see CLAUDE.md backend/Angular sections): pg DATE-as-string, `withHistory` normalization, zoneless CD (signals or `detectChanges()`), `logEv` on every mutation, `requireCan`, verbatim legacy strings.
- Validate each module page + its posting path in Playwright before starting the next one.
