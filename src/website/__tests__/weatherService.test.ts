import { getWeather } from "../weatherService.js";
import type { WeatherResponse } from "../weatherService.js";

describe("getWeather", () => {
  it("returns a WeatherResponse with the correct shape", () => {
    const result: WeatherResponse = getWeather();

    expect(result).toHaveProperty("location");
    expect(result).toHaveProperty("temperature_f");
    expect(result).toHaveProperty("temperature_c");
    expect(result).toHaveProperty("condition");
    expect(result).toHaveProperty("humidity_percent");
    expect(result).toHaveProperty("wind_mph");
    expect(result).toHaveProperty("wind_direction");
    expect(result).toHaveProperty("label");
  });

  it("has label 'WEATH'", () => {
    const result = getWeather();
    expect(result.label).toBe("WEATH");
  });

  it("returns a non-empty location string", () => {
    const result = getWeather();
    expect(typeof result.location).toBe("string");
    expect(result.location.length).toBeGreaterThan(0);
  });

  it("returns numeric temperatures", () => {
    const result = getWeather();
    expect(typeof result.temperature_f).toBe("number");
    expect(typeof result.temperature_c).toBe("number");
  });

  it("returns temperature_c that is consistent with temperature_f", () => {
    const result = getWeather();
    const expectedC = Math.round(((result.temperature_f - 32) * 5) / 9);
    expect(result.temperature_c).toBe(expectedC);
  });

  it("returns a known weather condition", () => {
    const knownConditions = [
      "Sunny",
      "Partly Cloudy",
      "Cloudy",
      "Rainy",
      "Thunderstorm",
      "Snowy",
      "Foggy",
      "Windy",
    ];
    const result = getWeather();
    expect(knownConditions).toContain(result.condition);
  });

  it("returns humidity as a percentage between 0 and 100", () => {
    const result = getWeather();
    expect(result.humidity_percent).toBeGreaterThanOrEqual(0);
    expect(result.humidity_percent).toBeLessThanOrEqual(100);
  });

  it("returns a valid wind direction", () => {
    const validDirections = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    const result = getWeather();
    expect(validDirections).toContain(result.wind_direction);
  });

  it("returns a positive wind speed", () => {
    const result = getWeather();
    expect(result.wind_mph).toBeGreaterThanOrEqual(0);
  });
});
