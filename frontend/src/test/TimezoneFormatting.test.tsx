import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_APP_TIMEZONE,
  formatDate,
  formatDateTime,
  formatLocalDateTime,
  formatTime,
  getAppTimeZone,
} from "@/lib/utils";

describe("Asia/Manila timezone formatting utilities", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to Asia/Manila and falls back safely on invalid VITE_APP_TIMEZONE", () => {
    expect(getAppTimeZone()).toBe(DEFAULT_APP_TIMEZONE);

    vi.stubEnv("VITE_APP_TIMEZONE", "America/New_York");
    expect(getAppTimeZone()).toBe("America/New_York");

    vi.stubEnv("VITE_APP_TIMEZONE", "Invalid/Timezone_Name");
    expect(getAppTimeZone()).toBe("Asia/Manila");
  });

  it("converts UTC and explicit offset timestamps accurately to Asia/Manila without double offset", () => {
    const utcZ = formatDateTime("2026-11-17T13:11:46Z");
    const utcPlus0 = formatDateTime("2026-11-17T13:11:46+00:00");
    const plus2 = formatDateTime("2026-11-17T15:11:46+02:00");
    const minus5 = formatDateTime("2026-11-17T08:11:46-05:00");
    const alreadyManila = formatDateTime("2026-11-17T21:11:46+08:00");
    const naiveUtc = formatDateTime("2026-11-17T13:11:46");

    expect(utcZ).toBe(utcPlus0);
    expect(utcZ).toBe(plus2);
    expect(utcZ).toBe(minus5);
    expect(utcZ).toBe(alreadyManila);
    expect(utcZ).toBe(naiveUtc);
    expect(formatLocalDateTime("2026-11-17T13:11:46Z")).toBe(utcZ);

    // 13:11:46 UTC = 21:11:46 (9:11:46 PM) in Asia/Manila, not +16h
    expect(utcZ).toContain("9:11:46");
    expect(utcZ).toContain("PM");
  });

  it("handles UTC midnight crossing into the next calendar day in Asia/Manila", () => {
    // 2026-11-17T18:30:00Z = 2026-11-18 02:30:00 AM in Asia/Manila (+08:00)
    const formattedDate = formatDate("2026-11-17T18:30:00Z");
    const formattedTime = formatTime("2026-11-17T18:30:00Z");

    expect(formattedDate).toContain("18");
    expect(formattedDate).toContain("2026");
    expect(formattedTime).toContain("2:30:00");
    expect(formattedTime).toContain("AM");
  });

  it("returns em dash for null, undefined, empty, or invalid timestamps", () => {
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime(undefined)).toBe("—");
    expect(formatDateTime("")).toBe("—");
    expect(formatDateTime("   ")).toBe("—");
    expect(formatDateTime("not-a-timestamp")).toBe("—");
    expect(formatDate("bad-date")).toBe("—");
    expect(formatTime("bad-date")).toBe("—");
  });
});
