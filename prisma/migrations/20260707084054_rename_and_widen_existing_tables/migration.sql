-- Rename the existing populated `User` table to `users` (snake_case @@map convention),
-- add the `deleted_at` soft-delete column, and widen the three integer PK/FK columns to
-- BIGINT for uniform keys across the schema. Hand-authored (not a generated diff) because
-- Prisma's migration engine does not detect renames and would otherwise emit a destructive
-- pair of statements for the name change (dropping and recreating the table), which would
-- delete every existing user and refresh-token row. This is ONE migration for all
-- existing-table changes per the Phase 1 unpushed-migration rule.

-- RenameTable
RENAME TABLE `User` TO `users`;

-- AddColumn (soft delete, DATA-03)
ALTER TABLE `users` ADD COLUMN `deleted_at` DATETIME(3) NULL;

-- AlterTable: widen PK to BIGINT, restating AUTO_INCREMENT. In MySQL/MariaDB, altering a
-- column's type is a full redefinition of that column, so every pre-existing attribute
-- must be restated here or it is silently dropped.
ALTER TABLE `users` MODIFY COLUMN `id` BIGINT NOT NULL AUTO_INCREMENT;

-- AlterTable: widen refresh_tokens PK to BIGINT, restating AUTO_INCREMENT.
ALTER TABLE `refresh_tokens` MODIFY COLUMN `id` BIGINT NOT NULL AUTO_INCREMENT;

-- AlterTable: widen refresh_tokens FK to BIGINT, restating NOT NULL.
ALTER TABLE `refresh_tokens` MODIFY COLUMN `user_id` BIGINT NOT NULL;
