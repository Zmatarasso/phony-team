/**
 * Weather service — returns fake weather data.
 * Structured so a real API (e.g. OpenWeatherMap) can be plugged in later.
 */

export interface WeatherResponse {
  location: string;
  temperature_f: number;
  temperature_c: number;
  condition: string;
  humidity_percent: number;
  wind_mph: number;
  wind_direction: string;
  label: string;
}

const FAKE_CONDITIONS = [
  "Sunny",
  "Partly Cloudy",
  "Cloudy",
  "Rainy",
  "Thunderstorm",
  "Snowy",
  "Foggy",
  "Windy",
] as const;

const WIND_DIRECTIONS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

/**
 * Returns deterministic fake weather based on the current hour so it feels
 * semi-realistic without hitting any external API.
 */
export function getWeather(): WeatherResponse {
  const hour = new Date().getHours();

  // Temperature varies by time of day (cooler at night, warmer midday)
  const baseTempF = 55 + Math.round(15 * Math.sin(((hour - 6) / 24) * Math.PI * 2));
  const tempC = Math.round(((baseTempF - 32) * 5) / 9);

  const conditionIndex = hour % FAKE_CONDITIONS.length;
  const windDirIndex = hour % WIND_DIRECTIONS.length;

  return {
    location: "New York, NY",
    temperature_f: baseTempF,
    temperature_c: tempC,
    condition: FAKE_CONDITIONS[conditionIndex]!,
    humidity_percent: 40 + (hour % 5) * 10,
    wind_mph: 5 + (hour % 8) * 2,
    wind_direction: WIND_DIRECTIONS[windDirIndex]!,
    label: "WEATH",
  };
}
