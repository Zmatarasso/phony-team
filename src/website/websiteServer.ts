import express, { type Request, type Response, type NextFunction } from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { getCurrentTime } from "./timeService.js";
import { getWeather } from "./weatherService.js";

// --- HTML template with inline React (loaded from CDN) ---

function renderApp(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Time &amp; Weather</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #000000;
      color: #e0e0e0;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
    }
    #root { width: 100%; max-width: 900px; padding: 2rem; }
    h1 {
      text-align: center;
      font-size: 2.5rem;
      margin-bottom: 2rem;
      color: #e94560;
    }
    .widgets {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 2rem;
    }
    @media (max-width: 640px) {
      .widgets { grid-template-columns: 1fr; }
    }
    .widget {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 16px;
      padding: 2rem;
      backdrop-filter: blur(10px);
      transition: transform 0.2s;
    }
    .widget:hover { transform: translateY(-4px); }
    .widget-label {
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 2px;
      color: #e94560;
      margin-bottom: 1rem;
    }
    .widget-main {
      font-size: 2.2rem;
      font-weight: 700;
      margin-bottom: 0.5rem;
    }
    .widget-sub {
      font-size: 0.95rem;
      color: #a0a0a0;
      line-height: 1.6;
    }
    .loading { color: #a0a0a0; font-style: italic; }
    .error { color: #e94560; }
  </style>
</head>
<body>
  <div id="root"></div>

  <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script>
    const e = React.createElement;

    function TimeWidget() {
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState(null);

      React.useEffect(function () {
        function fetchTime() {
          fetch('/api/time')
            .then(function (r) { return r.json(); })
            .then(function (d) { setData(d); setError(null); })
            .catch(function (err) { setError(err.message); });
        }
        fetchTime();
        var id = setInterval(fetchTime, 1000);
        return function () { clearInterval(id); };
      }, []);

      if (error) {
        return e('div', { className: 'widget' },
          e('div', { className: 'widget-label' }, 'TIME'),
          e('div', { className: 'error' }, 'Error: ' + error)
        );
      }

      if (!data) {
        return e('div', { className: 'widget' },
          e('div', { className: 'widget-label' }, 'TIME'),
          e('div', { className: 'loading' }, 'Loading...')
        );
      }

      var dt = new Date(data.datetime);
      var timeStr = dt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      var dateStr = dt.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

      return e('div', { className: 'widget' },
        e('div', { className: 'widget-label' }, data.label),
        e('div', { className: 'widget-main' }, timeStr),
        e('div', { className: 'widget-sub' },
          dateStr,
          e('br'),
          data.timezone + ' (UTC' + data.utc_offset + ')'
        )
      );
    }

    function WeatherWidget() {
      var _s = React.useState(null), data = _s[0], setData = _s[1];
      var _e = React.useState(null), error = _e[0], setError = _e[1];

      React.useEffect(function () {
        function fetchWeather() {
          fetch('/api/weather')
            .then(function (r) { return r.json(); })
            .then(function (d) { setData(d); setError(null); })
            .catch(function (err) { setError(err.message); });
        }
        fetchWeather();
        var id = setInterval(fetchWeather, 60000);
        return function () { clearInterval(id); };
      }, []);

      if (error) {
        return e('div', { className: 'widget' },
          e('div', { className: 'widget-label' }, 'WEATH'),
          e('div', { className: 'error' }, 'Error: ' + error)
        );
      }

      if (!data) {
        return e('div', { className: 'widget' },
          e('div', { className: 'widget-label' }, 'WEATH'),
          e('div', { className: 'loading' }, 'Loading...')
        );
      }

      return e('div', { className: 'widget' },
        e('div', { className: 'widget-label' }, data.label),
        e('div', { className: 'widget-main' }, data.temperature_f + '\\u00B0F'),
        e('div', { className: 'widget-sub' },
          data.condition + ' \\u2022 ' + data.temperature_c + '\\u00B0C',
          e('br'),
          data.location,
          e('br'),
          'Humidity: ' + data.humidity_percent + '%',
          e('br'),
          'Wind: ' + data.wind_mph + ' mph ' + data.wind_direction
        )
      );
    }

    function App() {
      return e('div', null,
        e('h1', null, '\\u23F0 Time & Weather'),
        e('div', { className: 'widgets' },
          e(TimeWidget),
          e(WeatherWidget)
        )
      );
    }

    ReactDOM.createRoot(document.getElementById('root')).render(e(App));
  </script>
</body>
</html>`;
}

// --- Error helpers ---

interface ErrorEnvelope {
  error: { code: string; message: string };
}

function errorJson(code: string, message: string): ErrorEnvelope {
  return { error: { code, message } };
}

// --- Express app factory (exported for testing) ---

export function createApp(): express.Express {
  const app = express();
  app.use(express.json());

  // API: current time
  app.get("/api/time", (_req: Request, res: Response) => {
    res.json(getCurrentTime());
  });

  // API: current weather (fake)
  app.get("/api/weather", (_req: Request, res: Response) => {
    res.json(getWeather());
  });

  // Serve the React SPA
  app.get("/", (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderApp());
  });

  // 404 fallback
  app.use((_req: Request, res: Response) => {
    res.status(404).json(errorJson("not_found", "Route not found"));
  });

  // Error handler
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json(errorJson("internal_error", "Internal server error"));
  });

  return app;
}

// --- Server start/stop ---

export interface WebsiteServer {
  readonly port: number;
  stop(): Promise<void>;
}

export async function startWebsiteServer(port: number): Promise<WebsiteServer> {
  const app = createApp();
  const server: Server = app.listen(port, "127.0.0.1");

  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  const actualPort = (server.address() as AddressInfo).port;

  return {
    port: actualPort,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
