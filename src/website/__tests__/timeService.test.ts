import { getCurrentTime } from "../timeService.js";
import type { TimeResponse } from "../timeService.js";

describe("getCurrentTime", () => {
  it("returns a TimeResponse with the correct shape", () => {
    const result: TimeResponse = getCurrentTime();

    expect(result).toHaveProperty("timezone");
    expect(result).toHaveProperty("datetime");
    expect(result).toHaveProperty("unix_timestamp");
    expect(result).toHaveProperty("utc_offset");
    expect(result).toHaveProperty("label");
  });

  it("has label 'TIME'", () => {
    const result = getCurrentTime();
    expect(result.label).toBe("TIME");
  });

  it("returns a valid ISO 8601 datetime string", () => {
    const result = getCurrentTime();
    const parsed = new Date(result.datetime);
    expect(parsed.getTime()).not.toBeNaN();
  });

  it("returns a unix timestamp close to now", () => {
    const before = Math.floor(Date.now() / 1000);
    const result = getCurrentTime();
    const after = Math.floor(Date.now() / 1000);
    expect(result.unix_timestamp).toBeGreaterThanOrEqual(before);
    expect(result.unix_timestamp).toBeLessThanOrEqual(after);
  });

  it("returns a utc_offset in ±HH:MM format", () => {
    const result = getCurrentTime();
    expect(result.utc_offset).toMatch(/^[+-]\d{2}:\d{2}$/);
  });

  it("returns a non-empty timezone string", () => {
    const result = getCurrentTime();
    expect(typeof result.timezone).toBe("string");
    expect(result.timezone.length).toBeGreaterThan(0);
  });
});
