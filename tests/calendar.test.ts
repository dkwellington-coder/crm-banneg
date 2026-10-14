import { describe, expect, it } from "vitest";
import { computeSlots } from "@/lib/calendar";

const hours = { start: 9, end: 18, days: [1, 2, 3, 4, 5], timezone: "America/Sao_Paulo" };

describe("computeSlots", () => {
  it("offers slots only inside business hours in São Paulo time", () => {
    // Wednesday 14/10/2026 08:00 in São Paulo (11:00 UTC)
    const now = new Date("2026-10-14T11:00:00Z");
    const slots = computeSlots({ now, hours, minutes: 30, busy: [], limit: 50, days: 3 });
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      const localHour = (s.startsAt.getUTCHours() + 21) % 24;
      expect(localHour).toBeGreaterThanOrEqual(9);
      expect(localHour).toBeLessThan(18);
    }
    // First slot is at least 2 hours away
    expect(slots[0].startsAt.getTime() - now.getTime()).toBeGreaterThanOrEqual(2 * 3600_000);
  });

  it("skips weekends", () => {
    // Saturday 17/10/2026 10:00 in São Paulo
    const now = new Date("2026-10-17T13:00:00Z");
    const [first] = computeSlots({ now, hours, minutes: 30, busy: [] });
    // Monday
    expect(new Date(first.startsAt.getTime() - 3 * 3600_000).getUTCDay()).toBe(1);
  });

  it("skips busy meetings", () => {
    const now = new Date("2026-10-14T11:00:00Z");
    const all = computeSlots({ now, hours, minutes: 30, busy: [] });
    const busy = [{ startsAt: all[0].startsAt, endsAt: all[0].endsAt }];
    const free = computeSlots({ now, hours, minutes: 30, busy });
    expect(free[0].startsAt).toEqual(all[1].startsAt);
  });
});
