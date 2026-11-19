import { describe, expect, it } from "vitest";
import {
  classifyPosError,
  KITCHEN_NEXT,
  menuByCategory,
  parseCategoryForm,
  parseDay,
  parseItemForm,
  parseKitchen,
  parseLineForm,
  parseMenu,
  parseOpenOrderForm,
  parseOpenOrders,
  parseOrder,
  parsePayForm,
  parsePlaceForm,
  parsePostForm,
  parseSales,
  parseStatusForm,
  parseVoidForm,
  waitText,
} from "./pos";

const A = "0a1b2c3d-0000-4000-8000-000000000001";
const B = "0a1b2c3d-0000-4000-8000-000000000002";
const C = "0a1b2c3d-0000-4000-8000-000000000003";
const KEY = "key-12345678";

describe("classifyPosError", () => {
  it.each([
    ["NOT_FOUND", "pos_forbidden"],
    ["FORBIDDEN: folio.charge", "pos_need_folio"],
    ["POLICY_VIOLATION: restaurant pos off", "pos_off"],
    ["POLICY_VIOLATION: name taken", "pos_name_taken"],
    ["POLICY_VIOLATION: limit", "pos_limit"],
    ["POLICY_VIOLATION: too many open orders", "pos_limit"],
    ["POLICY_VIOLATION: too many lines", "pos_limit"],
    ["POLICY_VIOLATION: place off", "pos_place_off"],
    ["POLICY_VIOLATION: item off", "pos_item_off"],
    ["POLICY_VIOLATION: order too large", "pos_too_large"],
    ["POLICY_VIOLATION: nothing to pay", "pos_empty"],
    ["POLICY_VIOLATION: nothing to post", "pos_empty"],
    ["INVALID_STATE: guest not in house", "pos_not_in_house"],
    ["INVALID_STATE: new to ready", "pos_step"],
    ["INVALID_STATE: paid", "pos_closed"],
    ["INVALID_STATE: void", "pos_closed"],
    ["POLICY_VIOLATION: quantity", "pos_invalid"],
    ["IDEMPOTENCY_MISMATCH", "pos_reused"],
    ["something else entirely", "pos_failed"],
  ])("%s -> %s", (message, code) => {
    expect(classifyPosError(message)).toBe(code);
  });
});

describe("parsers", () => {
  it("reads the menu and groups it, dropping what is switched off for the order screen", () => {
    const menu = parseMenu({
      categories: [
        { id: "c1", name: "Mains", sort_order: 1, is_active: true },
        { id: "c2", name: "Old", sort_order: 2, is_active: false },
        { id: "c3", name: "Empty", sort_order: 3, is_active: true },
      ],
      items: [
        { id: "i1", category_id: "c1", name: "Rice", price_minor: 350000, sort_order: 1, is_active: true },
        { id: "i2", category_id: "c1", name: "Off", price_minor: 100, sort_order: 2, is_active: false },
        { id: "i3", category_id: "c2", name: "Gone", price_minor: 100, sort_order: 1, is_active: true },
      ],
      places: [
        { id: "p1", name: "Bar", kind: "bar", is_active: true },
        { id: "p2", name: "X", kind: "weird", is_active: true },
      ],
    });
    expect(menu.places.map((p) => p.kind)).toEqual(["bar", "table"]);
    const order = menuByCategory(menu, true);
    expect(order.map((g) => g.category.name)).toEqual(["Mains"]);
    expect(order[0]?.items.map((i) => i.name)).toEqual(["Rice"]);
    expect(menuByCategory(menu, false)).toHaveLength(3);
  });

  it("survives junk", () => {
    expect(parseMenu(null)).toEqual({ categories: [], items: [], places: [] });
    expect(parseOpenOrders("x")).toEqual([]);
    expect(parseOrder({ id: "x", status: "weird" })).toBeNull();
    expect(parseOrder(null)).toBeNull();
    expect(parseKitchen(undefined)).toEqual([]);
    expect(parseSales({})).toBeNull();
  });

  it("reads an order with its lines", () => {
    const o = parseOrder({
      id: A,
      property_id: B,
      order_no: "POS-000001",
      status: "open",
      place_name: "Table 1",
      guest_label: null,
      currency: "NGN",
      opened_at: "2026-11-19T10:00:00Z",
      subtotal_minor: 1300000,
      tax_minor: 97500,
      total_minor: 1397500,
      estimate: true,
      payment_method: null,
      lines: [{ id: B, name: "Rice", quantity: 2, unit_price_minor: 350000, note: "no pepper", kitchen_status: "preparing" }],
    });
    expect(o?.propertyId).toBe(B);
    expect(o?.estimate).toBe(true);
    expect(o?.totalMinor).toBe(1397500);
    expect(o?.lines[0]).toMatchObject({ name: "Rice", quantity: 2, kitchenStatus: "preparing", note: "no pepper" });
  });

  it("reads the sales report", () => {
    const r = parseSales({
      from: "2026-11-19",
      to: "2026-11-19",
      voided_orders: 2,
      totals: {
        table_orders: 1,
        table_subtotal_minor: 1300000,
        table_tax_minor: 97500,
        table_total_minor: 1397500,
        room_orders: 1,
        room_subtotal_minor: 600000,
        room_tax_minor: 45000,
        room_total_minor: 645000,
      },
      by_day: [{ day: "2026-11-19", orders: 2, table_total_minor: 1397500, room_total_minor: 645000 }],
      table_by_method: [{ method: "cash", orders: 1, total_minor: 1397500 }],
      top_items: [{ name: "Rice", quantity: 2, sales_minor: 700000 }],
    });
    expect(r?.tableTotalMinor).toBe(1397500);
    expect(r?.roomTotalMinor).toBe(645000);
    expect(r?.voidedOrders).toBe(2);
    expect(r?.topItems[0]?.salesMinor).toBe(700000);
  });
});

