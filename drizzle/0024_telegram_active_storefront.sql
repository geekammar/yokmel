CREATE TABLE "telegram_active_storefront" (
	"store_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"bot_id" bigint NOT NULL,
	"telegram_user_id" bigint NOT NULL,
	"telegram_chat_id" bigint NOT NULL,
	"active_message_id" bigint NOT NULL,
	"has_media" boolean DEFAULT false NOT NULL,
	"route" text DEFAULT 'storefront' NOT NULL,
	"input_mode" text DEFAULT 'none' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"last_update_id" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_active_storefront_pkey" PRIMARY KEY("store_id","connection_id","bot_id","telegram_user_id","telegram_chat_id"),
	CONSTRAINT "telegram_active_storefront_route_check" CHECK ("telegram_active_storefront"."route" IN (
        'storefront', 'home', 'products', 'categories', 'category', 'search',
        'product', 'cart', 'review', 'transfer', 'order', 'language',
        'notice', 'receipt_bridge'
      )),
	CONSTRAINT "telegram_active_storefront_input_mode_check" CHECK ("telegram_active_storefront"."input_mode" IN (
        'none', 'search', 'phone', 'address', 'transfer_reference'
      )),
	CONSTRAINT "telegram_active_storefront_message_positive_check" CHECK ("telegram_active_storefront"."active_message_id" > 0),
	CONSTRAINT "telegram_active_storefront_bot_positive_check" CHECK ("telegram_active_storefront"."bot_id" > 0),
	CONSTRAINT "telegram_active_storefront_user_positive_check" CHECK ("telegram_active_storefront"."telegram_user_id" > 0),
	CONSTRAINT "telegram_active_storefront_chat_positive_check" CHECK ("telegram_active_storefront"."telegram_chat_id" > 0),
	CONSTRAINT "telegram_active_storefront_revision_check" CHECK ("telegram_active_storefront"."revision" >= 1),
	CONSTRAINT "telegram_active_storefront_update_positive_check" CHECK ("telegram_active_storefront"."last_update_id" >= 0)
);
--> statement-breakpoint
ALTER TABLE "telegram_active_storefront" ADD CONSTRAINT "telegram_active_storefront_store_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_active_storefront" ADD CONSTRAINT "telegram_active_storefront_connection_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."telegram_connection"("id") ON DELETE cascade ON UPDATE no action;