---
phase: 01
slug: schema-data-conventions
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: 2026-07-08
---

# Phase 01 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| Prisma migration engine → live `users` / `refresh_tokens` tables | Migration DDL crosses into tables that (in principle) hold existing accounts and active refresh tokens | Account rows, refresh-token hashes |
| Auth layer → JWT / HTTP response serializer | A `bigint` user id crossing into `JSON.stringify` (JWT sign, response body) throws or silently rounds unless encoded | Authenticated user identity |
| Future producer/consumer → `events.snapshot` Json column | Later phases write effect/report payloads verbatim into `snapshot`; the column is shaped here | Untrusted device/report payloads (Phase 5/6) |
| Future API responses → internal BigInt `id` vs external `public_id` | Schema shapes both identifiers; which is exposed is a Phase 2 decision | Resource identity (enumerable vs non-enumerable) |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-01-01 | Tampering / Repudiation | Migration rename (`User`→`users`) | high | mitigate | Migrations are CREATE-only — no `DROP TABLE`/`DROP COLUMN` in `prisma/migrations/`; rename folded into the unpushed init migration so history reads as `users` from the start (no destructive rewrite of a populated table) | closed |
| T-01-02 | Tampering / Repudiation | Migration widen (`MODIFY COLUMN` → BigInt) | high | mitigate | `id BIGINT NOT NULL AUTO_INCREMENT` restated in migration SQL (both init & refresh_tokens); `SHOW CREATE TABLE` acceptance gate passed — AUTO_INCREMENT/NOT NULL preserved | closed |
| T-01-03 | Tampering / Information Disclosure | `events.snapshot` (native JSON, untrusted payload stored verbatim) | low | accept | Verbatim storage is the intended audit-log design (D-07); no query-time trust decision exists in Phase 1. Payload validation lives in the producer/consumer path (Phases 5/6) | closed |
| T-01-04 | Information Disclosure | Internal sequential BigInt `id` exposed externally in place of `public_id` | medium | mitigate | `public_id` (`@unique @db.VarChar(21)`) shaped now on all four user-facing models (House/Room/Device/Command); internal-only models carry no `public_id`. Route-level control (return public_id, never internal id) lands in Phase 2 — flagged as RESEARCH Open Question 4 | closed |
| T-01-05 | Denial of Service (self-inflicted) | Auth JWT/response serialization of bigint id | medium | mitigate | id carried as string across the JWT boundary (`user.id.toString()`, read side `BigInt(request.user.id)`), `Number(user.id)` at HTTP response boundaries; raw bigint never hits `JSON.stringify`. `npm run build` gate confirms the type threading compiles | closed |
| T-01-SC | Tampering | npm/pip/cargo installs (supply chain) | low | accept | No package-manager installs occur in Phase 1; `nanoid`/`uuid` install + legitimacy gate deferred to Phase 2/5 per RESEARCH Package Legitimacy Audit | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-01 | T-01-03 | `events.snapshot` stores untrusted payloads verbatim by design (append-only audit log, D-07); no Phase-1 query-time trust decision. Validation deferred to producer/consumer path (Phases 5/6) | Leah | 2026-07-08 |
| AR-02 | T-01-SC | No package installs in Phase 1; supply-chain legitimacy gate deferred to Phase 2/5 when `nanoid`/`uuid` are actually added | Leah | 2026-07-08 |

*Accepted risks do not resurface in future audit runs.*

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-07-08 | 6 | 6 | 0 | gsd-secure-phase (L1 grep-depth, short-circuit: threats_open 0, register authored at plan time, ASVS L1) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-07-08

---

## Carried Forward to Phase 2

- **T-01-04 residual control:** routes must return `public_id`, never the internal BigInt `id`. Column is shaped; the exposure control is a Phase 2 responsibility (RESEARCH Open Question 4).
- **BigInt serialization strategy:** decide the global approach (BigInt.prototype.toJSON shim vs Prisma result extension vs never returning internal id) when the domain models are first returned in HTTP responses.
