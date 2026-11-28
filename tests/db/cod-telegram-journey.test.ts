import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";

import {
  appUser,
  botSetting,
  buyerLanguagePreference,
  cart,
  cartItem,
  category,
  categoryTranslation,
  inventoryReservation,
  language,
  order,
  orderItem,
  product,
  productInventory,
  productTranslation,
  store,
  storeCommerceSetting,
  storeLanguageSetting,
  storeMembership,
  telegramActiveStorefront,
  telegramConnection,
  telegramNavigationContext,
} from "@/db/schema";
import type { Database } from "@/db/client";
import type { TransactionDatabase } from "@/db/transaction-client";
import type { MerchantAccess } from "@/lib/auth/merchant-session";
import { saveStorefrontProfile } from "@/lib/merchant/storefront-profile";
import { EMPTY_STOREFRONT_PROFILE } from "@/lib/merchant/storefront-profile-fields";
import { readLatestBuyerCodOrder } from "@/lib/commerce/orders";
import {
  readStoreLanguageChoice,
  resolveBuyerLanguage,
} from "@/lib/data/store-language";
import { saveMerchantStoreLanguage } from "@/lib/merchant/store-language";
import { hashWebhookSecret } from "@/lib/telegram/connection-secrets";
import { handleManagedTelegramWebhookRequest } from "@/lib/telegram/managed-webhook";
import {
  NAVIGATION_CONTEXT_PRUNE_BATCH_SIZE,
} from "@/lib/telegram/navigation-context";
import { tokens } from "@/lib/telegram/tokens";
import {
  createFakeTelegramTransport,
  type FakeTelegramTransport,
} from "@/lib/telegram/transport";
import {
  asAppDb,
  createTestDatabase,
  hasTestCluster,
  nextOrder,
  readStoreScopeForFixture,
  type TestDatabase,
} from "./helpers";

const shouldRun = hasTestCluster();

type ProductContractOverride = {
  imageUrl?: string | null;
  availability?: { available: number; inStock: boolean };
};

/**
 * The shared managed reader is owned by a parallel worker. The production
 * handler already consumes `imageUrl` and `availability`; this passthrough stub
 * lets these journey tests prove the contract without waiting for that branch
 * and without adding a second catalog read.
 */
const productContract = vi.hoisted(
  () => new Map<string, ProductContractOverride>(),
);

vi.mock("@/lib/catalog/managed-storefront", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/catalog/managed-storefront")>();

  function withContract<T extends { id: string }>(item: T): T {
    const override = productContract.get(item.id);
    return override ? { ...item, ...override } : item;
  }

  return {
    ...actual,
    readManagedProduct: async (
      ...args: Parameters<typeof actual.readManagedProduct>
    ) => {
      const item = await actual.readManagedProduct(...args);
      return item ? withContract(item) : null;
    },
    listManagedProducts: async (
      ...args: Parameters<typeof actual.listManagedProducts>
    ) => {
      const page = await actual.listManagedProducts(...args);
      return { ...page, items: page.items.map(withContract) };
    },
    listManagedProductsInCategory: async (
      ...args: Parameters<typeof actual.listManagedProductsInCategory>
    ) => {
      const page = await actual.listManagedProductsInCategory(...args);
      return { ...page, items: page.items.map(withContract) };
    },
  };
});

let testDb: TestDatabase | null = null;
let updateId = 5000;

type Fixture = {
  storeAId: string;
  storeBId: string;
  storeCId: string;
  categoryAId: string;
  categoryBId: string;
  productAId: string;
  productBId: string;
  connectionAId: string;
  connectionBId: string;
  connectionCId: string;
  categoryCId: string;
  languageId: string;
  arabicLanguageId: string;
  userAId: string;
  userBId: string;
  navigationProductIds: string[];
};

let fixture: Fixture;

const BUYER_A = 92001;
const BUYER_B = 92002;
const BUYER_C = 92003;
const NAVIGATION_BOT_ID = 990003;
const NAVIGATION_PRODUCT_COUNT = 10;

beforeAll(async () => {
  if (!shouldRun) return;

  process.env.RABET_COD_ORDERS_ENABLED = "true";
  testDb = await createTestDatabase("cod_telegram_journey");
  const db = testDb.db;

  const [english] = await db
    .insert(language)
    .values({ code: "en", label: "English", isEnabled: true })
    .returning();
  const [arabic] = await db
    .insert(language)
    .values({
      code: "ar",
      label: "العربية",
      textDirection: "rtl",
      isEnabled: true,
    })
    .returning();

  const [storeA] = await db
    .insert(store)
    .values({ name: "Bot COD Store A", slug: "bot-cod-store-a", status: "active" })
    .returning();
  const [storeB] = await db
    .insert(store)
    .values({ name: "Bot COD Store B", slug: "bot-cod-store-b", status: "active" })
    .returning();

  const [userA] = await db
    .insert(appUser)
    .values({ email: "botcod.a@example.test" })
    .returning();
  const [userB] = await db
    .insert(appUser)
    .values({ email: "botcod.b@example.test" })
    .returning();

  await db.insert(storeMembership).values([
    { storeId: storeA.id, userId: userA.id, role: "owner", status: "active" },
    { storeId: storeB.id, userId: userB.id, role: "owner", status: "active" },
  ]);

  const [categoryA] = await db
    .insert(category)
    .values({
      storeId: storeA.id,
      slug: "bot-cod-a-root",
      sortOrder: nextOrder(),
      isActive: true,
    })
    .returning();
  const [categoryB] = await db
    .insert(category)
    .values({
      storeId: storeB.id,
      slug: "bot-cod-b-root",
      sortOrder: nextOrder(),
      isActive: true,
    })
    .returning();

  await db.insert(categoryTranslation).values([
    { categoryId: categoryA.id, languageId: english.id, name: "Bot A Root" },
    { categoryId: categoryA.id, languageId: arabic.id, name: "جذر المتجر أ" },
    { categoryId: categoryB.id, languageId: english.id, name: "Bot B Root" },
  ]);

  const [productA] = await db
    .insert(product)
    .values({
      storeId: storeA.id,
      categoryId: categoryA.id,
      slug: "bot-cod-a-product",
      price: "11.00",
      isActive: true,
      sortOrder: nextOrder(),
    })
    .returning();
  const [productB] = await db
    .insert(product)
    .values({
      storeId: storeB.id,
      categoryId: categoryB.id,
      slug: "bot-cod-b-product",
      price: "30.00",
      isActive: true,
      sortOrder: nextOrder(),
    })
    .returning();

  await db.insert(productTranslation).values([
    {
      productId: productA.id,
      languageId: english.id,
      name: "Bot A One",
      description: "Bot A description",
    },
    {
      productId: productA.id,
      languageId: arabic.id,
      name: "منتج أ واحد",
      description: "وصف المنتج أ",
    },
    {
      productId: productB.id,
      languageId: english.id,
      name: "Bot B One",
      description: "Bot B description",
    },
  ]);

  await db.insert(storeCommerceSetting).values([
    {
      storeId: storeA.id,
      currency: "SAR",
      deliveryFee: "15.00",
      codEnabled: true,
    },
    {
      storeId: storeB.id,
      currency: "USD",
      deliveryFee: "7.00",
      codEnabled: true,
    },
  ]);

  await db.insert(productInventory).values([
    { productId: productA.id, storeId: storeA.id, onHand: 5, reserved: 0 },
    { productId: productB.id, storeId: storeB.id, onHand: 5, reserved: 0 },
  ]);

  const [connectionA] = await db
    .insert(telegramConnection)
    .values({
      storeId: storeA.id,
      botId: 990001,
      botUsername: "BotCodAStoreBot",
      tokenCiphertext: "synthetic-ciphertext",
      tokenKeyId: "v1",
      webhookSecretHash: hashWebhookSecret("bot-secret-a"),
      webhookUrl: "https://app.example.test/api/telegram/webhook/managed/bot-a",
      status: "ready",
      verifiedAt: new Date(),
    })
    .returning();
  const [connectionB] = await db
    .insert(telegramConnection)
    .values({
      storeId: storeB.id,
      botId: 990002,
      botUsername: "BotCodBStoreBot",
      tokenCiphertext: "synthetic-ciphertext",
      tokenKeyId: "v1",
      webhookSecretHash: hashWebhookSecret("bot-secret-b"),
      webhookUrl: "https://app.example.test/api/telegram/webhook/managed/bot-b",
      status: "ready",
      verifiedAt: new Date(),
    })
    .returning();

  // A dedicated store keeps the navigation-context fixtures away from the
  // existing browse, cart and order assertions in this file.
  const [storeC] = await db
    .insert(store)
    .values({ name: "Bot COD Store C", slug: "bot-cod-store-c", status: "active" })
    .returning();
  const [categoryC] = await db
    .insert(category)
    .values({
      storeId: storeC.id,
      slug: "bot-cod-c-root",
      sortOrder: nextOrder(),
      isActive: true,
    })
    .returning();
  await db.insert(categoryTranslation).values({
    categoryId: categoryC.id,
    languageId: english.id,
    name: "Bot C Root",
  });

  const navigationProducts = await db
    .insert(product)
    .values(
      Array.from({ length: NAVIGATION_PRODUCT_COUNT }, (_, index) => ({
        storeId: storeC.id,
        categoryId: categoryC.id,
        slug: `bot-cod-c-navigation-${String(index + 1).padStart(2, "0")}`,
        price: "9.00",
        isActive: true,
        sortOrder: nextOrder(),
      })),
    )
    .returning({ id: product.id });

  await db.insert(productTranslation).values(
    navigationProducts.map((row, index) => ({
      productId: row.id,
      languageId: english.id,
      name: `Nav Item ${String(index + 1).padStart(2, "0")}`,
      description: "Navigation context product",
    })),
  );
  await db.insert(productInventory).values(
    navigationProducts.map((row) => ({
      productId: row.id,
      storeId: storeC.id,
      onHand: 5,
      reserved: 0,
    })),
  );
  await db.insert(storeCommerceSetting).values({
    storeId: storeC.id,
    currency: "EGP",
    deliveryFee: "10.00",
    codEnabled: true,
  });
  const [connectionC] = await db
    .insert(telegramConnection)
    .values({
      storeId: storeC.id,
      botId: NAVIGATION_BOT_ID,
      botUsername: "BotCodCStoreBot",
      tokenCiphertext: "synthetic-ciphertext",
      tokenKeyId: "v1",
      webhookSecretHash: hashWebhookSecret("bot-secret-c"),
      webhookUrl: "https://app.example.test/api/telegram/webhook/managed/bot-c",
      status: "ready",
      verifiedAt: new Date(),
    })
    .returning();

  fixture = {
    storeAId: storeA.id,
    storeBId: storeB.id,
    storeCId: storeC.id,
    categoryAId: categoryA.id,
    categoryBId: categoryB.id,
    productAId: productA.id,
    productBId: productB.id,
    connectionAId: connectionA.id,
    connectionBId: connectionB.id,
    connectionCId: connectionC.id,
    categoryCId: categoryC.id,
    languageId: english.id,
    arabicLanguageId: arabic.id,
    userAId: userA.id,
    userBId: userB.id,
    navigationProductIds: navigationProducts.map((row) => row.id),
  };
});

afterAll(async () => {
  delete process.env.RABET_COD_ORDERS_ENABLED;
  await testDb?.close();
  testDb = null;
});

beforeEach(async () => {
  if (!testDb) return;
  updateId = 5000;
  productContract.clear();
  const db = testDb.db;

  await db.execute(sql`
    truncate table
      "inventory_reservation",
      "order_item",
      "order",
      "cart_item",
      "cart",
      "telegram_active_storefront",
      "telegram_navigation_context",
      "telegram_managed_update"
    restart identity cascade
  `);

  await db.execute(sql`truncate table "buyer_language_preference"`);
  await db.execute(sql`truncate table "store_language_setting"`);
  await db.execute(sql`truncate table "bot_setting"`);
  await db.update(store).set({ telegramSupportUsername: null, storefrontProfile: null });

  await db
    .update(product)
    .set({ price: "11.00", isActive: true, deletedAt: null })
    .where(eq(product.id, fixture.productAId));
  await db
    .update(product)
    .set({ price: "30.00", isActive: true, deletedAt: null })
    .where(eq(product.id, fixture.productBId));

  await db.execute(sql`
    update "product_inventory" set on_hand = 5, reserved = 0
  `);

  await db
    .update(storeCommerceSetting)
    .set({ deliveryFee: "15.00", codEnabled: true })
    .where(eq(storeCommerceSetting.storeId, fixture.storeAId));
});

function db() {
  return testDb!.db;
}

async function activeStorefrontRow(
  buyerId: number,
  connectionId = fixture.connectionAId,
) {
  const [row] = await db()
    .select()
    .from(telegramActiveStorefront)
    .where(
      and(
        eq(telegramActiveStorefront.connectionId, connectionId),
        eq(telegramActiveStorefront.telegramUserId, buyerId),
        eq(telegramActiveStorefront.telegramChatId, buyerId),
      ),
    )
    .limit(1);
  return row;
}

function nextUpdateId(): number {
  updateId += 1;
  return updateId;
}

function webhookRequest(body: unknown, secret = "bot-secret-a"): Request {
  return new Request("https://app.example.test/api/telegram/webhook/managed/x", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-telegram-bot-api-secret-token": secret,
    },
    body: JSON.stringify(body),
  });
}

function messageUpdate(
  buyerId: number,
  text: string,
  extra: Record<string, unknown> = {},
  languageCode?: string,
) {
  return {
    update_id: nextUpdateId(),
    message: {
      message_id: nextUpdateId(),
      from: {
        id: buyerId,
        is_bot: false,
        first_name: "Buyer",
        ...(languageCode ? { language_code: languageCode } : {}),
      },
      chat: { id: buyerId, type: "private" },
      date: 1,
      text,
      ...extra,
    },
  };
}

function contactUpdate(
  buyerId: number,
  phoneNumber: string,
  languageCode?: string,
) {
  return {
    update_id: nextUpdateId(),
    message: {
      message_id: nextUpdateId(),
      from: {
        id: buyerId,
        is_bot: false,
        first_name: "Buyer",
        ...(languageCode ? { language_code: languageCode } : {}),
      },
      chat: { id: buyerId, type: "private" },
      date: 1,
      contact: {
        phone_number: phoneNumber,
        first_name: "Buyer",
        user_id: buyerId,
      },
    },
  };
}

