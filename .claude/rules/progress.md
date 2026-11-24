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
| 1 | auth + roles + multi-company + settings + COA + GL foundation | âœ… done, commit `5d6978e` on `batch-1/auth-gl-foundation` (2026-11-10) |
| 2 | customers/suppliers/inventory + AR/AP + GL transactions & enquiries (glJournalBase â†’ posting-time journal inserts) | âœ… done on `batch-2/masterdata-ar-ap-gl` (2026-11-11) |
| 3 | contracts + billing (+Employees, minimal assets) | âœ… done on `batch-3/contracts-billing` (2026-11-24) |
| 4 | service/work orders (+ employees, service types) | |
| 5 | procurement/buybacks/conversions (glBB/glCV) | |
| 6 | VAT (vat_periods table + assertPostingDate port of checkPostingDate 2791) | |
| 7 | reports/budgets/exports + closing journal + FY totals recompute | |
| after | statements/outbox/dashboard KPIs, PAYE, tax calendar, localStorage importer option | deferred |

## Batch 3 — done (2026-11-24)

Branch `batch-3/contracts-billing`, committed. Migration `008_contracts.sql`. Scope: contracts + billing + minimal assets (register-only) + employees (batch 4 gets depreciation/service).

### Gates — tsc api + web green; ng build 611.87 kB initial

