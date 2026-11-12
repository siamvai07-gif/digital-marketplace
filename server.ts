import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  const isProd = process.env.NODE_ENV === 'production';

  // Friendly health endpoint used by hosting platforms / uptime checks.
  app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));

  if (!isProd) {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        // Accept any proxy/preview host instead of only localhost.
        allowedHosts: true,
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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
