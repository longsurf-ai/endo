// Purpose: Locks compact monotonic suffix generation and domain identifier contracts.

import { Schema } from "effect";
import { describe, expect, expectTypeOf, test, vi } from "vitest";

import * as Identifier from "./identifier";

describe("Identifier", () => {
  test("shares prefix validation, branding, and generation in one domain schema", () => {
    const DashboardId = Identifier.defineId("dsh", "Dashboard.ID");
    const SessionId = Identifier.defineId("ses", "Session.ID", "descending");
    const first = DashboardId.create();
    const second = DashboardId.create();
    const session = SessionId.create();
    expect(first).toMatch(/^dsh_[0-9A-Za-z]{14}$/);
    expect(first < second).toBe(true);
    expect(session > SessionId.create()).toBe(true);
    expect(Schema.decodeUnknownSync(DashboardId)(first)).toBe(first);
    expect(() => Schema.decodeUnknownSync(DashboardId)(session)).toThrow();
    expect(() => DashboardId.make("unprefixed")).toThrow();
    expect(Schema.encodeSync(DashboardId)(first)).toBe(first);
    expectTypeOf<typeof DashboardId.Type>().not.toEqualTypeOf<
      typeof SessionId.Type
    >();
  });

  test("uses Web Crypto only when minting, never when declaring a schema", () => {
    const random = vi.spyOn(globalThis.crypto, "getRandomValues");
    try {
      const Id = Identifier.defineId("test", "Test.ID");
      expect(random).not.toHaveBeenCalled();
      Id.create();
      expect(random).toHaveBeenCalledOnce();
      expect(random.mock.calls[0]?.[0]).toBeInstanceOf(Uint8Array);
    } finally {
      random.mockRestore();
    }
  });

  test("creates compact prefix-free Base62 suffixes", () => {
    expect(Identifier.ascending()).toMatch(/^[0-9A-Za-z]{14}$/);
    expect(Identifier.descending()).toMatch(/^[0-9A-Za-z]{14}$/);
  });

  test("orders ascending suffixes within the same millisecond", () => {
    const timestamp = 10_000_000_001_000;
    const first = Identifier.create(false, timestamp);
    const second = Identifier.create(false, timestamp);
    const third = Identifier.create(false, timestamp);

    expect(first < second).toBe(true);
    expect(second < third).toBe(true);
  });

  test("orders descending suffixes within the same millisecond", () => {
    const timestamp = 10_000_000_002_000;
    const first = Identifier.create(true, timestamp);
    const second = Identifier.create(true, timestamp);
    const third = Identifier.create(true, timestamp);

    expect(first > second).toBe(true);
    expect(second > third).toBe(true);
  });

  test("advances logical time after fifteen IDs in one millisecond", () => {
    const timestamp = 10_000_000_003_000;
    const ids = Array.from({ length: 17 }, () =>
      Identifier.create(false, timestamp),
    );

    expect(ids).toEqual([...ids].sort());
  });

  test("does not move backward when wall time regresses", () => {
    const first = Identifier.create(false, 10_000_000_004_000);
    const second = Identifier.create(false, 10_000_000_003_999);

    expect(first < second).toBe(true);
  });
});