### Bug found & fixed during final validation
- **SPA login lost access map**: `POST /auth/login` returned only `{user, companies}`, so the login component never populated `auth.access` — `authGuard` short-circuits when `user()` is set, so `/auth/me` was never called, leaving `access = {}`. Truthy-but-empty override made `accOf` return an empty access map → sidebar items disabled and `canSecGuard` denied everything until a full page reload (this is also the real cause of last session's "company-picker tile didn't fire" note — that flow needs a 2-company user, which the DB no longer has). Fix: login response now includes `access: effAccess(u)` and the login component sets it.

### Validated (Playwright, direct scripts — Playwright MCP plugin failed to connect this session)
- **thabo (bookkeeper) per-role gating** (15/15 PASS): login (seed `Thabo@2025` → change-password → `Mokoena@2026`, must_change cleared — DB had been reset), admin tile click on /company-picker (forced URL — single-company DB, tiles render late, click auto-waits and lands on /dashboard), nav shows Contract Billing/Assets/Contract Management enabled with correct hrefs, `/cbilling/run` + `/customers/cinvc` open, `/settings/ctypes|employees` deny-redirect to /dashboard with verbatim toast "You do not have access to this area.", POST `/api/ctypes` + `/api/settings/employees` → 403, GET `/api/billing/periods` → 200. (Contracts endpoints mount at `/api`, not `/api/contracts` — `/api/ctypes`, `/api/contracts`, `/api/escalations`.)
- **Invoice modal Print/Download** (`InvModalComponent`): Download → `Invoice_CINV-00004.html`; Print → popup contains the invoice doc.

### Demo DB state
Seed artifacts (batch 2) + FY 2026/27 (2026-04-01–2027-03-31 open), AST-0007 (Dell Precision, 2025-06-15), AST-0006 Disposed (2026-11-11), CON-0005 (Woolworths, Service 1 500 ×24, start 2026-11-11), CINV-00001..00004, meter readings CON-0004 M1/M2 billed in 2025-03, ESC-0001. Period 2025-03 **closed**, 2025-04 open (blocked until readings captured). Passwords: admin `N@mera2026!`, nomsa `Numera@2026nx`, thabo `Mokoena@2026`, pieter `DeWet@2026n`.

### Validated with Playwright (admin on Demo Company unless noted)
- **Billing periods** `/cbilling/periods`: Close 2025-03 (verbatim confirm + toast "Period 2025-03 closed.", closedAt/closedBy rendered), Reopen (dialog "Readings and invoices in it can then be added to again."), re-close, blockers — Close 2025-04 → 400 verbatim blocker list ("CON-0004 AST-0004 Mono: no closing reading" ×2).
- **Escalation** `/cbilling/escalate`: empty list was Neon-latency mis-read (list fine); validation order verbatim ('Enter the increase — it must be greater than zero.' → 'A percentage increase cannot exceed 100%.' → 'Enter the date the escalation takes effect.' → 'Select at least one contract item or meter to escalate.'); applied ESC-0001 5% eff 2026-01-01 → line 6 500 → **6 825** displayed, Last escalated 1 Jan 2026, history row "ESC-0001 | 11 Nov 2026 | 1 Jan 2026 | 5% | … | admin"; already-escalated check verbatim ("CON-0001 · … was already escalated from 1 Jan 2026. Choose a later effective date.").
- **Settings ▸ Ctypes** `/settings/ctypes`: empty form → "Choose a GL revenue account." (after schema fix); add "Maintenance Plan" (toast "Contract type saved."), delete unused with confirm `Delete "Maintenance Plan"?`, in-use meter delete → `"Mono" is used on a meter and cannot be deleted. Deactivate it instead.` (400), deactivate/activate Mono round-trip (Active↔Inactive chips).
- **Settings ▸ Employees** `/settings/employees` (after path fix): seeded EM-0001..0003 listed w/ roles + use counts; empty add → "Enter the employee's name."; added EM-0004 Sipho Ndlovu, edit (roles toggled), dup + role-removal guards verbatim ("Tick at least one role.", "Naledi Khumalo is the Contract Manager on CON-0003, so that role cannot be removed."), in-use delete 409 ("Pieter Botha is used on a contract and cannot be deleted. Deactivate instead."), deactivate/re-activate Lerato, delete Sipho (confirm `Delete Sipho Ndlovu?`) — DB back to seed state.
- **Customers ▸ Contract Invoices** `/customers/cinvc` (after route fix): lists CINV-00001..00004 w/ line detail, View modal (due 30/04/2025, payment details, VAT Act §20 footer), Shoprite filter narrows to 2.
- **Per-role gating**: pieter (viewer, `Pieter@2025` seed, must_change cleared via change-password → now `DeWet@2026n`): /settings/employees → /dashboard redirect, /customers/cinvc → /dashboard, POST /api/settings/employees 403 "You do not have access to this area."; **/cbilling/run LOADS** — verbatim legacy (`viewer: { cbilling: '*' }` grants trans; confirmed canSec 2541).

### Batch 3 deviations / notes (for the write-up)
- Legacy alert() replaced by toast for dispose/date-guard errors (same verbatim strings).
- Meter invoice description lacks legacy thousand separators ("12500 → 13050").
- ctypes/mtypes/employees Delete-for-unused + guard strings are new (legacy list had no delete; legacy toggle-only for in-use).
- Viewer `cbilling:'*'` means viewer CAN open Billing Run / post (legacy quirk, ported verbatim; don't "fix" without flagging).
- Settings sitypes/svctypes from batch 1; ctype/mtype 'Description' column empty for seeds (descr nullable).

## Batch 2 — done (2026-11-11)

Branch `batch-2/masterdata-ar-ap-gl`. Migration 007 (`007_masterdata_tx.sql`) applied. Gates green: `tsc --noEmit` api + web, `ng build` 514 kB (initial budget raised to 600 kB warning in `apps/web/angular.json`).

### Validated with Playwright (all admin unless noted)
- **Customers**: list/stats/edit prefill+save, SI (price autofill, verbatim stock error, post), receipt, journals CJ-2025-001/002 (posting preview 6100 dr / contra cr), credit note CN-2025-009 (R900/R135), account enquiry (closing 128 400, credit-limit sub-labels), aged debtors (verbatim 5-bucket headers, "Total (agrees to GL 6100)" R478 865).
- **Suppliers**: list, SUP-006 Multiplate Printers (defaultExp 4050), supplier journal SJ-2025-001 (preview credits 9000/debits 4050, This Period row), aged creditors (all balances in 120+ bucket for 2025-11 dates, total R46 700 agrees to GL 9000), supplier account enquiry (0 → 2 500 → 2 500).
- **Procurement**: PI capture PI-2025-023 (Multiplate MP-7781, 2025-11-13, 3 200/480/3 680) with defaultExp prefill on supplier select; duplicate theirNo → verbatim 409 "This supplier invoice number has already been captured."; debit note DN-2025-004 (500/75/575) renders in list.
- **Inventory**: items (7 items/4 groups; CS-001 35 on hand = 40 − 5 from SI-2025-042; OE-002 Low Stock at qty 5); categories (add CAT-06 Packaging gl 6200/cos 2000/sales 1000; empty-name → verbatim 40-char error; delete-with-items → 409 "The category still has items and cannot be deleted."); add item PK-001 Bubble Wrap (dup SKU → "The SKU PK-001 already exists."); stock card (opening 40 → sale −5 → closing 35, value R2 975); valuation by category (R77 629 total incl. PK-001, "agrees to GL 6200").
- **GL**: journal entry — unbalanced (1000/500) → verbatim "Cannot post: debits must equal credits and be greater than zero."; balanced JNL-2025-098 Bank fees correction posted; batches — GJB-2025-010 Save as Open → Post from list (journal_lines appear), unbalanced GJB-2025-011 Post → "Cannot post: this batch is out of balance."; account enquiry 4060 (0 → dr300 → 300, Net debit movement/Debit balance labels); journal enquiry (all module postings listed, search "surcharge" filters, from-date filter works).
- **Settings sitypes**: tab live, NI-004 Consulting Fee added, deactivated → Inactive chip.
- **Per-role gating**: nomsa `Bafana@2026`, thabo `Mokoena@2026`, pieter `DeWet@2026n` (must_change clears on first login). Accountant: full finance/ops nav + users 403; bookkeeper: gl `trans,enq` only — COA Add Account button hidden + POST /api/accounts 403 + deny redirect to /dashboard; viewer: no trans/maint — deep-link /suppliers/jnl redirects to dashboard, POST /api/sup-journal 403.
- GL journal-lines endpoint lists every module posting (SI/DN/PI/SJ/CJ/CN/RCP/JNL/GJB) with correct dr/cr legs — posting-time `journal_lines` design confirmed end to end.

### Bugs found & fixed during validation
- `procurement.pages.ts`: PI expense-account prefill came from `sups()[0]`, not the selected supplier → `pickSup()` on supplier change.
- `procurement.pages.ts`: DN list read `d.ex` but API returns `excl` → "R 0,00"; renamed.
- `inventory.routes.ts`: `catSchema` regex on gl/cos/sales short-circuited the verbatim legacy messages with the generic 400 → plain `z.string()` (server checks at legacy 4775–4787 order already existed).
- `gl.pages.ts`: journal-enquiry search box never filtered — `filtered` was a `computed` reading plain-property `q` (untracked) → plain accessor arrow.
- Cross-cutting render note (not a bug): DOM reads ~1.5s after navigation often show the empty state before Neon latency + zoneless flush land; re-probe or verify via `fetch('/api/...')`.

### Demo DB artifacts
SUP-006 · SJ-2025-001 · PI-2025-023 · DN-2025-004 · CN-2025-009 · RCP-2025-024 · CJ-2025-001/002 · JNL-2025-098 · GJB-2025-010/011 · CAT-06 Packaging · PK-001 · NI-004 (Inactive). `reset-demo.mjs` restores a clean seed.

### Batch 2 deviations (deliberate)
- Auto refs (JNL-/GJB-/PI-/DN-/…) instead of legacy pre-computed doc numbers.
- Receipt allocation to specific invoices omitted (single GL receipt).
- Categories table subset; 'Add Account'/'Add Category' merged into tabs.
- SI list chips Overdue/Sent only (legacy had more states).
- CN/DN persisted as documents (legacy was list-based).
- Sub-journal "This Period" lists not period-filtered.
- sitypes deactivate-only (no rename/edit).
- Rep/cashbook batches deferred.
- Category GL-account selects list all accounts; first-digit guard enforces asset/expense/income serverside (legacy filtered in UI).

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

admin/N@mera2026 Â· nomsa/Numera@2026nx Â· thabo/Mokoena@2026 Â· pieter/DeWet@2026. All except admin had `must_change` cleared during validation.

## Batch 2 entry pointers

- Legacy sources to port first: customers/suppliers/inventory maintenance + transaction capture; `glJournalBase` (5533–5545) decides which posting rules each doc type uses; `TB_BASE` balances already became `opening_balance`.
- Recurring conventions in hand (see CLAUDE.md backend/Angular sections): pg DATE-as-string, `withHistory` normalization, zoneless CD (signals or `detectChanges()`), `logEv` on every mutation, `requireCan`, verbatim legacy strings.
- Validate each module page + its posting path in Playwright before starting the next one.
