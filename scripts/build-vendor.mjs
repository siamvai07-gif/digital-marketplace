/**
 * Builds public/vendor/supabase.js as a single self-contained IIFE.
 *
 * The prebuilt UMD file from npm is a webpack *code-split* bundle: it needs a
 * detectable publicPath and can lazily fetch a companion chunk (591.supabase.js)
 * that we do not ship. Bundling the ESM entry with esbuild removes that runtime
 * chunk loading entirely, so the client is one file with no extra requests.
 *
 * Run: node scripts/build-vendor.mjs
 */
import { build } from 'esbuild';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

await build({
  entryPoints: [path.join(root, 'node_modules/@supabase/supabase-js/dist/module/index.js')],
  bundle: true,
  format: 'iife',
  globalName: 'supabase',
  platform: 'browser',
  target: ['es2020'],
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
  outfile: path.join(root, 'public/vendor/supabase.js'),
  logLevel: 'info',
});

console.log('built public/vendor/supabase.js');
