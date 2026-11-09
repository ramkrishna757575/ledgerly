ALTER TABLE `rules` ADD `min_amount` integer;--> statement-breakpoint
ALTER TABLE `rules` ADD `max_amount` integer;--> statement-breakpoint
ALTER TABLE `rules` ADD `account_id` integer REFERENCES accounts(id);