function callbackUpdate(
  buyerId: number,
  data: string,
  languageCode?: string,
  messageId?: number,
  hasPhoto = false,
) {
  return {
    update_id: nextUpdateId(),
    callback_query: {
      id: `callback-${nextUpdateId()}`,
      from: {
        id: buyerId,
        is_bot: false,
        first_name: "Buyer",
        ...(languageCode ? { language_code: languageCode } : {}),
      },
      message: {
        message_id: messageId ?? 7000 + updateId,
        chat: { id: buyerId, type: "private" },
        date: 1,
        ...(hasPhoto
          ? {
              photo: [
                {
                  file_id: "contract-photo-file-id",
                  file_unique_id: "contract-photo-unique-id",
                  width: 800,
                  height: 600,
                },
              ],
            }
          : {}),
      },
      data,
    },
  };
}

async function call(
  connectionId: string,
  body: unknown,
  secret = "bot-secret-a",
  transport: FakeTelegramTransport = createFakeTelegramTransport(),
  options?: { db?: Database },
): Promise<{ status: number; transport: FakeTelegramTransport }> {
  const response = await handleManagedTelegramWebhookRequest(
    webhookRequest(body, secret),
    connectionId,
    {
      db: options?.db ?? asAppDb(db()),
      commerceDb: db() as unknown as TransactionDatabase,
      transport,
    },
  );

  return { status: response.status, transport };
}

/**
 * Fails only navigation-context writes. Catalog reads, update claiming and all
 * other tables keep working, so the surrounding storefront screen can prove it
 * renders without an optional token.
 */
