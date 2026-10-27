import { describe, expect, it } from "vitest";
import { computeSlots, meetingOptions } from "@/lib/calendar";

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

describe("meetingOptions", () => {
  it("offers one time a day, morning and afternoon in turn, the way the AI writes them", () => {
    // Monday 26/10/2026 07:00 in São Paulo
    const slots = computeSlots({ now: new Date("2026-10-26T10:00:00Z"), hours, minutes: 30, busy: [], days: 7, limit: 120 });
    expect(meetingOptions(slots)).toBe(["1) segunda, 26/10, às 09:00", "2) terça, 27/10, às 14:00", "3) quarta, 28/10, às 09:00"].join("\n"));
  });

  it("fills in from the same day when the agenda has few free days, and is empty when it has none", () => {
    const now = new Date("2026-10-26T10:00:00Z");
    const oneDay = computeSlots({ now, hours, minutes: 30, busy: [], days: 1, limit: 120 });
    expect(meetingOptions(oneDay)).toBe(["1) segunda, 26/10, às 09:00", "2) segunda, 26/10, às 09:30", "3) segunda, 26/10, às 10:00"].join("\n"));
    expect(meetingOptions([])).toBe("");
  });
});
