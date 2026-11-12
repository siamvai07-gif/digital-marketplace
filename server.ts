import express from 'express';
import { createServer } from 'http';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  const HOST = process.env.HOST || '0.0.0.0';
  const isProd = process.env.NODE_ENV === 'production';

  // Friendly health endpoint used by hosting platforms / uptime checks.
  app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));

  // One HTTP server for both app traffic and HMR.
  // In middleware mode Vite otherwise opens its own standalone WebSocket listener on a
  // second port. That listener answers plain HTTP with "426 Upgrade Required", so a preview
  // pointed at it can never load the app. Sharing this server keeps everything on PORT.
  const httpServer = createServer(app);

  if (!isProd) {
    // HMR is attached to our HTTP server so everything stays on one port.
    // Configuring `server.hmr` (rather than the newer `server.ws`) keeps this compatible
    // with Vite 5/6/7/8. Without it, middleware mode binds a standalone WS listener on
    // Vite's hardcoded default port 24678 — which answers plain HTTP with
    // "426 Upgrade Required", so a preview pointed at that port can never load the app.
    // Critically, `hmr: false` is NOT a valid fallback here: it leaves that port
    // unspecified, Vite still grabs 24678, and binding it there fails with EADDRINUSE
    // whenever PORT is also 24678.
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        // Accept any proxy/preview host instead of only localhost.
        allowedHosts: true,
        // Attach the HMR WebSocket to our HTTP server (Vite 8: `server.ws`).
        ws: { server: httpServer },
      },
      appType: 'mpa',
    });
    // Serve /admin without the trailing slash (Vite's MPA mode 404s on it).
    app.use((req, _res, next) => {
      if (req.url === '/admin') req.url = '/admin/index.html';
      next();
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get(['/admin', '/admin/*'], (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'admin', 'index.html'));
    });
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  httpServer.listen(PORT, HOST, () => {
    console.log(`Server running on http://${HOST}:${PORT}`);
  });
}

startServer();
