import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { telegramConnection } from "./telegram-connections";
import { store } from "./tenant";

/**
 * `telegram_active_storefront` — the one logically active buyer screen for a
 * verified store, bot connection, private chat and buyer.
 *
 * It stores only the message identity and lifecycle metadata: the Telegram
 * message id, whether that message currently carries media, the last rendered
 * route, the pending text-input mode, a monotonic revision and the last
 * Telegram update id that advanced it.
 *
 * Cart lines, checkout details, inventory, payments, orders and receipts stay
 * in their existing commerce tables. Return context (list/category/search
 * origin) stays in `telegram_navigation_context`; this table does not duplicate
 * it.
 */
export type TelegramStorefrontRoute =
  | "storefront"
  | "home"
  | "products"
  | "categories"
  | "category"
  | "search"
  | "product"
  | "cart"
  | "review"
  | "transfer"
  | "order"
  | "language"
  | "notice"
  | "receipt_bridge";

export type TelegramStorefrontInputMode =
  | "none"
  | "search"
  | "phone"
  | "address"
  | "transfer_reference";

export const telegramActiveStorefront = pgTable(
  "telegram_active_storefront",
  {
    storeId: uuid("store_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    botId: bigint("bot_id", { mode: "number" }).notNull(),
    telegramUserId: bigint("telegram_user_id", { mode: "number" }).notNull(),
    telegramChatId: bigint("telegram_chat_id", { mode: "number" }).notNull(),
    activeMessageId: bigint("active_message_id", { mode: "number" }).notNull(),
    hasMedia: boolean("has_media").notNull().default(false),
    route: text("route").notNull().default("storefront"),
    inputMode: text("input_mode").notNull().default("none"),
    revision: integer("revision").notNull().default(1),
    lastUpdateId: bigint("last_update_id", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "telegram_active_storefront_pkey",
      columns: [
        table.storeId,
        table.connectionId,
        table.botId,
        table.telegramUserId,
        table.telegramChatId,
      ],
    }),
    foreignKey({
      name: "telegram_active_storefront_store_fk",
      columns: [table.storeId],
      foreignColumns: [store.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "telegram_active_storefront_connection_fk",
      columns: [table.connectionId],
      foreignColumns: [telegramConnection.id],
    }).onDelete("cascade"),
    check(
      "telegram_active_storefront_route_check",
      sql`${table.route} IN (
        'storefront', 'home', 'products', 'categories', 'category', 'search',
        'product', 'cart', 'review', 'transfer', 'order', 'language',
        'notice', 'receipt_bridge'
      )`,
    ),
    check(
      "telegram_active_storefront_input_mode_check",
      sql`${table.inputMode} IN (
        'none', 'search', 'phone', 'address', 'transfer_reference'
      )`,
    ),
    check(
      "telegram_active_storefront_message_positive_check",
      sql`${table.activeMessageId} > 0`,
    ),
    check(
      "telegram_active_storefront_bot_positive_check",
      sql`${table.botId} > 0`,
    ),
    check(
      "telegram_active_storefront_user_positive_check",
      sql`${table.telegramUserId} > 0`,
    ),
    check(
      "telegram_active_storefront_chat_positive_check",
      sql`${table.telegramChatId} > 0`,
    ),
    check(
      "telegram_active_storefront_revision_check",
      sql`${table.revision} >= 1`,
    ),
    check(
      "telegram_active_storefront_update_positive_check",
      sql`${table.lastUpdateId} >= 0`,
    ),
  ],
);
