import request from "supertest";
import { createApp, startWebsiteServer } from "../websiteServer.js";

describe("Website API - /api/time", () => {
  const app = createApp();

  it("returns 200 with correct shape", async () => {
    const res = await request(app).get("/api/time");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("timezone");
    expect(res.body).toHaveProperty("datetime");
    expect(res.body).toHaveProperty("unix_timestamp");
    expect(res.body).toHaveProperty("utc_offset");
    expect(res.body).toHaveProperty("label", "TIME");
  });

  it("returns a valid ISO datetime", async () => {
    const res = await request(app).get("/api/time");
    const parsed = new Date(res.body["datetime"] as string);
    expect(parsed.getTime()).not.toBeNaN();
  });
});

describe("Website API - /api/weather", () => {
  const app = createApp();

  it("returns 200 with correct shape", async () => {
    const res = await request(app).get("/api/weather");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("location");
    expect(res.body).toHaveProperty("temperature_f");
    expect(res.body).toHaveProperty("temperature_c");
    expect(res.body).toHaveProperty("condition");
    expect(res.body).toHaveProperty("humidity_percent");
    expect(res.body).toHaveProperty("wind_mph");
    expect(res.body).toHaveProperty("wind_direction");
    expect(res.body).toHaveProperty("label", "WEATH");
  });

  it("returns numeric temperatures", async () => {
    const res = await request(app).get("/api/weather");
    expect(typeof res.body["temperature_f"]).toBe("number");
    expect(typeof res.body["temperature_c"]).toBe("number");
  });
});

describe("Website - GET / (frontend)", () => {
  const app = createApp();

  it("returns 200 with HTML content", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
  });

  it("HTML contains React script references", async () => {
    const res = await request(app).get("/");
    expect(res.text).toContain("react");
    expect(res.text).toContain("ReactDOM");
  });

  it("HTML contains Time & Weather title", async () => {
    const res = await request(app).get("/");
    expect(res.text).toContain("Time &amp; Weather");
  });

  it("HTML contains fetch calls to /api/time and /api/weather", async () => {
    const res = await request(app).get("/");
    expect(res.text).toContain("/api/time");
    expect(res.text).toContain("/api/weather");
  });

  it("HTML contains an ASCII cat picture", async () => {
    const res = await request(app).get("/");
    expect(res.text).toContain("ascii-cat");
    expect(res.text).toContain("CatAscii");
    expect(res.text).toContain("( o.o )");
  });
});

describe("Website - 404 handling", () => {
  const app = createApp();

  it("returns 404 JSON for unknown routes", async () => {
    const res = await request(app).get("/nonexistent");
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
    expect(res.body["error"]).toHaveProperty("code", "not_found");
  });
});

describe("Website server start/stop", () => {
  it("starts on a dynamic port and stops cleanly", async () => {
    const srv = await startWebsiteServer(0);
    try {
      expect(srv.port).toBeGreaterThan(0);
      const res = await request(`http://127.0.0.1:${srv.port}`).get("/api/time");
      expect(res.status).toBe(200);
    } finally {
      await srv.stop();
    }
  });

  it("serves the frontend through the running server", async () => {
    const srv = await startWebsiteServer(0);
    try {
      const res = await request(`http://127.0.0.1:${srv.port}`).get("/");
      expect(res.status).toBe(200);
      expect(res.text).toContain("Time");
    } finally {
      await srv.stop();
    }
  });
});
