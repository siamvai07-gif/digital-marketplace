import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig, type Plugin, type ViteDevServer, type PreviewServer } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Serve `/admin` (no trailing slash) as the admin panel.
 * Without this rewrite both the dev server and `vite preview` return 404.
 */
function adminRoutePlugin(): Plugin {
  const rewrite = (req: { url?: string }, _res: unknown, next: () => void) => {
    if (req.url === '/admin' || req.url === '/admin/') {
      req.url = '/admin/index.html';
    }
    next();
  };
  return {
    name: 'admin-route-rewrite',
    configureServer(server: ViteDevServer) {
      server.middlewares.use(rewrite);
    },
    configurePreviewServer(server: PreviewServer) {
      server.middlewares.use(rewrite);
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), adminRoutePlugin()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, 'index.html'),
          admin: path.resolve(__dirname, 'admin/index.html'),
        },
      },
    },
    server: {
      // Allow preview/proxy hosts (Arena sandbox, tunnels, custom domains).
      // `true` accepts any Host header (Arena preview, tunnels, custom domains).
      allowedHosts: true as const,
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
    preview: {
      // `true` accepts any Host header (Arena preview, tunnels, custom domains).
      allowedHosts: true as const,
    },
  };
});
