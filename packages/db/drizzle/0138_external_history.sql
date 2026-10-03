CREATE TABLE IF NOT EXISTS `external_thread_bindings` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	`source_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`session_id` text NOT NULL,
	`runtime_provider_id` text,
	`runtime_session_id` text,
	`generation` integer NOT NULL,
	`last_order` integer,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `external_thread_bindings_identity_idx` ON `external_thread_bindings` (`project_id`,`plugin_id`,`source_id`,`conversation_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `external_thread_messages` (
	`thread_id` text NOT NULL,
	`generation` integer NOT NULL,
	`external_id` text NOT NULL,
	`source_order` integer NOT NULL,
	`digest` text NOT NULL,
	`session_id` text NOT NULL,
	`source_sequence` integer NOT NULL,
	PRIMARY KEY(`thread_id`, `generation`, `external_id`),
	FOREIGN KEY (`thread_id`) REFERENCES `external_thread_bindings`(`thread_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `external_thread_messages_order_idx` ON `external_thread_messages` (`thread_id`,`generation`,`source_order`);