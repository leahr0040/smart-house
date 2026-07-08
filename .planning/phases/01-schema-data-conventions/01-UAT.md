---
status: complete
phase: 01-schema-data-conventions
source: [01-01-SUMMARY.md, 01-02-SUMMARY.md]
started: 2026-07-08T20:08:17Z
updated: 2026-07-08T20:09:30Z
---

## Current Test

[testing complete]

## Tests

### 1. Cold Start Smoke Test
expected: Stop any running server. From a clean state, apply migrations to a fresh/reset DB and start the app. All 3 migrations apply without error, `prisma migrate status` is clean (no drift/pending), the server boots, and a basic query (e.g. a login/register round-trip or `prisma studio` opening the tables) works.
result: pass

### 2. users table: soft-delete + BigInt PK
expected: `users` table is live with a nullable `deleted_at` column and a `BIGINT AUTO_INCREMENT` primary key.
result: pass
source: automated
coverage_id: D1

### 3. Uniform BigInt keys across auth tables
expected: `users.id`, `refresh_tokens.id`, and `refresh_tokens.user_id` are all `BIGINT` with AUTO_INCREMENT/NOT NULL preserved.
result: pass
source: automated
coverage_id: D2

### 4. Auth layer stays BigInt-safe and JSON-safe
expected: Auth plugin/services/routes compile against the bigint Prisma client and stay JSON-safe at the JWT/HTTP-response boundaries (build clean, 3/3 tests pass).
result: pass
source: automated
coverage_id: D3

### 5. Ten domain models authored to convention
expected: House, Room, Device, Command, CommandTarget, LightState, AcState, HeaterState, SensorState, Event exist in schema.prisma with BigInt PKs, correct public_id placement, denormalized user_id, soft-delete/morph columns, dual-id events, no @relation on FK-shaped columns, no native DB enums.
result: pass
source: automated
coverage_id: D1

### 6. Additive domain migration applied cleanly
expected: One additive migration creates all ten tables (CREATE TABLE only, no DROP/ALTER on users/refresh_tokens); `prisma migrate status` up to date, no drift.
result: pass
source: automated
coverage_id: D2

### 7. Full Phase 1 acceptance gate green
expected: migrate status clean, build zero errors, existing auth tests pass, convention audit (last_event_id x4, deleted_at x4, (deviceId,recordedAt) index) confirmed.
result: pass
source: automated
coverage_id: D3

## Summary

total: 7
passed: 7
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps

[none yet]