function navigationWriteFailingDb(): Database {
  const real = asAppDb(db());

  return new Proxy(real, {
    get(target, property, receiver) {
      if (property === "insert" || property === "delete") {
        return (table: unknown) => {
          if (table === telegramNavigationContext) {
            throw new Error("navigation context write failed");
          }
          const method = Reflect.get(target, property) as (
            value: unknown,
          ) => unknown;
          return method.call(target, table);
        };
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Database;
}

/**
 * Fails only a select whose source is the navigation-context table. The
 * language, catalog, cart and order reads used by the fallback still work.
 */
function navigationReadFailingDb(): Database {
  const real = asAppDb(db());

  return new Proxy(real, {
    get(target, property, receiver) {
      if (property === "select") {
        return (...args: unknown[]) => {
          const select = Reflect.get(target, property) as (
            ...values: unknown[]
          ) => object;
          const query = select.apply(target, args);

          return new Proxy(query, {
            get(queryTarget, queryProperty, queryReceiver) {
              if (queryProperty === "from") {
                return (table: unknown) => {
                  if (table === telegramNavigationContext) {
                    throw new Error("navigation context read failed");
                  }
                  const from = Reflect.get(queryTarget, queryProperty) as (
                    value: unknown,
                  ) => unknown;
                  return from.call(queryTarget, table);
                };
              }

              const value = Reflect.get(
                queryTarget,
                queryProperty,
                queryReceiver,
              );
              return typeof value === "function"
                ? value.bind(queryTarget)
                : value;
            },
          });
        };
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Database;
}

function inlineButtons(message: {
  replyMarkup?: unknown;
}): Array<{ text: string; callback_data?: string; url?: string }> {
  const markup = message.replyMarkup as
    | {
        inline_keyboard?: Array<
          Array<{ text: string; callback_data?: string; url?: string }>
        >;
      }
    | undefined;

  return markup?.inline_keyboard?.flat() ?? [];
}

function lastButton(
  transport: FakeTelegramTransport,
  prefix: string,
): { text: string; callback_data?: string } | undefined {
  const messages = [...transport.sentMessages, ...transport.editedMessages];
  for (const message of messages.slice().reverse()) {
    const button = inlineButtons(message).find((entry) =>
      entry.callback_data?.startsWith(prefix),
    );
    if (button) return button;
  }
  return undefined;
}

function lastText(transport: FakeTelegramTransport): string {
  return (
    transport.editedMessages.at(-1)?.text ??
    transport.sentMessages.at(-1)?.text ??
    ""
  );
}

function lastScreenMessage(
  transport: FakeTelegramTransport,
): { messageId: number; text: string; replyMarkup?: unknown } | undefined {
  return transport.editedMessages.at(-1) ?? transport.sentMessages.at(-1);
}

function lastReceipt(
  transport: FakeTelegramTransport,
): { text: string; messageId: number } | undefined {
  return [...transport.sentMessages]
    .reverse()
    .find((message) => /placed|تم تسجيل الطلب/.test(message.text));
}

async function setStoreDefault(storeId: string, code: "ar" | "en") {
  await db()
    .insert(storeLanguageSetting)
    .values({ storeId, locale: code })
    .onConflictDoUpdate({
      target: storeLanguageSetting.storeId,
      set: { locale: code, updatedAt: new Date() },
    });
}

async function startProductFlow(
  buyerId = BUYER_A,
  connectionId = fixture.connectionAId,
  secret = "bot-secret-a",
): Promise<FakeTelegramTransport> {
  const start = await call(
    connectionId,
    messageUpdate(buyerId, "/start"),
    secret,
  );
  expect(start.status).toBe(200);

  const product = await call(
    connectionId,
    callbackUpdate(buyerId, `p:${fixture.productAId}`),
    secret,
  );
  expect(product.status).toBe(200);
  return product.transport;
}

async function addAndCheckout(
  buyerId = BUYER_A,
  connectionId = fixture.connectionAId,
  secret = "bot-secret-a",
): Promise<{ cartId: string; transport: FakeTelegramTransport }> {
  const productTransport = await startProductFlow(buyerId, connectionId, secret);
  const productMessage = productTransport.editedMessages.at(-1);
  expect(productMessage?.text).toContain("Bot A One");

  const addUpdate = callbackUpdate(
    buyerId,
    `ca:${fixture.productAId}:2`,
  );
  const added = await call(connectionId, addUpdate, secret);
  expect(added.status).toBe(200);
  expect(lastText(added.transport)).toContain("Subtotal: 22.00 SAR");

  const checkoutButton = lastButton(added.transport, "co:");
  expect(checkoutButton?.callback_data).toBeDefined();
  const checkout = await call(
    connectionId,
    callbackUpdate(buyerId, checkoutButton!.callback_data!),
    secret,
  );
  expect(checkout.status).toBe(200);
  expect(
    checkout.transport.sentMessages.some((message) =>
      message.text.includes("Send your phone number"),
    ),
  ).toBe(true);

  const cartId = checkoutButton!.callback_data!.slice(3);
  return { cartId, transport: checkout.transport };
}

async function completeReview(
  buyerId = BUYER_A,
  connectionId = fixture.connectionAId,
  secret = "bot-secret-a",
): Promise<{
  cartId: string;
  confirmData: string;
  transport: FakeTelegramTransport;
}> {
  const { cartId } = await addAndCheckout(buyerId, connectionId, secret);

  const phone = await call(
    connectionId,
    contactUpdate(buyerId, "+15551234567"),
    secret,
  );
  expect(phone.status).toBe(200);
  expect(
    phone.transport.sentMessages.some((message) =>
      message.text.includes("delivery address"),
    ),
  ).toBe(true);

  const reviewed = await call(
    connectionId,
    messageUpdate(buyerId, "123 Synthetic Telegram Street"),
    secret,
  );
  expect(reviewed.status).toBe(200);
  const reviewMessage = lastScreenMessage(reviewed.transport);
  expect(reviewMessage?.text).toContain("Review your order");
  expect(reviewMessage?.text).toContain("Subtotal: 22.00 SAR");
  expect(reviewMessage?.text).toContain("Delivery fee: 15.00 SAR");
  expect(reviewMessage?.text).toContain("Total: 37.00 SAR");
  expect(reviewMessage?.text).toContain("Payment: Cash on delivery");

  const confirm = inlineButtons(reviewMessage!).find((button) =>
    button.callback_data?.startsWith("cc:"),
  );
  expect(confirm?.callback_data).toBeDefined();

  return {
    cartId,
    confirmData: confirm!.callback_data!,
    transport: reviewed.transport,
  };
}

async function merchantAccessForStoreA(): Promise<MerchantAccess> {
  return {
    userId: fixture.userAId,
    email: "botcod.a@example.test",
    sessionVersion: 0,
    role: "owner",
    store: {
      id: fixture.storeAId,
      name: "Bot COD Store A",
      slug: "bot-cod-store-a",
      status: "active",
    },
    scope: await readStoreScopeForFixture(db(), fixture.storeAId),
    readOnly: false,
  };
}

describe.skipIf(!shouldRun)("COD managed Telegram journey", () => {
  it("shows a saved welcome cover only in its own storefront and falls back to text", async () => {
    const access = await merchantAccessForStoreA();
    const profile = {
      ...EMPTY_STOREFRONT_PROFILE,
      displayName: "Noor Store",
      welcome: "Welcome to the new collection",
      description: "Handmade goods",
      logoUrl: "https://cdn.example.test/logo.png",
      coverUrl: "https://cdn.example.test/cover.jpg",
    };
    await expect(saveStorefrontProfile(db() as unknown as TransactionDatabase, {
      ...access,
      scope: await readStoreScopeForFixture(db(), fixture.storeBId),
    }, profile)).resolves.toBe(false);
    await expect(saveStorefrontProfile(db() as unknown as TransactionDatabase, access, profile))
      .resolves.toBe(true);

    const home = await call(fixture.connectionAId, messageUpdate(BUYER_A, "/start", {}, "en"));
    expect(home.status).toBe(200);
    expect(home.transport.sentPhotos[0]).toMatchObject({
      photo: profile.coverUrl,
      caption: expect.stringContaining("Noor Store\n\nWelcome to the new collection"),
    });
    expect(home.transport.sentMessages).toHaveLength(0);

    const returned = await call(fixture.connectionAId,
      callbackUpdate(BUYER_A, "home", "en", 7001, true));
    expect(returned.transport.editedMedia.at(-1)).toMatchObject({ messageId: 7001 });
    expect(returned.transport.sentPhotos).toHaveLength(0);

    const unavailable = createFakeTelegramTransport();
    unavailable.failPhotoWith = "Bad Request: cannot read photo";
    unavailable.failMediaWith = "Bad Request: cannot read photo";
    const fallback = await call(fixture.connectionAId,
      messageUpdate(BUYER_A, "/start", {}, "en"), "bot-secret-a", unavailable);
    expect(fallback.status).toBe(200);
    expect(lastText(fallback.transport)).toContain(profile.welcome);

    const other = await call(fixture.connectionBId, messageUpdate(BUYER_B, "/start", {}, "en"),
      "bot-secret-b");
    expect(other.status).toBe(200);
    expect(other.transport.sentPhotos).toHaveLength(0);
    expect(lastText(other.transport)).toContain("Bot COD Store B");
    expect(lastText(other.transport)).not.toContain(profile.welcome);
  });

  it("renders distinct browse, purchase and removal actions", async () => {
    const home = await call(fixture.connectionAId, messageUpdate(BUYER_A, "/start", {}, "en"));
    const markup = home.transport.sentMessages.at(-1)?.replyMarkup;
    expect(markup && "inline_keyboard" in markup && markup.inline_keyboard[0]).toEqual([
      { text: "Browse products", style: "primary", callback_data: "prods" },
    ]);
    const browse = await call(fixture.connectionAId, callbackUpdate(BUYER_A, "prods", "en", 7001));
    expect(browse.transport.editedMessages.at(-1)).toMatchObject({ messageId: 7001 });
    expect(browse.transport.sentMessages).toHaveLength(0);

    const card = await call(fixture.connectionAId, callbackUpdate(BUYER_A, `p:${fixture.productAId}`, "en"));
    expect(lastButton(card.transport, "ca:")).toMatchObject({ style: "success" });
    const added = await call(fixture.connectionAId, callbackUpdate(BUYER_A, `ca:${fixture.productAId}:1`, "en"));
    expect(lastButton(added.transport, "cr:")).toMatchObject({ style: "danger" });
    expect(lastButton(added.transport, "co:")).toMatchObject({ style: "primary" });
  });

  it("accepts a private reply to this bot's catalog search prompt and handles empty results", async () => {
    const search = await call(fixture.connectionAId, callbackUpdate(BUYER_A, "catalog-search", "en"));
    expect(search.status).toBe(200);
    const prompt = search.transport.sentMessages.at(-1)!;
    expect(prompt.replyMarkup).toEqual({ force_reply: true });
    const reply = {
      message_id: prompt.messageId,
      from: { id: 990001, is_bot: true },
      chat: { id: BUYER_A, type: "private" },
      text: prompt.text,
    };
    const find = (text: string, extra = {}) => call(
      fixture.connectionAId,
      messageUpdate(BUYER_A, text, { reply_to_message: reply, ...extra }, "en"),
    );

    const result = await find("bot a description");
    expect(result.status).toBe(200);
    expect(lastText(result.transport)).toContain("Product search results");
    expect(
      lastButton(result.transport, "p:")?.callback_data?.startsWith(
        `p:${fixture.productAId}`,
      ),
    ).toBe(true);
    expect(lastButton(result.transport, "prods")?.callback_data).toBe("prods");

    const resultMessage = lastScreenMessage(result.transport)!;
    const pageUpdate = callbackUpdate(BUYER_A, "catalog-search:1", "en", resultMessage.messageId);
    const page = await call(fixture.connectionAId, {
      ...pageUpdate,
      callback_query: {
        ...pageUpdate.callback_query,
        message: {
          ...pageUpdate.callback_query.message,
          from: reply.from,
          text: resultMessage.text,
        },
      },
    });
    expect(page.status).toBe(200);
    expect(page.transport.sentMessages).toHaveLength(0);
    expect(page.transport.editedMessages.at(-1)).toMatchObject({
      messageId: resultMessage.messageId,
      text: resultMessage.text,
    });

    const empty = await find("Bot B One");
    expect(lastText(empty.transport)).toContain("No products matched");
    expect(lastButton(empty.transport, "p:")).toBeUndefined();

    const invalid = await find("x".repeat(81));
    expect(invalid.transport.sentMessages.at(-1)?.replyMarkup).toEqual({ force_reply: true });
    expect(lastText(invalid.transport)).toContain("up to 80 characters");

    const unrelated = await find("bot a description", {
      reply_to_message: { ...reply, from: { id: 990002, is_bot: true } },
    });
    expect(lastText(unrelated.transport)).not.toContain("Product search results");
  });

  it("keeps catalog browsing unchanged when the COD gate is off", async () => {
    const previous = process.env.RABET_COD_ORDERS_ENABLED;

    try {
      process.env.RABET_COD_ORDERS_ENABLED = "false";

      const start = await call(
        fixture.connectionAId,
        messageUpdate(BUYER_A, "/start"),
      );
      expect(start.status).toBe(200);
      expect(lastText(start.transport)).not.toContain("Cart");

      const product = await call(
        fixture.connectionAId,
        callbackUpdate(BUYER_A, `p:${fixture.productAId}`),
      );
      expect(product.status).toBe(200);
      const productText = product.transport.editedMessages.at(-1)?.text ?? "";
      expect(productText).toContain("Bot A One");
      expect(productText).not.toContain("Add 1");
      expect(
        inlineButtons(product.transport.editedMessages.at(-1)!).some((button) =>
          button.callback_data?.startsWith("ca:"),
        ),
      ).toBe(false);
      expect(await db().select().from(cart)).toHaveLength(0);
    } finally {
      if (previous === undefined) {
        delete process.env.RABET_COD_ORDERS_ENABLED;
      } else {
        process.env.RABET_COD_ORDERS_ENABLED = previous;
      }
    }
  });

  it("renders the contract image product with price, currency and availability", async () => {
    productContract.set(fixture.productAId, {
      imageUrl: "https://cdn.example.test/products/bot-a.jpg",
      availability: { available: 2, inStock: true },
    });

    const start = await call(
      fixture.connectionAId,
      messageUpdate(BUYER_A, "/start"),
    );
    expect(start.status).toBe(200);
    const homeMessage = start.transport.sentMessages.at(-1)!;

    const product = await call(
      fixture.connectionAId,
      callbackUpdate(
        BUYER_A,
        `p:${fixture.productAId}`,
        undefined,
        homeMessage.messageId,
      ),
    );
    expect(product.status).toBe(200);

    expect(product.transport.sentPhotos).toHaveLength(1);
    const photo = product.transport.sentPhotos[0];
    expect(photo.photo).toBe("https://cdn.example.test/products/bot-a.jpg");
    expect(photo.caption).toContain("Bot A One");
    expect(photo.caption).toContain("Bot A description");
    expect(photo.caption).toContain("11.00 SAR");
    expect(photo.caption).toContain("In stock");
    expect(photo.caption).not.toContain("out of stock");

    const addButtons = inlineButtons(photo).filter((button) =>
      button.callback_data?.startsWith("ca:"),
    );
    expect(addButtons.map((button) => button.callback_data)).toEqual([
      `ca:${fixture.productAId}:1`,
      `ca:${fixture.productAId}:2`,
    ]);

    // Text -> photo needs a replacement. The superseded text controls are
    // retired instead of creating competing active storefronts.
    expect(
      product.transport.editedReplyMarkups.some(
        (entry) =>
          entry.messageId === homeMessage.messageId &&
          entry.replyMarkup?.inline_keyboard.length === 0,
      ),
    ).toBe(true);
    expect(product.transport.sentMessages).toHaveLength(0);
    expect(product.transport.editedMessages).toHaveLength(0);
  });

  it("keeps a usable text-only product card when the contract has no image", async () => {
    const start = await call(
      fixture.connectionAId,
      messageUpdate(BUYER_A, "/start"),
    );
    const homeMessage = start.transport.sentMessages.at(-1)!;

    const product = await call(
      fixture.connectionAId,
      callbackUpdate(
        BUYER_A,
        `p:${fixture.productAId}`,
        undefined,
        homeMessage.messageId,
      ),
    );
    expect(product.status).toBe(200);

    expect(product.transport.sentPhotos).toHaveLength(0);
    expect(product.transport.photoAttempts).toHaveLength(0);
    expect(product.transport.editedMessages).toHaveLength(1);

    const card = product.transport.editedMessages[0];
    expect(card.messageId).toBe(homeMessage.messageId);
    expect(card.text).toContain("Bot A One");
    expect(card.text).toContain("Bot A description");
    expect(card.text).toContain("11.00 SAR");
    expect(card.text).toContain("In stock");
    expect(
      inlineButtons(card).some((button) =>
        button.callback_data?.startsWith("ca:"),
      ),
    ).toBe(true);
  });

  it("uses contract availability and refuses add-to-cart for an out-of-stock product", async () => {
    // The database still has stock; the shared reader is authoritative.
    productContract.set(fixture.productAId, {
      availability: { available: 0, inStock: false },
    });

    const start = await call(
      fixture.connectionAId,
      messageUpdate(BUYER_A, "/start"),
    );
    const homeMessage = start.transport.sentMessages.at(-1)!;

    const product = await call(
      fixture.connectionAId,
      callbackUpdate(
        BUYER_A,
        `p:${fixture.productAId}`,
        undefined,
        homeMessage.messageId,
      ),
    );
    expect(product.status).toBe(200);

    const card = product.transport.editedMessages.at(-1)!;
    expect(card.text).toContain("out of stock");
    expect(
      inlineButtons(card).some((button) =>
        button.callback_data?.startsWith("ca:"),
      ),
    ).toBe(false);

    // Empty the store's inventory to prove the cart boundary rejects a stale
    // or forged add for a genuinely out-of-stock product.
    await db().execute(sql`
      update "product_inventory" set on_hand = 0, reserved = 0
      where product_id = ${fixture.productAId}
    `);

    const rejected = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER_A, `ca:${fixture.productAId}:1`),
    );
    expect(rejected.status).toBe(200);
    expect(lastText(rejected.transport)).toContain("out of stock");
    expect(await db().select().from(cart)).toHaveLength(0);
    expect(await db().select().from(order)).toHaveLength(0);
  });

  it("falls back to the text card when a photo outcome is ambiguous without a blind resend", async () => {
    productContract.set(fixture.productAId, {
      imageUrl: "https://cdn.example.test/products/bot-a.jpg",
      availability: { available: 3, inStock: true },
    });

    const start = await call(
      fixture.connectionAId,
      messageUpdate(BUYER_A, "/start"),
    );
    const homeMessage = start.transport.sentMessages.at(-1)!;

    const transport = createFakeTelegramTransport();
    transport.failPhotoWith = "Request timed out";
    transport.failPhotoKind = "timeout";

    const product = await call(
      fixture.connectionAId,
      callbackUpdate(
        BUYER_A,
        `p:${fixture.productAId}`,
        undefined,
        homeMessage.messageId,
      ),
      "bot-secret-a",
      transport,
    );
    expect(product.status).toBe(200);

    // Exactly one photo attempt; the unknown outcome is never retried with a
    // second send. The known text message becomes the usable card.
    expect(product.transport.photoAttempts).toHaveLength(1);
    expect(product.transport.photoAttempts[0].ok).toBe(false);
    expect(product.transport.sentPhotos).toHaveLength(0);
    expect(product.transport.sentMessages).toHaveLength(0);

    const fallback = product.transport.editedMessages.at(-1)!;
    expect(fallback.messageId).toBe(homeMessage.messageId);
    expect(fallback.text).toContain("Bot A One");
    expect(fallback.text).toContain("11.00 SAR");
    expect(fallback.text).toContain("In stock");
    expect(
      inlineButtons(fallback).some((button) =>
        button.callback_data?.startsWith("ca:"),
      ),
    ).toBe(true);
  });

  it("edits an existing photo product message in place instead of sending again", async () => {
    productContract.set(fixture.productAId, {
      imageUrl: "https://cdn.example.test/products/bot-a.jpg",
      availability: { available: 4, inStock: true },
    });

    const start = await call(
      fixture.connectionAId,
      messageUpdate(BUYER_A, "/start"),
    );
    const homeMessage = start.transport.sentMessages.at(-1)!;

    const first = await call(
      fixture.connectionAId,
      callbackUpdate(
        BUYER_A,
        `p:${fixture.productAId}`,
        undefined,
        homeMessage.messageId,
      ),
    );
    const photoMessage = first.transport.sentPhotos[0];
    expect(photoMessage).toBeDefined();

    const refreshed = await call(
      fixture.connectionAId,
      callbackUpdate(
        BUYER_A,
        `p:${fixture.productAId}`,
        undefined,
        photoMessage.messageId,
        true,
      ),
      "bot-secret-a",
      first.transport,
    );
    expect(refreshed.status).toBe(200);

    expect(refreshed.transport.sentPhotos).toHaveLength(1);
    expect(refreshed.transport.editedMedia).toHaveLength(1);
    expect(refreshed.transport.editedMedia[0].messageId).toBe(
      photoMessage.messageId,
    );
    expect(refreshed.transport.editedMedia[0].media.media).toBe(
      "https://cdn.example.test/products/bot-a.jpg",
    );
    expect(refreshed.transport.editedMedia[0].media.caption).toContain(
      "Bot A One",
    );
  });

  it("replaces a photo product message with one text screen when text editing is unsupported", async () => {
    productContract.set(fixture.productAId, {
      imageUrl: "https://cdn.example.test/products/bot-a.jpg",
      availability: { available: 4, inStock: true },
    });

    const start = await call(
      fixture.connectionAId,
      messageUpdate(BUYER_A, "/start"),
    );
    const homeMessage = start.transport.sentMessages.at(-1)!;

    const first = await call(
      fixture.connectionAId,
      callbackUpdate(
        BUYER_A,
        `p:${fixture.productAId}`,
        undefined,
        homeMessage.messageId,
      ),
    );
    const photoMessage = first.transport.sentPhotos[0];

    first.transport.failEditWith =
      "Bad Request: There is no text in the message to edit";
    first.transport.failEditKind = "not_editable";

    const cartView = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER_A, "cart", undefined, photoMessage.messageId, true),
      "bot-secret-a",
      first.transport,
    );
    expect(cartView.status).toBe(200);

    expect(cartView.transport.sentMessages).toHaveLength(1);
    expect(cartView.transport.sentMessages[0].text).toContain(
      "Your cart is empty",
    );
    expect(
      cartView.transport.editedReplyMarkups.some(
        (entry) =>
          entry.messageId === photoMessage.messageId &&
          entry.replyMarkup?.inline_keyboard.length === 0,
      ),
    ).toBe(true);
  });

  it("places one COD order from product to contact, address, review and confirmation", async () => {
    const { cartId, confirmData } = await completeReview();

    const confirmed = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER_A, confirmData),
    );

    expect(confirmed.status).toBe(200);

    const receipt = lastReceipt(confirmed.transport);
    expect(receipt).toBeDefined();
    const receiptText = receipt!.text;
    expect(receiptText).toContain("placed");
    expect(receiptText).toContain("awaiting collection");
    expect(receiptText).toContain("Total: 37.00 SAR");

    const reference = /Order (ORD-[A-HJ-NP-Z2-9]{6}) placed/.exec(
      receiptText,
    )?.[1];
    expect(reference).toBeDefined();

    // The active storefront message is deliberately not the receipt.
    const bridge = confirmed.transport.editedMessages.at(-1)!;
    expect(bridge.text).toContain(`Order ${reference} placed`);
    expect(bridge.text).not.toContain("Subtotal:");

    const orders = await db().select().from(order);
    expect(orders).toHaveLength(1);
    expect(orders[0].reference).toBe(reference);
    expect(orders[0].paymentStatus).toBe("awaiting_collection");

    const reservations = await db().select().from(inventoryReservation);
    expect(reservations).toHaveLength(1);
    expect(reservations[0].quantity).toBe(2);

    const [inventory] = await db()
      .select()
      .from(productInventory)
      .where(eq(productInventory.productId, fixture.productAId));
    expect(inventory.reserved).toBe(2);
    expect(inventory.onHand).toBe(5);

    // A second tap is a separate Telegram update. It must return the same
    // reference, edit only, and must not reserve stock or send a receipt again.
    const duplicate = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER_A, confirmData),
      "bot-secret-a",
      confirmed.transport,
    );
    expect(duplicate.status).toBe(200);
    expect(lastText(duplicate.transport)).toContain(`Order ${reference} placed`);
    expect(lastText(duplicate.transport)).toContain("Total: 37.00 SAR");
    expect(
      duplicate.transport.sentMessages.filter((message) =>
        message.text.includes(`Order ${reference} placed`),
      ),
    ).toHaveLength(1);

    expect(await db().select().from(order)).toHaveLength(1);
    expect(await db().select().from(inventoryReservation)).toHaveLength(1);

    const [after] = await db()
      .select()
      .from(productInventory)
      .where(eq(productInventory.productId, fixture.productAId));
    expect(after.reserved).toBe(2);

    const [cartRow] = await db()
      .select()
      .from(cart)
      .where(eq(cart.id, cartId));
    expect(cartRow.status).toBe("converted");
  });

  it.each([
    ["add", 0, 1, 2],
    ["increase", 2, 3, 4],
    ["decrease", 2, 1, 0],
    ["remove", 2, 0, 1],
  ] as const)(
    "applies a cart %s once when the same Telegram update is retried after a rendering failure",
    async (action, initialQuantity, afterFirst, afterDistinct) => {
      const productId = fixture.productAId;
      const add = tokens.cartAdd(productId, 1);
      const data = {
        add,
        increase: tokens.cartIncrease(productId),
        decrease: tokens.cartDecrease(productId),
        remove: tokens.cartRemove(productId),
      }[action];
      if (initialQuantity) {
        const seed = await call(
          fixture.connectionAId,
          callbackUpdate(BUYER_A, tokens.cartAdd(productId, initialQuantity)),
        );
        expect(seed.status).toBe(200);
      }

      const quantity = async () => {
        const [item] = await db().select().from(cartItem);
        return item?.quantity ?? 0;
      };
      const transport = createFakeTelegramTransport();
      const hasPhoto = action === "add";
      transport.failEditWith = hasPhoto ? "No text in message" : "Edit failed";
      transport.failEditKind = hasPhoto ? "not_editable" : "api_error";
      transport.failSendWith = "Replacement failed";
      const update = callbackUpdate(BUYER_A, data, "en", undefined, hasPhoto);

      const failed = await call(fixture.connectionAId, update, "bot-secret-a", transport);
      expect(failed.status).toBe(500);
      expect(await quantity()).toBe(afterFirst);
      const [cartAfterFirst] = await db().select().from(cart);

      const retryTransport = createFakeTelegramTransport();
      if (hasPhoto) {
        retryTransport.failEditWith = "No text in message";
        retryTransport.failEditKind = "not_editable";
      }
      const retried = await call(fixture.connectionAId, update, "bot-secret-a", retryTransport);
      expect(retried.status).toBe(200);
      expect(await quantity()).toBe(afterFirst);
      expect(await db().select().from(cart)).toEqual([cartAfterFirst]);
      expect(lastText(retried.transport)).toContain(
        afterFirst ? `Bot A One × ${afterFirst}` : "Your cart is empty",
      );

      const distinct = await call(
        fixture.connectionAId,
        callbackUpdate(BUYER_A, action === "remove" ? add : data),
      );
      expect(distinct.status).toBe(200);
      expect(await quantity()).toBe(afterDistinct);
    },
  );

  it("returns a revised review instead of placing an order when the quote changed", async () => {
    const { confirmData } = await completeReview();

    await db()
      .update(product)
      .set({ price: "13.50" })
      .where(eq(product.id, fixture.productAId));
    await db()
      .update(storeCommerceSetting)
      .set({ deliveryFee: "17.00" })
      .where(eq(storeCommerceSetting.storeId, fixture.storeAId));

    const stale = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER_A, confirmData),
    );

    expect(stale.status).toBe(200);
    const revised = lastText(stale.transport);
    expect(revised).toContain("Review your order");
    expect(revised).toContain("Subtotal: 27.00 SAR");
    expect(revised).toContain("Delivery fee: 17.00 SAR");
    expect(revised).toContain("Total: 44.00 SAR");
    expect(await db().select().from(order)).toHaveLength(0);
    expect(await db().select().from(inventoryReservation)).toHaveLength(0);

    const confirm = inlineButtons(
      stale.transport.editedMessages.at(-1)!,
    ).find((button) => button.callback_data?.startsWith("cc:"));
    expect(confirm?.callback_data).toBeDefined();
    expect(confirm!.callback_data).not.toBe(confirmData);

    const placed = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER_A, confirm!.callback_data!),
    );
    expect(placed.status).toBe(200);
    expect(lastText(placed.transport)).toContain("placed");
    expect(lastReceipt(placed.transport)?.text).toContain("Total: 44.00 SAR");
    expect(await db().select().from(order)).toHaveLength(1);
  });

  it("does not let another buyer in the same store confirm the cart", async () => {
    const { confirmData } = await completeReview();

    const foreign = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER_B, confirmData),
    );
    expect(foreign.status).toBe(200);
    expect(lastText(foreign.transport)).toContain("This cart is not available");
    expect(await db().select().from(order)).toHaveLength(0);

    const own = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER_A, confirmData),
    );
    expect(own.status).toBe(200);
    expect(lastText(own.transport)).toContain("placed");
    expect(await db().select().from(order)).toHaveLength(1);
  });

  it("does not let the other store confirm or order the cart", async () => {
    const { confirmData } = await completeReview();

    const foreign = await call(
      fixture.connectionBId,
      callbackUpdate(BUYER_B, confirmData),
      "bot-secret-b",
    );
    expect(foreign.status).toBe(200);
    expect(lastText(foreign.transport)).toContain("This cart is not available");
    expect(await db().select().from(order)).toHaveLength(0);

    const foreignProduct = await call(
      fixture.connectionBId,
      callbackUpdate(BUYER_B, `ca:${fixture.productAId}:1`),
      "bot-secret-b",
    );
    expect(foreignProduct.status).toBe(200);
    expect(lastText(foreignProduct.transport)).toContain(
      "not available in this store",
    );

    const own = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER_A, confirmData),
    );
    expect(own.status).toBe(200);
    expect(lastText(own.transport)).toContain("placed");
    expect(await db().select().from(order)).toHaveLength(1);
  });

  it("localizes the Arabic COD flow and normalizes Arabic-Indic phone digits", async () => {
    const start = await call(
      fixture.connectionAId,
      messageUpdate(BUYER_A, "/start", {}, "ar"),
    );
    expect(start.status).toBe(200);
    expect(
      inlineButtons(start.transport.sentMessages.at(-1)!).some(
        (button) => button.text === "السلة",
      ),
    ).toBe(true);

    const product = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER_A, `p:${fixture.productAId}`, "ar"),
    );
    expect(product.status).toBe(200);
    expect(
      inlineButtons(product.transport.editedMessages.at(-1)!).some(
        (button) => button.text === "أضف 1",
      ),
    ).toBe(true);

    const added = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER_A, `ca:${fixture.productAId}:2`, "ar"),
    );
    expect(added.status).toBe(200);
    expect(lastText(added.transport)).toContain("السلة");
    expect(lastText(added.transport)).toContain("المجموع الفرعي: 22.00 SAR");
    expect(lastText(added.transport)).toContain("رسوم التوصيل: 15.00 SAR");
    expect(lastText(added.transport)).toContain("الإجمالي: 37.00 SAR");
    expect(lastText(added.transport)).toContain("الدفع عند الاستلام");
    const checkoutButton = lastButton(added.transport, "co:");
    expect(checkoutButton?.text).toBe("إتمام الطلب");

    const checkout = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER_A, checkoutButton!.callback_data!, "ar"),
    );
    expect(checkout.status).toBe(200);
    const phonePrompt = checkout.transport.sentMessages.at(-1)!;
    expect(phonePrompt.text).toContain("إتمام الطلب");
    expect(phonePrompt.text).toContain("مشاركة الهاتف");
    expect(
      (phonePrompt.replyMarkup as { keyboard?: Array<Array<{ text: string }>> })
        ?.keyboard?.[0]?.[0]?.text,
    ).toBe("مشاركة الهاتف");

    // Typed fallback with Arabic-Indic digits. The stored value is normalized.
    const phone = await call(
      fixture.connectionAId,
      messageUpdate(BUYER_A, "+٩٦٦ ٥٥٥ ١٢٣ ٤٥٦", {}, "ar"),
    );
    expect(phone.status).toBe(200);
    expect(
      phone.transport.sentMessages.some((message) =>
        message.text.includes("عنوان التوصيل"),
      ),
    ).toBe(true);

    const reviewed = await call(
      fixture.connectionAId,
      messageUpdate(BUYER_A, "١٢٣ شارع الاختبار الاصطناعي", {}, "ar"),
    );
    expect(reviewed.status).toBe(200);
    const reviewMessage = lastScreenMessage(reviewed.transport);
    expect(reviewMessage?.text).toContain("راجع طلبك");
    expect(reviewMessage?.text).toContain("المجموع الفرعي: 22.00 SAR");
    expect(reviewMessage?.text).toContain("الدفع عند الاستلام");
    expect(reviewMessage?.text).toContain("+966555123456");
    const confirm = inlineButtons(reviewMessage!).find((button) =>
      button.callback_data?.startsWith("cc:"),
    );
    expect(confirm?.text).toBe("تأكيد الطلب — الدفع عند الاستلام");

    const confirmed = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER_A, confirm!.callback_data!, "ar"),
    );
    expect(confirmed.status).toBe(200);
    expect(lastText(confirmed.transport)).toContain("تم تسجيل الطلب");
    expect(lastReceipt(confirmed.transport)?.text).toContain(
      "بانتظار التحصيل",
    );
    expect(lastReceipt(confirmed.transport)?.text).toContain("37.00 SAR");

    const [orderRow] = await db().select().from(order);
    expect(orderRow.customerPhone).toBe("+966555123456");
    expect(orderRow.deliveryAddress).toBe("١٢٣ شارع الاختبار الاصطناعي");
    expect(orderRow.paymentStatus).toBe("awaiting_collection");
  });

  it("re-asks for a valid address and refuses confirmation before checkout is complete", async () => {
    const { cartId } = await addAndCheckout();

    const phone = await call(
      fixture.connectionAId,
      messageUpdate(BUYER_A, "+15551234567"),
    );
    expect(phone.status).toBe(200);

    const forged = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER_A, `cc:${cartId}:1`),
    );
    expect(forged.status).toBe(200);
    expect(await db().select().from(order)).toHaveLength(0);

    const invalid = await call(
      fixture.connectionAId,
      messageUpdate(BUYER_A, "no"),
    );
    expect(invalid.status).toBe(200);
    expect(
      invalid.transport.sentMessages.some((message) =>
        message.text.includes("That address is invalid"),
      ),
    ).toBe(true);
    expect(await db().select().from(order)).toHaveLength(0);

    const valid = await call(
      fixture.connectionAId,
      messageUpdate(BUYER_A, "123 Synthetic Telegram Street"),
    );
    expect(valid.status).toBe(200);
    expect(lastText(valid.transport)).toContain("Review your order");
    expect(await db().select().from(order)).toHaveLength(0);
  });

  it("resolves a buyer choice per store and keeps the merchant default for another buyer", async () => {
    await setStoreDefault(fixture.storeAId, "ar");
    await setStoreDefault(fixture.storeBId, "en");

    const buyer = 92003;

    const startA = await call(
      fixture.connectionAId,
      messageUpdate(buyer, "/start", {}, "en"),
    );
    expect(lastText(startA.transport)).toContain("مرحبًا بك");

    const otherBuyer = await call(
      fixture.connectionAId,
      messageUpdate(BUYER_B, "/start", {}, "en"),
    );
    expect(lastText(otherBuyer.transport)).toContain("مرحبًا بك");

    const menu = await call(
      fixture.connectionAId,
      callbackUpdate(buyer, "langs"),
    );
    expect(lastText(menu.transport)).toContain("اختر اللغة");

    const chosen = await call(
      fixture.connectionAId,
      callbackUpdate(buyer, "lang:en", "ar"),
    );
    expect(lastText(chosen.transport)).toContain("Welcome to");

    const resumed = await call(
      fixture.connectionAId,
      messageUpdate(buyer, "/start", {}, "ar"),
    );
    expect(lastText(resumed.transport)).toContain("Welcome to");

    const storeBStart = await call(
      fixture.connectionBId,
      messageUpdate(buyer, "/start", {}, "ar"),
      "bot-secret-b",
    );
    expect(lastText(storeBStart.transport)).toContain("Welcome to");

    const preferences = await db().select().from(buyerLanguagePreference);
    expect(preferences).toHaveLength(1);
    expect(preferences[0].storeId).toBe(fixture.storeAId);
    expect(preferences[0].telegramUserId).toBe(buyer);

    const resolvedA = await resolveBuyerLanguage(asAppDb(db()), {
      storeId: fixture.storeAId,
      telegramUserId: buyer,
      profileLanguageCode: "ar",
    });
    expect(resolvedA.source).toBe("buyer");
    expect(resolvedA.locale).toBe("en");

    const resolvedB = await resolveBuyerLanguage(asAppDb(db()), {
      storeId: fixture.storeBId,
      telegramUserId: buyer,
      profileLanguageCode: "ar",
    });
    expect(resolvedB.source).toBe("store_default");
    expect(resolvedB.locale).toBe("en");
  });

  it("keeps merchant catalog text stable while buyer UI and checkout language change", async () => {
    await db().insert(botSetting).values({
      id: 1,
      storeId: fixture.storeAId,
      defaultLanguageId: fixture.arabicLanguageId,
      currency: "SAR",
      displayName: "Bot COD Store A",
    });
    await setStoreDefault(fixture.storeAId, "ar");
    const buyer = 92004;

    await call(
      fixture.connectionAId,
      messageUpdate(buyer, "/start", {}, "en"),
    );

    const categoryArabic = await call(
      fixture.connectionAId,
      callbackUpdate(buyer, `sc:${fixture.categoryAId}`, "en"),
    );
    expect(lastText(categoryArabic.transport)).toContain("جذر المتجر أ");

    const product = await call(
      fixture.connectionAId,
      callbackUpdate(buyer, `p:${fixture.productAId}`, "en"),
    );
    expect(lastText(product.transport)).toContain("منتج أ واحد");
    expect(lastText(product.transport)).toContain("وصف المنتج أ");

    const productLanguageButton = lastButton(product.transport, "langs:");
    expect(productLanguageButton?.callback_data).toBeDefined();

    const productMenu = await call(
      fixture.connectionAId,
      callbackUpdate(buyer, productLanguageButton!.callback_data!),
    );
    expect(lastText(productMenu.transport)).toContain("اختر اللغة");

    const englishChoice = inlineButtons(
      productMenu.transport.editedMessages.at(-1)!,
    ).find((button) => button.callback_data?.startsWith("lang:en"));
    expect(englishChoice?.callback_data).toBeDefined();

    const productEnglish = await call(
      fixture.connectionAId,
      callbackUpdate(buyer, englishChoice!.callback_data!),
    );
    expect(lastText(productEnglish.transport)).toContain("منتج أ واحد");
    expect(lastText(productEnglish.transport)).toContain("وصف المنتج أ");
    expect(
      inlineButtons(productEnglish.transport.editedMessages.at(-1)!).some(
        (button) => button.text === "Add 1",
      ),
    ).toBe(true);

    const categoryEnglishUi = await call(
      fixture.connectionAId,
      callbackUpdate(buyer, `sc:${fixture.categoryAId}`, "en"),
    );
    expect(lastText(categoryEnglishUi.transport)).toContain("جذر المتجر أ");
    expect(
      inlineButtons(categoryEnglishUi.transport.editedMessages.at(-1)!).some(
        (button) => button.text === "Home",
      ),
    ).toBe(true);

    const productArabicLanguageButton = lastButton(
      productEnglish.transport,
      "langs:",
    );
    expect(productArabicLanguageButton?.callback_data).toBeDefined();

    const productArabic = await call(
      fixture.connectionAId,
      callbackUpdate(buyer, productArabicLanguageButton!.callback_data!),
    );
    expect(lastText(productArabic.transport)).toContain("Choose your language");

    const arabicChoice = inlineButtons(
      productArabic.transport.editedMessages.at(-1)!,
    ).find((button) => button.callback_data?.startsWith("lang:ar"));
    expect(arabicChoice?.callback_data).toBeDefined();

    const productBackToArabic = await call(
      fixture.connectionAId,
      callbackUpdate(buyer, arabicChoice!.callback_data!),
    );
    expect(lastText(productBackToArabic.transport)).toContain("منتج أ واحد");
    expect(lastText(productBackToArabic.transport)).toContain("وصف المنتج أ");

    const added = await call(
      fixture.connectionAId,
      callbackUpdate(buyer, `ca:${fixture.productAId}:2`, "en"),
    );
    expect(lastText(added.transport)).toContain("منتج أ واحد");
    expect(lastText(added.transport)).toContain("× 2");

    const cartMenu = await call(
      fixture.connectionAId,
      callbackUpdate(buyer, "langs"),
    );
    expect(lastText(cartMenu.transport)).toContain("اختر اللغة");

    const cartEnglish = await call(
      fixture.connectionAId,
      callbackUpdate(buyer, "lang:en"),
    );
    expect(lastText(cartEnglish.transport)).toContain("Cart");
    expect(lastText(cartEnglish.transport)).toContain("منتج أ واحد");
    expect(lastText(cartEnglish.transport)).toContain("× 2");
    expect(lastText(cartEnglish.transport)).toContain("Subtotal: 22.00 SAR");

    const checkoutButton = lastButton(cartEnglish.transport, "co:");
    expect(checkoutButton?.text).toBe("Checkout");

    const checkout = await call(
      fixture.connectionAId,
      callbackUpdate(buyer, checkoutButton!.callback_data!),
    );
    expect(
      checkout.transport.sentMessages.some((entry) =>
        entry.text.includes("Send your phone number"),
      ),
    ).toBe(true);

    const phoneMenu = await call(
      fixture.connectionAId,
      messageUpdate(buyer, "اللغة / Language"),
    );
    expect(lastText(phoneMenu.transport)).toContain("Choose your language");

    const phoneArabic = await call(
      fixture.connectionAId,
      callbackUpdate(buyer, "lang:ar"),
    );
    expect(
      phoneArabic.transport.sentMessages.some((entry) =>
        entry.text.includes("أرسل رقم هاتفك"),
      ),
    ).toBe(true);

    const phone = await call(
      fixture.connectionAId,
      contactUpdate(buyer, "+15551234567"),
    );
    expect(
      phone.transport.sentMessages.some((entry) =>
        entry.text.includes("أرسل عنوان التوصيل"),
      ),
    ).toBe(true);

    const reviewed = await call(
      fixture.connectionAId,
      messageUpdate(buyer, "123 Synthetic Telegram Street"),
    );
    const arabicReview = lastText(reviewed.transport);
    expect(arabicReview).toContain("راجع طلبك");
    expect(arabicReview).toContain("منتج أ واحد × 2");
    expect(arabicReview).toContain("+15551234567");
    expect(arabicReview).toContain("123 Synthetic Telegram Street");
    expect(arabicReview).toContain("الإجمالي: 37.00 SAR");

    const reviewMenu = await call(
      fixture.connectionAId,
      callbackUpdate(buyer, "langs"),
    );
    expect(lastText(reviewMenu.transport)).toContain("اختر اللغة");

    const reviewEnglish = await call(
      fixture.connectionAId,
      callbackUpdate(buyer, "lang:en"),
    );
    const englishReview = lastText(reviewEnglish.transport);
    expect(englishReview).toContain("Review your order");
    expect(englishReview).toContain("منتج أ واحد × 2");
    expect(englishReview).toContain("+15551234567");
    expect(englishReview).toContain("123 Synthetic Telegram Street");
    expect(englishReview).toContain("Total: 37.00 SAR");

    const confirmButton = lastButton(reviewEnglish.transport, "cc:");
    expect(confirmButton?.text).toBe("Confirm order — cash on delivery");

    const confirmed = await call(
      fixture.connectionAId,
      callbackUpdate(buyer, confirmButton!.callback_data!),
    );
    expect(lastText(confirmed.transport)).toContain("placed");
    expect(lastReceipt(confirmed.transport)?.text).toContain(
      "Total: 37.00 SAR",
    );

    const orders = await db().select().from(order);
    expect(orders).toHaveLength(1);
    expect(orders[0].customerPhone).toBe("+15551234567");
    expect(orders[0].deliveryAddress).toBe("123 Synthetic Telegram Street");

    const items = await db().select().from(orderItem);
    expect(items).toHaveLength(1);
    expect(items[0].productName).toBe("منتج أ واحد");

    const reservations = await db().select().from(inventoryReservation);
    expect(reservations).toHaveLength(1);
    expect(reservations[0].quantity).toBe(2);

    // Changing the merchant's buyer-facing default must not switch catalog text.
    await setStoreDefault(fixture.storeAId, "en");
    const secondBuyer = 92007;
    const secondStart = await call(
      fixture.connectionAId,
      messageUpdate(secondBuyer, "/start", {}, "en"),
    );
    expect(lastText(secondStart.transport)).toContain("Welcome to");
    const secondProduct = await call(
      fixture.connectionAId,
      callbackUpdate(secondBuyer, `p:${fixture.productAId}`, "en"),
    );
    expect(lastText(secondProduct.transport)).toContain("منتج أ واحد");
    expect(lastText(secondProduct.transport)).toContain("وصف المنتج أ");
  });

  it("offers the saved seller contact as a localized Telegram draft without touching cart state", async () => {
    await db()
      .update(store)
      .set({ telegramSupportUsername: "StoreA_Support" })
      .where(eq(store.id, fixture.storeAId));

    const { cartId } = await addAndCheckout();
    const [cartBefore] = await db().select().from(cart).where(eq(cart.id, cartId));
    const itemsBefore = await db()
      .select()
      .from(cartItem)
      .where(eq(cartItem.cartId, cartId));
    expect(cartBefore.status).toBe("checkout");
    expect(cartBefore.checkoutState).toBe("awaiting_phone");

    const englishProduct = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER_A, `p:${fixture.productAId}`, "en"),
    );
    expect(englishProduct.status).toBe(200);

    const englishButton = inlineButtons(
      englishProduct.transport.editedMessages.at(-1)!,
    ).find((button) => button.text === "Ask the seller on Telegram");
    expect(englishButton?.url).toBeDefined();

    const englishUrl = new URL(englishButton!.url!);
    expect(`${englishUrl.origin}${englishUrl.pathname}`).toBe(
      "https://t.me/StoreA_Support",
    );
    expect(englishUrl.searchParams.get("text")).toBe(
      "Hi, I have a question about Bot A One: ",
    );

    const arabicProduct = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER_A, `p:${fixture.productAId}`, "ar"),
    );
    expect(arabicProduct.status).toBe(200);

    const arabicButton = inlineButtons(
      arabicProduct.transport.editedMessages.at(-1)!,
    ).find((button) => button.text === "اسأل البائع على Telegram");
    expect(arabicButton?.url).toBeDefined();

    const arabicUrl = new URL(arabicButton!.url!);
    expect(`${arabicUrl.origin}${arabicUrl.pathname}`).toBe(
      "https://t.me/StoreA_Support",
    );
    expect(arabicUrl.searchParams.get("text")).toBe(
      "مرحبًا، عندي سؤال عن Bot A One: ",
    );

    const [cartAfter] = await db().select().from(cart).where(eq(cart.id, cartId));
    const itemsAfter = await db()
      .select()
      .from(cartItem)
      .where(eq(cartItem.cartId, cartId));
    expect(cartAfter).toEqual(cartBefore);
    expect(itemsAfter).toEqual(itemsBefore);
    expect(await db().select().from(order)).toHaveLength(0);

    const otherStoreProduct = await call(
      fixture.connectionBId,
      callbackUpdate(BUYER_B, `p:${fixture.productBId}`, "en"),
      "bot-secret-b",
    );
    expect(otherStoreProduct.status).toBe(200);
    expect(
      inlineButtons(otherStoreProduct.transport.editedMessages.at(-1)!).some(
        (button) => button.text === "Ask the seller on Telegram",
      ),
    ).toBe(false);
  });

  it("keeps single-language catalog records visible with a deterministic fallback", async () => {
    await db().insert(botSetting).values({
      id: 1,
      storeId: fixture.storeAId,
      defaultLanguageId: fixture.arabicLanguageId,
      currency: "SAR",
      displayName: "Bot COD Store A",
    });
    await setStoreDefault(fixture.storeAId, "ar");

    const [categoryRow] = await db()
      .insert(category)
      .values({
        storeId: fixture.storeAId,
        slug: "store-a-fallback-root",
        sortOrder: nextOrder(),
        isActive: true,
      })
      .returning();
    await db().insert(categoryTranslation).values({
      categoryId: categoryRow.id,
      languageId: fixture.languageId,
      name: "English Only Category",
    });
    const [productRow] = await db()
      .insert(product)
      .values({
        storeId: fixture.storeAId,
        categoryId: categoryRow.id,
        slug: "store-a-english-only-product",
        price: "9.50",
        isActive: true,
        sortOrder: nextOrder(),
      })
      .returning();
    await db().insert(productTranslation).values({
      productId: productRow.id,
      languageId: fixture.languageId,
      name: "English Only Product",
      description: "Only the safe fallback language exists.",
    });
    await db().insert(productInventory).values({
      productId: productRow.id,
      storeId: fixture.storeAId,
      onHand: 3,
      reserved: 0,
    });

    const buyer = 92005;

    const start = await call(
      fixture.connectionAId,
      messageUpdate(buyer, "/start", {}, "en"),
    );
    expect(lastText(start.transport)).toContain("مرحبًا بك");

    const categoryView = await call(
      fixture.connectionAId,
      callbackUpdate(buyer, `sc:${categoryRow.id}`, "en"),
    );
    expect(lastText(categoryView.transport)).toContain("English Only Category");

    const productView = await call(
      fixture.connectionAId,
      callbackUpdate(buyer, `p:${productRow.id}`, "en"),
    );
    expect(lastText(productView.transport)).toContain("English Only Product");
    expect(lastText(productView.transport)).toContain(
      "Only the safe fallback language exists.",
    );
    expect(lastText(productView.transport)).toContain("9.50");

    const added = await call(
      fixture.connectionAId,
      callbackUpdate(buyer, `ca:${productRow.id}:1`, "en"),
    );
    expect(lastText(added.transport)).toContain("السلة");
    expect(lastText(added.transport)).toContain("English Only Product");
    expect(lastText(added.transport)).toContain("9.50 SAR");
  });

  it("keeps the saved phone when switching language at the address prompt", async () => {
    await setStoreDefault(fixture.storeAId, "ar");
    const buyer = 92006;

    await call(
      fixture.connectionAId,
      messageUpdate(buyer, "/start", {}, "en"),
    );
    await call(
      fixture.connectionAId,
      callbackUpdate(buyer, `p:${fixture.productAId}`, "en"),
    );
    const added = await call(
      fixture.connectionAId,
      callbackUpdate(buyer, `ca:${fixture.productAId}:1`, "en"),
    );
    const checkoutButton = lastButton(added.transport, "co:");
    expect(checkoutButton?.callback_data).toBeDefined();

    await call(
      fixture.connectionAId,
      callbackUpdate(buyer, checkoutButton!.callback_data!, "en"),
    );

    const phone = await call(
      fixture.connectionAId,
      contactUpdate(buyer, "+15557654321"),
    );
    expect(
      phone.transport.sentMessages.some((entry) =>
        entry.text.includes("أرسل عنوان التوصيل"),
      ),
    ).toBe(true);

    const addressMenu = await call(
      fixture.connectionAId,
      messageUpdate(buyer, "اللغة / Language"),
    );
    expect(lastText(addressMenu.transport)).toContain("اختر اللغة");

    const addressLanguageButton = lastButton(addressMenu.transport, "lang:");
    expect(addressLanguageButton?.callback_data).toBeDefined();

    const switchedAtAddress = await call(
      fixture.connectionAId,
      callbackUpdate(buyer, "lang:en"),
    );
    expect(
      switchedAtAddress.transport.sentMessages.some((entry) =>
        entry.text.includes("Send the delivery address"),
      ),
    ).toBe(true);

    const reviewed = await call(
      fixture.connectionAId,
      messageUpdate(buyer, "456 Address Switch Street"),
    );
    const reviewText = lastText(reviewed.transport);
    expect(reviewText).toContain("Review your order");
    expect(reviewText).toContain("+15557654321");
    expect(reviewText).toContain("456 Address Switch Street");

    const confirmButton = lastButton(reviewed.transport, "cc:");
    expect(confirmButton?.callback_data).toBeDefined();

    await call(
      fixture.connectionAId,
      callbackUpdate(buyer, confirmButton!.callback_data!),
    );

    const orders = await db().select().from(order);
    expect(orders).toHaveLength(1);
    expect(orders[0].customerPhone).toBe("+15557654321");
    expect(orders[0].deliveryAddress).toBe("456 Address Switch Street");
  });

  it("saves the merchant default only for the authenticated store", async () => {
    const accessA = await merchantAccessForStoreA();

    const saved = await saveMerchantStoreLanguage(
      db() as unknown as TransactionDatabase,
      accessA,
      { code: "ar" },
    );
    expect(saved.ok).toBe(true);

    const storeAChoice = await readStoreLanguageChoice(
      asAppDb(db()),
      fixture.storeAId,
    );
    const storeBChoice = await readStoreLanguageChoice(
      asAppDb(db()),
      fixture.storeBId,
    );

    expect(storeAChoice?.code).toBe("ar");
    expect(storeBChoice).toBeNull();

    const denied = await saveMerchantStoreLanguage(
      db() as unknown as TransactionDatabase,
      { ...accessA, readOnly: true },
      { code: "en" },
    );
    expect(denied).toEqual({ ok: false, error: "DENIED" });
  });
  it("keeps the separate placed receipt when returning home and changing language", async () => {
    const { confirmData } = await completeReview();
    const transport = createFakeTelegramTransport();

    const confirmed = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER_A, confirmData),
      "bot-secret-a",
      transport,
    );

    const receipt = lastReceipt(confirmed.transport);
    expect(receipt?.text).toContain("placed");
    expect(receipt?.text).toContain("Total: 37.00 SAR");
    const receiptId = receipt!.messageId;
    const reference = /ORD-[A-HJ-NP-Z2-9]{6}/.exec(receipt!.text)?.[0];
    expect(reference).toBeDefined();

    const receiptButtons = inlineButtons(receipt!);
    expect(
      receiptButtons.some((button) =>
        button.callback_data?.startsWith("lang"),
      ),
    ).toBe(false);

    const bridge = confirmed.transport.editedMessages.at(-1)!;
    expect(bridge.text).toContain("placed");
    expect(bridge.text).not.toContain("Subtotal:");
    const bridgeMessageId = bridge.messageId;

    const homeButton = inlineButtons(bridge).find(
      (button) => button.callback_data === "home:new",
    );
    expect(homeButton).toBeDefined();

    const home = await call(
      fixture.connectionAId,
      callbackUpdate(
        BUYER_A,
        homeButton!.callback_data!,
        undefined,
        bridgeMessageId,
      ),
      "bot-secret-a",
      transport,
    );
    expect(home.transport.sentMessages.at(-1)?.text).toContain("Welcome to");
    const homeMessageId = home.transport.sentMessages.at(-1)!.messageId;

    const languageMenu = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER_A, "langs:h", undefined, homeMessageId),
      "bot-secret-a",
      transport,
    );
    expect(languageMenu.transport.editedMessages.at(-1)?.text).toContain(
      "Choose your language",
    );

    const switched = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER_A, "lang:ar:h", undefined, homeMessageId),
      "bot-secret-a",
      transport,
    );
    expect(switched.transport.editedMessages.at(-1)?.text).toContain(
      "مرحبًا بك",
    );

    // Browsing edits the home message only. The separate receipt is untouched.
    const receiptEdits = switched.transport.editedMessages.filter(
      (message) => message.messageId === receiptId,
    );
    expect(receiptEdits).toHaveLength(0);
    expect(
      switched.transport.sentMessages.filter((message) =>
        message.text.includes(`Order ${reference} placed`),
      ),
    ).toHaveLength(1);

    // A replayed confirmation after browsing edits the stale message with the
    // same receipt; it never creates another order, reservation or receipt
    // send.
    const replayed = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER_A, confirmData, undefined, bridgeMessageId),
      "bot-secret-a",
      transport,
    );
    expect(replayed.status).toBe(200);
    expect(lastText(replayed.transport)).toContain(reference!);
    expect(lastText(replayed.transport)).toContain("37.00 SAR");
    expect(
      replayed.transport.sentMessages.filter((message) =>
        message.text.includes(reference!),
      ),
    ).toHaveLength(1);

    expect(await db().select().from(order)).toHaveLength(1);
    expect(await db().select().from(inventoryReservation)).toHaveLength(1);
  });

  it("does not duplicate the order or blind-resend the receipt when delivery is ambiguous", async () => {
    const { confirmData } = await completeReview();
    const transport = createFakeTelegramTransport();
    transport.failSendWith = "Request timed out";
    transport.failSendKind = "timeout";

    const confirmed = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER_A, confirmData),
      "bot-secret-a",
      transport,
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.transport.sentMessages).toHaveLength(0);

    // Recovery renders the receipt on the known active message instead of
    // sending again into an unknown delivery outcome.
    const recovered = confirmed.transport.editedMessages.at(-1)!;
    expect(recovered.text).toContain("placed");
    expect(recovered.text).toContain("Total: 37.00 SAR");

    expect(await db().select().from(order)).toHaveLength(1);
    expect(await db().select().from(inventoryReservation)).toHaveLength(1);

    transport.failSendWith = undefined;
    transport.failSendKind = undefined;

    const replayed = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER_A, confirmData),
      "bot-secret-a",
      transport,
    );
    expect(replayed.status).toBe(200);
    expect(replayed.transport.sentMessages).toHaveLength(0);
    expect(lastText(replayed.transport)).toContain("Total: 37.00 SAR");

    expect(await db().select().from(order)).toHaveLength(1);
    expect(await db().select().from(inventoryReservation)).toHaveLength(1);
  });

  it("recovers the latest COD order from /start when both receipt displays fail", async () => {
    const latest = tokens.latestCodOrder();
    const initialHome = await call(fixture.connectionAId, messageUpdate(BUYER_A, "/start"));
    expect(lastButton(initialHome.transport, latest)).toBeUndefined();

    const { confirmData, transport: reviewTransport } = await completeReview();
    const reviewId = lastScreenMessage(reviewTransport)!.messageId;
    const transport = createFakeTelegramTransport();
    transport.failSendWith = "Request timed out";
    transport.failSendKind = "timeout";
    transport.failEditWith = "Edit failed";
    transport.failEditKind = "api_error";
    const sendReceipt = vi.spyOn(transport, "sendMessage");
    const editReview = vi.spyOn(transport, "editMessageText");
    const failed = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER_A, confirmData, "en", reviewId),
      "bot-secret-a",
      transport,
    );
    expect(failed.status).toBe(500);
    expect(sendReceipt).toHaveBeenCalledTimes(1);
    expect(editReview).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ messageId: reviewId }),
    );
    expect(lastReceipt(failed.transport)).toBeUndefined();
    expect(failed.transport.editedMessages).toHaveLength(0);
    const orders = await db().select().from(order);
    const reservations = await db().select().from(inventoryReservation);
    expect(orders).toHaveLength(1);
    expect(reservations).toHaveLength(1);
    expect(reservations[0].orderId).toBe(orders[0].id);
    const { reference } = orders[0];

    // Recovery remains available after the store disables new COD orders.
    await db().update(storeCommerceSetting).set({ codEnabled: false })
      .where(eq(storeCommerceSetting.storeId, fixture.storeAId));
    const home = await call(fixture.connectionAId, messageUpdate(BUYER_A, "/start"));
    expect(lastButton(home.transport, latest)?.text).toBe("Latest COD order");
    const homeId = lastScreenMessage(home.transport)!.messageId;
    const recovered = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER_A, latest, "en", homeId),
    );
    expect(recovered.status).toBe(200);
    expect(lastText(recovered.transport)).toContain(`Order reference: ${reference}`);
    expect(lastText(recovered.transport)).toContain("Order status: Placed");
    expect(lastText(recovered.transport)).toContain("Payment: Awaiting collection");
    const returned = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER_A, tokens.home(), "en", homeId),
    );
    expect(lastButton(returned.transport, latest)?.text).toBe("Latest COD order");

    const otherBuyer = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER_A + 1, latest, "en", homeId),
    );
    const otherChatUpdate = callbackUpdate(BUYER_A, latest, "en", homeId);
    otherChatUpdate.callback_query.message.chat.id = BUYER_A + 1;
    const otherChat = await call(fixture.connectionAId, otherChatUpdate);
    const otherStore = await call(
      fixture.connectionBId,
      callbackUpdate(BUYER_A, latest, "en", homeId),
      "bot-secret-b",
    );
    for (const denied of [otherBuyer, otherChat, otherStore]) {
      expect(denied.status).toBe(200);
      expect(lastText(denied.transport)).toBe("There is no cash-on-delivery order in this chat.");
    }
    const otherBuyerHome = await call(
      fixture.connectionAId,
      messageUpdate(BUYER_A + 1, "/start"),
    );
    expect(lastButton(otherBuyerHome.transport, latest)).toBeUndefined();
    const scope = await readStoreScopeForFixture(db(), fixture.storeAId);
    expect(await readLatestBuyerCodOrder(asAppDb(db()), scope, {
      connectionId: fixture.connectionBId,
      telegramUserId: BUYER_A,
      telegramChatId: BUYER_A,
    })).toBeNull();
    expect(await db().select().from(order)).toEqual(orders);
    expect(await db().select().from(inventoryReservation)).toEqual(reservations);

    await db().update(order).set({ status: "accepted", acceptedAt: new Date() })
      .where(eq(order.id, orders[0].id));
    const switched = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER_A, tokens.lang("ar", "cod"), "en", homeId),
    );
    expect(switched.status).toBe(200);
    expect(lastText(switched.transport)).toContain(`مرجع الطلب: ${reference}`);
    expect(lastText(switched.transport)).toContain("حالة الطلب: تم قبول الطلب");
    const arabicHome = await call(fixture.connectionAId, messageUpdate(BUYER_A, "/start"));
    expect(lastButton(arabicHome.transport, latest)?.text).toBe("آخر طلب بالدفع عند الاستلام");
  });

  describe("managed catalog navigation context", () => {
    async function sendNavigationSearch(
      query: string,
      dbOverride?: Database,
    ) {
      const search = await call(
        fixture.connectionCId,
        callbackUpdate(BUYER_C, "catalog-search", "en"),
        "bot-secret-c",
        createFakeTelegramTransport(),
        { db: dbOverride },
      );
      const prompt = search.transport.sentMessages.at(-1)!;
      const reply = {
        message_id: prompt.messageId,
        from: { id: NAVIGATION_BOT_ID, is_bot: true },
        chat: { id: BUYER_C, type: "private" },
        text: prompt.text,
      };
      const result = await call(
        fixture.connectionCId,
        messageUpdate(
          BUYER_C,
          query,
          { reply_to_message: reply },
          "en",
        ),
        "bot-secret-c",
        createFakeTelegramTransport(),
        { db: dbOverride },
      );
      expect(result.status).toBe(200);
      return lastScreenMessage(result.transport)!;
    }

    async function openSearchPage(
      page: number,
      message: { messageId: number; text: string },
    ) {
      const update = callbackUpdate(
        BUYER_C,
        `catalog-search:${page}`,
        "en",
        message.messageId,
      );
      const result = await call(
        fixture.connectionCId,
        {
          ...update,
          callback_query: {
            ...update.callback_query,
            message: {
              ...update.callback_query.message,
              from: { id: NAVIGATION_BOT_ID, is_bot: true },
              text: message.text,
            },
          },
        },
        "bot-secret-c",
      );
      expect(result.status).toBe(200);
      return result.transport.editedMessages.at(-1)!;
    }

    async function clickNavigation(
      data: string,
      messageId: number,
      options?: {
        buyerId?: number;
        connectionId?: string;
        secret?: string;
        languageCode?: string;
        db?: Database;
      },
    ): Promise<FakeTelegramTransport> {
      const result = await call(
        options?.connectionId ?? fixture.connectionCId,
        callbackUpdate(
          options?.buyerId ?? BUYER_C,
          data,
          options?.languageCode ?? "en",
          messageId,
        ),
        options?.secret ?? "bot-secret-c",
        createFakeTelegramTransport(),
        { db: options?.db },
      );
      expect(result.status).toBe(200);
      return result.transport;
    }

    function buttonFor(
      message: { replyMarkup?: unknown },
      prefix: string,
    ): { text: string; callback_data?: string } | undefined {
      return inlineButtons(message).find((button) =>
        button.callback_data?.startsWith(prefix),
      );
    }

    function navigationTokenFrom(backData: string): string {
      const parts = backData.split(":");
      expect(parts[0]).toBe("pb");
      expect(parts).toHaveLength(3);
      return parts[2];
    }

    it("returns from a product to the same search query and results page", async () => {
      const results = await sendNavigationSearch("nav item");
      expect(results.text).toContain("Product search results");
      expect(results.text).toContain("1/2");

      const pageTwo = await openSearchPage(2, results);
      expect(pageTwo.text).toContain("Product search results");
      expect(pageTwo.text).toContain("nav item");
      expect(pageTwo.text).toContain("2/2");

      const productButton = buttonFor(pageTwo, "p:");
      expect(productButton?.callback_data).toBeDefined();
      expect(productButton!.callback_data).not.toContain("nav item");
      expect(
        Buffer.byteLength(productButton!.callback_data!, "utf8"),
      ).toBeLessThanOrEqual(64);

      const product = await clickNavigation(
        productButton!.callback_data!,
        pageTwo.messageId,
      );
      const productCard = product.editedMessages.at(-1)!;
      expect(productCard.text).toContain("Nav Item");
      const backButton = buttonFor(productCard, "pb:");
      expect(backButton?.callback_data).toBeDefined();

      const restored = await clickNavigation(
        backButton!.callback_data!,
        productCard.messageId,
      );
      const searchAgain = restored.editedMessages.at(-1)!;
      expect(searchAgain.text).toContain("Product search results");
      expect(searchAgain.text).toContain("nav item");
      expect(searchAgain.text).toContain("2/2");
      expect(buttonFor(searchAgain, "p:")).toBeDefined();
    });

    it("returns from a home product shortcut to the storefront home", async () => {
      const home = await call(
        fixture.connectionCId,
        messageUpdate(BUYER_C, "/start", {}, "en"),
        "bot-secret-c",
      );
      expect(home.status).toBe(200);
      const homeMessage = home.transport.sentMessages.at(-1)!;
      const productButton = buttonFor(homeMessage, "p:");
      expect(productButton?.callback_data).toBeDefined();

      const product = await clickNavigation(
        productButton!.callback_data!,
        homeMessage.messageId,
      );
      const productCard = product.editedMessages.at(-1)!;
      const backButton = buttonFor(productCard, "pb:");
      expect(backButton?.callback_data).toBeDefined();

      const restored = await clickNavigation(
        backButton!.callback_data!,
        productCard.messageId,
      );
      expect(restored.editedMessages.at(-1)!.text).toContain(
        "Welcome to Bot COD Store C.",
      );
    });

    it("returns from a product to the originating product-list page", async () => {
      const pageOne = await clickNavigation("prods", 8101);
      expect(pageOne.editedMessages.at(-1)!.text).toContain("Products (1/2)");

      const pageTwo = await clickNavigation(tokens.products(2), 8101);
      const listPage = pageTwo.editedMessages.at(-1)!;
      expect(listPage.text).toContain("Products (2/2)");

      const productButton = buttonFor(listPage, "p:");
      expect(productButton?.callback_data).toBeDefined();
      const product = await clickNavigation(
        productButton!.callback_data!,
        listPage.messageId,
      );
      const productCard = product.editedMessages.at(-1)!;
      const backButton = buttonFor(productCard, "pb:");
      expect(backButton?.callback_data).toBeDefined();

      const restored = await clickNavigation(
        backButton!.callback_data!,
        productCard.messageId,
      );
      const listAgain = restored.editedMessages.at(-1)!;
      expect(listAgain.text).toContain("Products (2/2)");
      expect(
        inlineButtons(listAgain).some((button) =>
          button.callback_data?.startsWith("p:"),
        ),
      ).toBe(true);
    });

    it("returns from a product to the originating category page", async () => {
      const pageOne = await clickNavigation(
        tokens.storefrontCategory(fixture.categoryCId),
        8201,
      );
      expect(pageOne.editedMessages.at(-1)!.text).toBe("Bot C Root");

      const pageTwo = await clickNavigation(
        tokens.storefrontCategory(fixture.categoryCId, 2),
        8201,
      );
      const categoryPage = pageTwo.editedMessages.at(-1)!;
      expect(categoryPage.text).toBe("Bot C Root");

      const productButton = buttonFor(categoryPage, "p:");
      expect(productButton?.callback_data).toBeDefined();
      const product = await clickNavigation(
        productButton!.callback_data!,
        categoryPage.messageId,
      );
      const productCard = product.editedMessages.at(-1)!;
      const backButton = buttonFor(productCard, "pb:");
      expect(backButton?.callback_data).toBeDefined();

      const restored = await clickNavigation(
        backButton!.callback_data!,
        productCard.messageId,
      );
      const categoryAgain = restored.editedMessages.at(-1)!;
      expect(categoryAgain.text).toBe("Bot C Root");
      expect(
        inlineButtons(categoryAgain).some(
          (button) =>
            button.callback_data ===
            tokens.storefrontCategory(fixture.categoryCId, 1),
        ),
      ).toBe(true);
      expect(
        inlineButtons(categoryAgain).some((button) =>
          button.callback_data?.startsWith("p:"),
        ),
      ).toBe(true);
    });

    it("keeps the search return context across the product language switch", async () => {
      const results = await sendNavigationSearch("nav item");
      const pageTwo = await openSearchPage(2, results);
      const productButton = buttonFor(pageTwo, "p:");
      const product = await clickNavigation(
        productButton!.callback_data!,
        pageTwo.messageId,
      );
      const productCard = product.editedMessages.at(-1)!;

      const languageButton = buttonFor(productCard, "langs:pd:");
      expect(languageButton?.callback_data).toBeDefined();
      const menu = await clickNavigation(
        languageButton!.callback_data!,
        productCard.messageId,
      );
      expect(menu.editedMessages.at(-1)!.text).toContain("Choose your language");

      const arabicChoice = inlineButtons(menu.editedMessages.at(-1)!).find(
        (button) => button.callback_data?.startsWith("lang:ar:"),
      );
      expect(arabicChoice?.callback_data).toBeDefined();
      const arabicProduct = await clickNavigation(
        arabicChoice!.callback_data!,
        productCard.messageId,
      );
      const arabicCard = arabicProduct.editedMessages.at(-1)!;
      expect(
        inlineButtons(arabicCard).some((button) => button.text === "رجوع"),
      ).toBe(true);
      const backButton = buttonFor(arabicCard, "pb:");
      expect(backButton?.callback_data).toBeDefined();

      const restored = await clickNavigation(
        backButton!.callback_data!,
        productCard.messageId,
      );
      const searchAgain = restored.editedMessages.at(-1)!;
      expect(searchAgain.text).toContain("نتائج البحث عن المنتجات");
      expect(searchAgain.text).toContain("nav item");
      expect(searchAgain.text).toContain("2/2");
    });

    it("falls back to the product category for direct entry without context", async () => {
      const productId = fixture.navigationProductIds[0];
      const product = await clickNavigation(`p:${productId}`, 8301);
      const productCard = product.editedMessages.at(-1)!;
      const backButton = buttonFor(productCard, "pb:");
      expect(backButton?.callback_data).toBe(tokens.productBack(productId));

      const category = await clickNavigation(
        backButton!.callback_data!,
        productCard.messageId,
      );
      expect(category.editedMessages.at(-1)!.text).toBe("Bot C Root");
    });

    it("returns to the localized home when the context expired", async () => {
      const pageOne = await clickNavigation("prods", 8401);
      const listPage = pageOne.editedMessages.at(-1)!;
      const productButton = buttonFor(listPage, "p:");
      const product = await clickNavigation(
        productButton!.callback_data!,
        listPage.messageId,
      );
      const productCard = product.editedMessages.at(-1)!;
      const backButton = buttonFor(productCard, "pb:");
      const navigationToken = navigationTokenFrom(backButton!.callback_data!);

      await db()
        .update(telegramNavigationContext)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(
          eq(telegramNavigationContext.navigationToken, navigationToken),
        );

      const expired = await clickNavigation(
        backButton!.callback_data!,
        productCard.messageId,
      );
      const home = expired.editedMessages.at(-1)!;
      expect(home.text).toContain("Welcome to Bot COD Store C.");
      expect(home.text).not.toContain("Products (2/2)");
    });

    it("localizes the safe home when an expired context is opened in Arabic", async () => {
      const pageOne = await clickNavigation("prods", 8500, {
        languageCode: "ar",
      });
      const listPage = pageOne.editedMessages.at(-1)!;
      expect(listPage.text).toContain("المنتجات (1/2)");
      const productButton = buttonFor(listPage, "p:");
      const product = await clickNavigation(
        productButton!.callback_data!,
        listPage.messageId,
        { languageCode: "ar" },
      );
      const productCard = product.editedMessages.at(-1)!;
      const backButton = buttonFor(productCard, "pb:");
      const navigationToken = navigationTokenFrom(backButton!.callback_data!);

      await db()
        .update(telegramNavigationContext)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(
          eq(telegramNavigationContext.navigationToken, navigationToken),
        );

      const expired = await clickNavigation(
        backButton!.callback_data!,
        productCard.messageId,
        { languageCode: "ar" },
      );
      expect(expired.editedMessages.at(-1)!.text).toContain(
        "مرحبًا بك في Bot COD Store C.",
      );
    });

    it("rejects a return context issued for another store", async () => {
      const results = await sendNavigationSearch("nav item");
      const productButton = buttonFor(results, "p:");
      const navigationToken = navigationTokenFrom(
        productButton!.callback_data!.replace(/^p:/, "pb:"),
      );

      const foreignProduct = await clickNavigation(
        `p:${fixture.productAId}:${navigationToken}`,
        8501,
        {
          buyerId: BUYER_A,
          connectionId: fixture.connectionAId,
          secret: "bot-secret-a",
        },
      );
      const foreignCard = foreignProduct.editedMessages.at(-1)!;
      expect(foreignCard.text).toContain("Bot A One");
      const foreignBack = buttonFor(foreignCard, "pb:");
      expect(foreignBack?.callback_data).toBeDefined();

      const denied = await clickNavigation(
        foreignBack!.callback_data!,
        foreignCard.messageId,
        {
          buyerId: BUYER_A,
          connectionId: fixture.connectionAId,
          secret: "bot-secret-a",
        },
      );
      const category = denied.editedMessages.at(-1)!;
      expect(category.text).toBe("Bot A Root");
      expect(category.text).not.toContain("Nav Item");
    });

    it("falls back safely for an unknown navigation token", async () => {
      const productId = fixture.navigationProductIds[0];
      const invalidBack = tokens.productBack(productId, "AAAAAAAAAAAA");
      const invalid = await clickNavigation(invalidBack, 8601);
      expect(invalid.editedMessages.at(-1)!.text).toBe("Bot C Root");
    });

    it("renders all catalog screens without tokens when context storage fails", async () => {
      const failing = navigationWriteFailingDb();
      const firstProductId = fixture.navigationProductIds[0];

      const home = await call(
        fixture.connectionCId,
        messageUpdate(BUYER_C, "/start", {}, "en"),
        "bot-secret-c",
        createFakeTelegramTransport(),
        { db: failing },
      );
      expect(home.status).toBe(200);
      const homeMessage = home.transport.sentMessages.at(-1)!;
      expect(homeMessage.text).toContain("Welcome to Bot COD Store C.");
      expect(buttonFor(homeMessage, "p:")?.callback_data).toBe(
        `p:${firstProductId}`,
      );

      const products = await clickNavigation("prods", 8701, { db: failing });
      const listPage = products.editedMessages.at(-1)!;
      expect(listPage.text).toContain("Products (1/2)");
      const listProduct = buttonFor(listPage, "p:");
      expect(listProduct?.callback_data).toBe(`p:${firstProductId}`);

      const category = await clickNavigation(
        `sc:${fixture.categoryCId}`,
        8702,
        { db: failing },
      );
      const categoryPage = category.editedMessages.at(-1)!;
      expect(categoryPage.text).toBe("Bot C Root");
      expect(buttonFor(categoryPage, "p:")?.callback_data).toBe(
        `p:${firstProductId}`,
      );

      const results = await sendNavigationSearch("nav item", failing);
      expect(results.text).toContain("Product search results");
      expect(buttonFor(results, "p:")?.callback_data).toBe(
        `p:${firstProductId}`,
      );

      // Direct-entry Back still reaches the product's own category even while
      // optional context storage is failing. The search result is the current
      // active screen, so use its own product button and message.
      const currentProduct = buttonFor(results, "p:");
      expect(currentProduct?.callback_data).toBe(`p:${firstProductId}`);
      const product = await clickNavigation(
        currentProduct!.callback_data!,
        results.messageId,
        { db: failing },
      );
      const productCard = product.editedMessages.at(-1)!;
      expect(productCard.text).toContain("Nav Item");
      const backButton = buttonFor(productCard, "pb:");
      expect(backButton?.callback_data).toBe(
        tokens.productBack(firstProductId),
      );

      const categoryAgain = await clickNavigation(
        backButton!.callback_data!,
        productCard.messageId,
        { db: failing },
      );
      expect(categoryAgain.editedMessages.at(-1)!.text).toBe("Bot C Root");
    });

    it("falls back to the localized home when the return context cannot be read", async () => {
      const pageOne = await clickNavigation("prods", 8801);
      const listPage = pageOne.editedMessages.at(-1)!;
      const productButton = buttonFor(listPage, "p:");
      expect(productButton?.callback_data).toBeDefined();

      const product = await clickNavigation(
        productButton!.callback_data!,
        listPage.messageId,
      );
      const productCard = product.editedMessages.at(-1)!;
      const backButton = buttonFor(productCard, "pb:");
      expect(backButton?.callback_data).toBeDefined();

      const failed = await clickNavigation(
        backButton!.callback_data!,
        productCard.messageId,
        { db: navigationReadFailingDb(), languageCode: "ar" },
      );
      expect(failed.editedMessages.at(-1)!.text).toContain(
        "مرحبًا بك في Bot COD Store C.",
      );
    });

    it("prunes expired rows from another inactive buyer and keeps unexpired rows", async () => {
      const inactiveBuyer = 91999;
      const now = Date.now();
      const expiredRows = Array.from(
        { length: NAVIGATION_CONTEXT_PRUNE_BATCH_SIZE + 5 },
        (_, index) => ({
          storeId: fixture.storeCId,
          connectionId: fixture.connectionCId,
          botId: NAVIGATION_BOT_ID,
          telegramUserId: inactiveBuyer,
          telegramChatId: inactiveBuyer,
          navigationToken: `E${String(index).padStart(2, "0")}${"A".repeat(9)}`,
          route: "products",
          page: 1,
          expiresAt: new Date(now - 60_000 - index * 1_000),
        }),
      );
      const unexpiredToken = `U${"B".repeat(11)}`;

      await db().insert(telegramNavigationContext).values([
        ...expiredRows,
        {
          storeId: fixture.storeCId,
          connectionId: fixture.connectionCId,
          botId: NAVIGATION_BOT_ID,
          telegramUserId: inactiveBuyer,
          telegramChatId: inactiveBuyer,
          navigationToken: unexpiredToken,
          route: "products",
          page: 1,
          expiresAt: new Date(now + 300_000),
        },
      ]);

      const inactiveRows = () =>
        db()
          .select({
            navigationToken: telegramNavigationContext.navigationToken,
            expiresAt: telegramNavigationContext.expiresAt,
          })
          .from(telegramNavigationContext)
          .where(
            eq(telegramNavigationContext.telegramUserId, inactiveBuyer),
          );

      expect(await inactiveRows()).toHaveLength(expiredRows.length + 1);

      // Normal storefront traffic from a different buyer triggers the bounded
      // global cleanup.
      await clickNavigation("prods", 8901);
      const afterFirst = await inactiveRows();
      expect(afterFirst).toHaveLength(
        expiredRows.length + 1 - NAVIGATION_CONTEXT_PRUNE_BATCH_SIZE,
      );
      expect(
        afterFirst.some((row) => row.navigationToken === unexpiredToken),
      ).toBe(true);
      expect(
        afterFirst.filter((row) => row.expiresAt.getTime() <= Date.now()),
      ).toHaveLength(expiredRows.length - NAVIGATION_CONTEXT_PRUNE_BATCH_SIZE);

      await clickNavigation("prods", 8902);
      const afterSecond = await inactiveRows();
      expect(afterSecond).toHaveLength(1);
      expect(afterSecond[0].navigationToken).toBe(unexpiredToken);
    });
  });

  describe("managed active storefront message", () => {
    it("edits the active message in place across text updates and callbacks", async () => {
      const buyer = 93001;
      const start = await call(
        fixture.connectionAId,
        messageUpdate(buyer, "/start", {}, "en"),
      );
      const home = start.transport.sentMessages.at(-1)!;
      expect(await activeStorefrontRow(buyer)).toMatchObject({
        activeMessageId: home.messageId,
        route: "home",
        inputMode: "none",
        revision: 1,
        hasMedia: false,
      });

      const products = await call(
        fixture.connectionAId,
        callbackUpdate(buyer, "prods", "en", home.messageId),
      );
      expect(products.transport.sentMessages).toHaveLength(0);
      expect(products.transport.editedMessages.at(-1)).toMatchObject({
        messageId: home.messageId,
      });
      expect(await activeStorefrontRow(buyer)).toMatchObject({
        activeMessageId: home.messageId,
        route: "products",
        revision: 2,
      });

      const again = await call(
        fixture.connectionAId,
        messageUpdate(buyer, "/start", {}, "en"),
      );
      expect(again.transport.sentMessages).toHaveLength(0);
      expect(again.transport.editedMessages.at(-1)?.messageId).toBe(
        home.messageId,
      );

      const unknownText = await call(
        fixture.connectionAId,
        messageUpdate(buyer, "hello there", {}, "en"),
      );
      expect(unknownText.transport.sentMessages).toHaveLength(0);
      expect(unknownText.transport.editedMessages.at(-1)?.messageId).toBe(
        home.messageId,
      );
      expect(await activeStorefrontRow(buyer)).toMatchObject({
        activeMessageId: home.messageId,
        route: "home",
        inputMode: "none",
        revision: 4,
      });
    });

    it("allows one confirmed replacement and rejects callbacks from the retired message", async () => {
      const buyer = 93002;
      productContract.set(fixture.productAId, {
        imageUrl: "https://cdn.example.test/products/bot-a.jpg",
        availability: { available: 3, inStock: true },
      });

      const transport = createFakeTelegramTransport();
      const start = await call(
        fixture.connectionAId,
        messageUpdate(buyer, "/start", {}, "en"),
        "bot-secret-a",
        transport,
      );
      const home = start.transport.sentMessages.at(-1)!;

      const product = await call(
        fixture.connectionAId,
        callbackUpdate(buyer, `p:${fixture.productAId}`, "en", home.messageId),
        "bot-secret-a",
        transport,
      );
      const photo = product.transport.sentPhotos.at(-1)!;
      expect(photo).toBeDefined();
      expect(photo.messageId).not.toBe(home.messageId);
      expect(
        product.transport.editedReplyMarkups.some(
          (entry) =>
            entry.messageId === home.messageId &&
            entry.replyMarkup?.inline_keyboard.length === 0,
        ),
      ).toBe(true);
      expect(await activeStorefrontRow(buyer)).toMatchObject({
        activeMessageId: photo.messageId,
        hasMedia: true,
        route: "product",
      });

      transport.failEditWith =
        "Bad Request: There is no text in the message to edit";
      transport.failEditKind = "not_editable";
      const sentBeforeReplacement = transport.sentMessages.length;
      const cart = await call(
        fixture.connectionAId,
        callbackUpdate(buyer, "cart", "en", photo.messageId),
        "bot-secret-a",
        transport,
      );
      expect(cart.transport.sentMessages).toHaveLength(
        sentBeforeReplacement + 1,
      );
      const replacementMessage = cart.transport.sentMessages.at(-1)!;
      expect(replacementMessage.text).toContain("Your cart is empty");
      const replacementMessageId = replacementMessage.messageId;
      expect(replacementMessageId).not.toBe(photo.messageId);
      expect(
        cart.transport.editedReplyMarkups.some(
          (entry) =>
            entry.messageId === photo.messageId &&
            entry.replyMarkup?.inline_keyboard.length === 0,
        ),
      ).toBe(true);
      const afterReplacement = await activeStorefrontRow(buyer);
      expect(afterReplacement).toMatchObject({
        activeMessageId: replacementMessageId,
        hasMedia: false,
        route: "cart",
      });

      transport.failEditWith = undefined;
      transport.failEditKind = undefined;
      const sentBeforeStale = transport.sentMessages.length;
      const editedBeforeStale = transport.editedMessages.length;
      const stale = await call(
        fixture.connectionAId,
        callbackUpdate(buyer, "prods", "en", photo.messageId),
        "bot-secret-a",
        transport,
      );
      expect(stale.status).toBe(200);
      expect(stale.transport.answeredCallbacks.at(-1)?.text).toContain(
        "no longer active",
      );
      expect(stale.transport.sentMessages).toHaveLength(sentBeforeStale);
      expect(stale.transport.editedMessages).toHaveLength(editedBeforeStale);
      expect(await activeStorefrontRow(buyer)).toEqual(afterReplacement);
    });

    it("does not replace or advance state when an edit outcome is ambiguous, then retries the same update", async () => {
      const buyer = 93003;
      const start = await call(
        fixture.connectionAId,
        messageUpdate(buyer, "/start", {}, "en"),
      );
      const home = start.transport.sentMessages.at(-1)!;
      const update = callbackUpdate(buyer, "prods", "en", home.messageId);

      const failing = createFakeTelegramTransport();
      failing.failEditWith = "Request timed out";
      failing.failEditKind = "timeout";
      const failed = await call(
        fixture.connectionAId,
        update,
        "bot-secret-a",
        failing,
      );
      expect(failed.status).toBe(500);
      expect(failed.transport.sentMessages).toHaveLength(0);
      expect(failed.transport.editedMessages).toHaveLength(0);
      expect(await activeStorefrontRow(buyer)).toMatchObject({
        activeMessageId: home.messageId,
        route: "home",
        revision: 1,
      });

      const retried = createFakeTelegramTransport();
      const recovered = await call(
        fixture.connectionAId,
        update,
        "bot-secret-a",
        retried,
      );
      expect(recovered.status).toBe(200);
      expect(recovered.transport.sentMessages).toHaveLength(0);
      expect(recovered.transport.editedMessages.at(-1)?.messageId).toBe(
        home.messageId,
      );
      expect(await activeStorefrontRow(buyer)).toMatchObject({
        activeMessageId: home.messageId,
        route: "products",
        revision: 2,
      });
    });

    it("rejects a delayed update that would overwrite a newer screen", async () => {
      const buyer = 93004;
      const start = await call(
        fixture.connectionAId,
        messageUpdate(buyer, "/start", {}, "en"),
      );
      const home = start.transport.sentMessages.at(-1)!;

      await call(
        fixture.connectionAId,
        callbackUpdate(buyer, "prods", "en", home.messageId),
      );
      await call(
        fixture.connectionAId,
        callbackUpdate(buyer, "home", "en", home.messageId),
      );
      const current = await activeStorefrontRow(buyer);
      expect(current).toMatchObject({ route: "home", revision: 3 });

      const delayed = callbackUpdate(buyer, "prods", "en", home.messageId);
      delayed.update_id = 1;
      const staleTransport = createFakeTelegramTransport();
      const result = await call(
        fixture.connectionAId,
        delayed,
        "bot-secret-a",
        staleTransport,
      );
      expect(result.status).toBe(200);
      expect(result.transport.answeredCallbacks.at(-1)?.text).toContain(
        "no longer active",
      );
      expect(result.transport.editedMessages).toHaveLength(0);
      expect(result.transport.sentMessages).toHaveLength(0);
      expect(await activeStorefrontRow(buyer)).toEqual(current);
    });

    it("isolates active state by store connection and buyer", async () => {
      const buyer = 93005;
      const startA = await call(
        fixture.connectionAId,
        messageUpdate(buyer, "/start", {}, "en"),
      );
      const homeA = startA.transport.sentMessages.at(-1)!;
      const startB = await call(
        fixture.connectionBId,
        messageUpdate(buyer, "/start", {}, "en"),
        "bot-secret-b",
      );
      const homeB = startB.transport.sentMessages.at(-1)!;

      expect(await activeStorefrontRow(buyer, fixture.connectionAId))
        .toMatchObject({ activeMessageId: homeA.messageId });
      expect(await activeStorefrontRow(buyer, fixture.connectionBId))
        .toMatchObject({ activeMessageId: homeB.messageId });

      const otherBuyer = 93006;
      const otherStart = await call(
        fixture.connectionAId,
        messageUpdate(otherBuyer, "/start", {}, "en"),
      );
      const otherHome = otherStart.transport.sentMessages.at(-1)!;

      const returned = await call(
        fixture.connectionAId,
        callbackUpdate(buyer, "prods", "en", homeA.messageId),
      );
      expect(returned.status).toBe(200);
      expect(returned.transport.editedMessages.at(-1)?.messageId).toBe(
        homeA.messageId,
      );

      expect(await activeStorefrontRow(buyer, fixture.connectionBId))
        .toMatchObject({ activeMessageId: homeB.messageId, route: "home" });
      expect(await activeStorefrontRow(otherBuyer, fixture.connectionAId))
        .toMatchObject({ activeMessageId: otherHome.messageId, route: "home" });
      expect(await activeStorefrontRow(buyer, fixture.connectionAId))
        .toMatchObject({ activeMessageId: homeA.messageId, route: "products" });
    });

    it("keeps the same active message through a product language switch and Back to the exact page", async () => {
      const buyer = 93007;
      const start = await call(
        fixture.connectionCId,
        messageUpdate(buyer, "/start", {}, "en"),
        "bot-secret-c",
      );
      const home = start.transport.sentMessages.at(-1)!;

      const pageTwo = await call(
        fixture.connectionCId,
        callbackUpdate(buyer, "prods:2", "en", home.messageId),
        "bot-secret-c",
      );
      const list = pageTwo.transport.editedMessages.at(-1)!;
      expect(list.messageId).toBe(home.messageId);
      expect(list.text).toContain("Products (2/2)");
      const productButton = inlineButtons(list).find((button) =>
        button.callback_data?.startsWith("p:"),
      );
      expect(productButton?.callback_data).toBeDefined();

      const product = await call(
        fixture.connectionCId,
        callbackUpdate(buyer, productButton!.callback_data!, "en", home.messageId),
        "bot-secret-c",
      );
      const card = product.transport.editedMessages.at(-1)!;
      expect(card.messageId).toBe(home.messageId);
      const languageButton = inlineButtons(card).find((button) =>
        button.callback_data?.startsWith("langs:"),
      );
      expect(languageButton?.callback_data).toBeDefined();

      const menu = await call(
        fixture.connectionCId,
        callbackUpdate(buyer, languageButton!.callback_data!, "en", home.messageId),
        "bot-secret-c",
      );
      const menuMessage = menu.transport.editedMessages.at(-1)!;
      expect(menuMessage.messageId).toBe(home.messageId);
      expect(menuMessage.text).toContain("Choose your language");
      const arabic = inlineButtons(menuMessage).find((button) =>
        button.callback_data?.startsWith("lang:ar"),
      );
      expect(arabic?.callback_data).toBeDefined();

      const switched = await call(
        fixture.connectionCId,
        callbackUpdate(buyer, arabic!.callback_data!, "en", home.messageId),
        "bot-secret-c",
      );
      const arabicCard = switched.transport.editedMessages.at(-1)!;
      expect(arabicCard.messageId).toBe(home.messageId);
      expect(arabicCard.text).toContain("Nav Item");
      const back = inlineButtons(arabicCard).find((button) =>
        button.callback_data?.startsWith("pb:"),
      );
      expect(back?.callback_data).toBeDefined();

      const restored = await call(
        fixture.connectionCId,
        callbackUpdate(buyer, back!.callback_data!, "en", home.messageId),
        "bot-secret-c",
      );
      const listAgain = restored.transport.editedMessages.at(-1)!;
      expect(listAgain.messageId).toBe(home.messageId);
      expect(listAgain.text).toContain("(2/2)");
      expect(await activeStorefrontRow(buyer, fixture.connectionCId))
        .toMatchObject({
          activeMessageId: home.messageId,
          route: "products",
        });
    });

    it("replays checkout confirmation on the active browse screen without touching the receipt or duplicating commerce", async () => {
      const buyer = 93008;
      const { confirmData, transport: reviewTransport } = await completeReview(buyer);
      const reviewId = lastScreenMessage(reviewTransport)!.messageId;

      const transport = createFakeTelegramTransport();
      const confirmed = await call(
        fixture.connectionAId,
        callbackUpdate(buyer, confirmData, "en", reviewId),
        "bot-secret-a",
        transport,
      );
      const receipt = lastReceipt(confirmed.transport)!;
      expect(receipt).toBeDefined();
      const receiptId = receipt.messageId;
      const reference = /ORD-[A-HJ-NP-Z2-9]{6}/.exec(receipt.text)?.[0];
      expect(reference).toBeDefined();
      const bridge = confirmed.transport.editedMessages.find(
        (entry) => entry.messageId === reviewId,
      )!;
      expect(bridge.text).toContain(`Order ${reference} placed`);
      expect(await activeStorefrontRow(buyer)).toMatchObject({
        activeMessageId: reviewId,
        route: "receipt_bridge",
      });

      const homeButton = inlineButtons(bridge).find(
        (button) => button.callback_data === "home:new",
      );
      expect(homeButton).toBeDefined();
      const home = await call(
        fixture.connectionAId,
        callbackUpdate(buyer, homeButton!.callback_data!, "en", reviewId),
        "bot-secret-a",
        transport,
      );
      const homeMessage = home.transport.sentMessages.at(-1)!;
      expect(homeMessage.text).toContain("Welcome to");
      expect(homeMessage.messageId).not.toBe(receiptId);
      expect(homeMessage.messageId).not.toBe(reviewId);
      expect(await activeStorefrontRow(buyer)).toMatchObject({
        activeMessageId: homeMessage.messageId,
        route: "home",
      });

      // The old review message id is lower than the fresh browse screen in a
      // real chat. The fake transport resets ids per call, so replay from the
      // immediately preceding message id to prove the older-message path.
      const replayed = await call(
        fixture.connectionAId,
        callbackUpdate(buyer, confirmData, "en", homeMessage.messageId - 1),
        "bot-secret-a",
        transport,
      );
      expect(replayed.status).toBe(200);
      expect(lastText(replayed.transport)).toContain(reference!);
      expect(lastText(replayed.transport)).toContain("37.00 SAR");
      expect(
        replayed.transport.editedMessages.some(
          (entry) => entry.messageId === receiptId,
        ),
      ).toBe(false);
      expect(
        replayed.transport.sentMessages.filter((entry) =>
          entry.text.includes(reference!),
        ),
      ).toHaveLength(1);
      expect(await db().select().from(order)).toHaveLength(1);
      expect(await db().select().from(inventoryReservation)).toHaveLength(1);
      expect(await activeStorefrontRow(buyer)).toMatchObject({
        activeMessageId: homeMessage.messageId,
        route: "receipt_bridge",
      });
    });
  });

});
