-- CreateTable
CREATE TABLE `houses` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `public_id` VARCHAR(21) NOT NULL,
    `user_id` BIGINT NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `address` VARCHAR(191) NULL,
    `deleted_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `houses_public_id_key`(`public_id`),
    INDEX `houses_user_id_idx`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `rooms` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `public_id` VARCHAR(21) NOT NULL,
    `house_id` BIGINT NOT NULL,
    `user_id` BIGINT NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `floor` INTEGER NOT NULL DEFAULT 0,
    `room_type` VARCHAR(191) NULL,
    `deleted_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `rooms_public_id_key`(`public_id`),
    INDEX `rooms_house_id_idx`(`house_id`),
    INDEX `rooms_user_id_idx`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `devices` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `public_id` VARCHAR(21) NOT NULL,
    `user_id` BIGINT NOT NULL,
    `room_id` BIGINT NOT NULL,
    `house_id` BIGINT NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `device_type` VARCHAR(191) NOT NULL,
    `manufacturer` VARCHAR(191) NULL,
    `model` VARCHAR(191) NULL,
    `deleted_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `devices_public_id_key`(`public_id`),
    INDEX `devices_user_id_idx`(`user_id`),
    INDEX `devices_room_id_idx`(`room_id`),
    INDEX `devices_house_id_idx`(`house_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `commands` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `public_id` VARCHAR(21) NOT NULL,
    `user_id` BIGINT NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'received',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `commands_public_id_key`(`public_id`),
    INDEX `commands_user_id_idx`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `command_targets` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `command_id` BIGINT NOT NULL,
    `device_id` BIGINT NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `deadline_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `command_targets_command_id_idx`(`command_id`),
    INDEX `command_targets_device_id_idx`(`device_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `light_states` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `device_id` BIGINT NOT NULL,
    `is_on` BOOLEAN NOT NULL DEFAULT false,
    `brightness` INTEGER NOT NULL DEFAULT 0,
    `last_event_at` DATETIME(3) NULL,
    `last_event_id` BIGINT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    UNIQUE INDEX `light_states_device_id_key`(`device_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ac_states` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `device_id` BIGINT NOT NULL,
    `is_on` BOOLEAN NOT NULL DEFAULT false,
    `target_temp` INTEGER NOT NULL,
    `mode` VARCHAR(191) NOT NULL,
    `last_event_at` DATETIME(3) NULL,
    `last_event_id` BIGINT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    UNIQUE INDEX `ac_states_device_id_key`(`device_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `heater_states` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `device_id` BIGINT NOT NULL,
    `is_on` BOOLEAN NOT NULL DEFAULT false,
    `target_temp` INTEGER NOT NULL,
    `last_event_at` DATETIME(3) NULL,
    `last_event_id` BIGINT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    UNIQUE INDEX `heater_states_device_id_key`(`device_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sensor_states` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `device_id` BIGINT NOT NULL,
    `reading` DECIMAL(6, 2) NOT NULL,
    `unit` VARCHAR(191) NOT NULL,
    `last_event_at` DATETIME(3) NULL,
    `last_event_id` BIGINT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    UNIQUE INDEX `sensor_states_device_id_key`(`device_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `events` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `event_id` CHAR(36) NOT NULL,
    `entity_type` VARCHAR(191) NOT NULL,
    `source` VARCHAR(191) NOT NULL,
    `event_kind` VARCHAR(191) NOT NULL,
    `device_id` BIGINT NULL,
    `device_type` VARCHAR(191) NULL,
    `command_id` BIGINT NULL,
    `snapshot` JSON NOT NULL,
    `recorded_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `events_event_id_key`(`event_id`),
    INDEX `events_device_id_recorded_at_idx`(`device_id`, `recorded_at`),
    INDEX `events_command_id_idx`(`command_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `refresh_tokens_user_id_idx` ON `refresh_tokens`(`user_id`);
