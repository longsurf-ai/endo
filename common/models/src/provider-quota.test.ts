// Purpose: Locks the provider-agnostic plan quota schema and the meaning of unknown values.
import { describe, expect, it } from "vitest";
import { ProviderQuota, QuotaMeter } from "./provider-quota";

const weekly: QuotaMeter = {
  scope: { kind: "account" },
  window: { kind: "duration", minutes: 10080 },
  usage: { kind: "percent", usedPercent: 20 },
  resetsAt: "2026-09-27T15:00:00.265Z",
};

describe("plan quota schemas", () => {
  it("represents both native providers without provider-specific fields", () => {
    const claude = {
      status: "ready",
      plan: "max",
      meters: [
        {
          scope: { kind: "account" },
          window: { kind: "duration", minutes: 300 },
          usage: { kind: "percent", usedPercent: 12 },
          resetsAt: "2026-09-24T23:40:00.265Z",
        },
        weekly,
        {
          ...weekly,
          scope: { kind: "model", name: "Fable" },
          usage: { kind: "percent", usedPercent: 36 },
        },
        {
          scope: { kind: "account" },
          window: { kind: "month" },
          usage: { kind: "spend", used: 0, limit: 200, currency: "USD" },
        },
      ],
    };
    const codex = {
      status: "ready",
      plan: "pro",
      blocked: false,
      meters: [{ ...weekly, usage: { kind: "percent", usedPercent: 98 } }],
    };

    expect(ProviderQuota.safeParse(claude).success).toBe(true);
    expect(ProviderQuota.safeParse(codex).success).toBe(true);
    expect(ProviderQuota.safeParse({ status: "not_applicable" }).success).toBe(
      true,
    );
    expect(QuotaMeter.safeParse({ ...weekly, label: "Weekly" }).success).toBe(
      false,
    );
  });

  it("keeps unknown values omitted rather than zero or empty", () => {
    const unknown = QuotaMeter.parse({ scope: { kind: "account" } });

    expect(unknown).not.toHaveProperty("usage");
    expect(unknown).not.toHaveProperty("resetsAt");
  });

  it("reports spend in one unit with a positive cap", () => {
    const spend = { kind: "spend", used: 0, limit: 200, currency: "USD" };

    expect(
      QuotaMeter.safeParse({
        ...weekly,
        usage: { ...spend, usedPercent: 0 },
      }).success,
    ).toBe(false);
    expect(
      QuotaMeter.safeParse({ ...weekly, usage: { ...spend, limit: 0 } })
        .success,
    ).toBe(false);
  });

  it("requires UTC instants", () => {
    expect(
      QuotaMeter.safeParse({
        ...weekly,
        resetsAt: "2026-09-27T15:00:00.265911+00:00",
      }).success,
    ).toBe(false);
  });
});