describe("kitchen steps and waiting time", () => {
  it("offers one next step and none after served", () => {
    expect(KITCHEN_NEXT.new?.to).toBe("preparing");
    expect(KITCHEN_NEXT.preparing?.to).toBe("ready");
    expect(KITCHEN_NEXT.ready?.to).toBe("served");
    expect(KITCHEN_NEXT.served).toBeUndefined();
    expect(KITCHEN_NEXT.cancelled).toBeUndefined();
  });
  it("words the wait", () => {
    const now = new Date("2026-11-19T12:00:00Z");
    expect(waitText("2026-11-19T11:59:40Z", now)).toBe("just now");
    expect(waitText("2026-11-19T11:55:00Z", now)).toBe("5 min");
    expect(waitText("2026-11-19T10:50:00Z", now)).toBe("1 h 10 min");
    expect(waitText("2026-11-19T12:05:00Z", now)).toBe("just now");
    expect(waitText("nonsense", now)).toBe("");
  });
});

describe("form checks", () => {
  it("category", () => {
    expect(parseCategoryForm({ propertyId: A, name: "  Mains ", sort: "3", active: "on" })).toEqual({
      ok: true,
      value: { propertyId: A, categoryId: null, name: "Mains", sort: 3, active: true },
    });
    expect(parseCategoryForm({ propertyId: A, name: "", sort: "1" }).ok).toBe(false);
    expect(parseCategoryForm({ propertyId: A, name: "x", sort: "1001" }).ok).toBe(false);
    expect(parseCategoryForm({ propertyId: "nope", name: "x" }).ok).toBe(false);
    expect(parseCategoryForm({ propertyId: A, name: "x" })).toMatchObject({ ok: true, value: { sort: 0, active: false } });
  });
  it("item turns naira into kobo and refuses a bad price", () => {
    expect(parseItemForm({ propertyId: A, categoryId: B, name: "Rice", price: "₦3,500.50", sort: "1", active: "on" })).toMatchObject({
      ok: true,
      value: { priceMinor: 350050, active: true },
    });
    for (const price of ["", "0", "abc", "1.234", "-5", "10000000.01"])
      expect(parseItemForm({ propertyId: A, categoryId: B, name: "Rice", price }).ok).toBe(false);
    expect(parseItemForm({ propertyId: A, categoryId: B, name: "x".repeat(81), price: "5" }).ok).toBe(false);
    expect(parseItemForm({ propertyId: A, categoryId: B, name: "Rice", price: "10000000" })).toMatchObject({
      ok: true,
      value: { priceMinor: 1_000_000_000 },
    });
  });
  it("place", () => {
    expect(parsePlaceForm({ propertyId: A, name: "Bar", kind: "bar" }).ok).toBe(true);
    expect(parsePlaceForm({ propertyId: A, name: "Bar", kind: "patio" }).ok).toBe(false);
    expect(parsePlaceForm({ propertyId: A, name: "x".repeat(41), kind: "bar" }).ok).toBe(false);
  });
  it("open order needs a real key", () => {
    expect(parseOpenOrderForm({ propertyId: A, placeId: B, label: "Mr Ade", key: KEY })).toMatchObject({
      ok: true,
      value: { label: "Mr Ade" },
    });
    expect(parseOpenOrderForm({ propertyId: A, placeId: B, label: "", key: KEY })).toMatchObject({ ok: true, value: { label: null } });
    expect(parseOpenOrderForm({ propertyId: A, placeId: B, key: "short" }).ok).toBe(false);
    expect(parseOpenOrderForm({ propertyId: A, placeId: B, key: "has space in it" }).ok).toBe(false);
    expect(parseOpenOrderForm({ propertyId: A, placeId: B, label: "x".repeat(61), key: KEY }).ok).toBe(false);
  });
  it("line", () => {
    expect(parseLineForm({ orderId: A, itemId: B, quantity: "3", note: " no ice ", key: KEY })).toMatchObject({
      ok: true,
      value: { quantity: 3, note: "no ice" },
    });
    expect(parseLineForm({ orderId: A, itemId: B, key: KEY })).toMatchObject({ ok: true, value: { quantity: 1 } });
    for (const quantity of ["0", "101", "1.5", "x"]) expect(parseLineForm({ orderId: A, itemId: B, quantity, key: KEY }).ok).toBe(false);
    expect(parseLineForm({ orderId: A, itemId: B, note: "x".repeat(101), key: KEY }).ok).toBe(false);
  });
  it("status refuses new and anything unknown, and only two places to return to", () => {
    expect(parseStatusForm({ lineId: A, orderId: B, status: "ready", back: "kitchen" })).toMatchObject({
      ok: true,
      value: { back: "kitchen" },
    });
    expect(parseStatusForm({ lineId: A, status: "ready", back: "elsewhere" })).toMatchObject({ ok: true, value: { back: "order" } });
    expect(parseStatusForm({ lineId: A, status: "new" }).ok).toBe(false);
    expect(parseStatusForm({ lineId: A, status: "deleted" }).ok).toBe(false);
    expect(parseStatusForm({ lineId: "x", status: "ready" }).ok).toBe(false);
  });
  it("pay, post and void", () => {
    expect(parsePayForm({ orderId: A, method: "pos", reference: " slip 7 ", key: KEY })).toMatchObject({
      ok: true,
      value: { method: "pos", reference: "slip 7" },
    });
    expect(parsePayForm({ orderId: A, method: "crypto", key: KEY }).ok).toBe(false);
    expect(parsePayForm({ orderId: A, method: "cash", reference: "r".repeat(101), key: KEY }).ok).toBe(false);
    expect(parsePostForm({ orderId: A, reservationId: C, key: KEY }).ok).toBe(true);
    expect(parsePostForm({ orderId: A, reservationId: "x", key: KEY }).ok).toBe(false);
    expect(parseVoidForm({ orderId: A, reason: " wrong table " })).toMatchObject({ ok: true, value: { reason: "wrong table" } });
    expect(parseVoidForm({ orderId: A, reason: "" }).ok).toBe(false);
    expect(parseVoidForm({ orderId: A, reason: "x".repeat(201) }).ok).toBe(false);
  });
});

describe("parseDay", () => {
  it("accepts a real date and falls back otherwise", () => {
    expect(parseDay("2026-11-19", "2026-01-01")).toBe("2026-11-19");
    expect(parseDay("2026-02-30", "2026-01-01")).toBe("2026-01-01");
    expect(parseDay("19/11/2026", "2026-01-01")).toBe("2026-01-01");
    expect(parseDay(undefined, "2026-01-01")).toBe("2026-01-01");
  });
});
