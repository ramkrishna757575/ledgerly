CREATE TABLE `investment_imports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_id` integer,
	`source` text NOT NULL,
	`as_of` text NOT NULL,
	`status` text DEFAULT 'staged' NOT NULL,
	`payload` text,
	`warnings` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`committed_at` text,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `investment_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`import_id` integer NOT NULL,
	`position_id` integer NOT NULL,
	`date` text NOT NULL,
	`kind` text NOT NULL,
	`amount` integer NOT NULL,
	`units` integer NOT NULL,
	`nav` integer,
	`description` text NOT NULL,
	`fingerprint` text NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `investment_imports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`position_id`) REFERENCES `positions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `investment_tx_position_idx` ON `investment_transactions` (`position_id`,`date`);--> statement-breakpoint
CREATE INDEX `investment_tx_fingerprint_idx` ON `investment_transactions` (`fingerprint`);--> statement-breakpoint
CREATE TABLE `positions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`isin` text,
	`folio` text,
	`scheme_code` text,
	`asset_class` text DEFAULT 'other' NOT NULL,
	`account_id` integer,
	`history_from` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `positions_isin_idx` ON `positions` (`isin`);--> statement-breakpoint
CREATE INDEX `positions_folio_idx` ON `positions` (`folio`);--> statement-breakpoint
CREATE TABLE `valuations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`import_id` integer NOT NULL,
	`position_id` integer NOT NULL,
	`as_of` text NOT NULL,
	`units` integer NOT NULL,
	`nav` integer NOT NULL,
	`value` integer NOT NULL,
	`invested` integer,
	`xirr_bps` integer,
	FOREIGN KEY (`import_id`) REFERENCES `investment_imports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`position_id`) REFERENCES `positions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `valuations_import_position_unique` ON `valuations` (`import_id`,`position_id`);--> statement-breakpoint
CREATE INDEX `valuations_position_idx` ON `valuations` (`position_id`,`as_of`);