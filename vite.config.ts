import { defineConfig, type Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Writes dist/sw.js with every built file in its precache list and a version from their contents. */
function precache(): Plugin {
  let outDir = 'dist';
  return {
    name: 'droneon-precache',
    apply: 'build',
    configResolved(c) { outDir = c.build.outDir; },
    closeBundle() {
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const n of readdirSync(dir)) {
          const p = join(dir, n);
          const st = statSync(p);
          if (st.isDirectory()) walk(p);
          // skip the worker itself, source maps and anything too big for a first visit;
          // legacy font formats (ttf, woff, svg) are only fallbacks, every browser that runs WebGL2 takes woff2
          // og.jpg is only for link previews and debug only runs with #debug
          else if (n !== 'sw.js' && n !== 'og.jpg' && !/^debug-/.test(n) && !/\.(map|ttf|woff|svg|eot)$/.test(n) && st.size < 6e6) files.push(p);
        }
      };
      walk(outDir);
      const hash = createHash('sha256');
      for (const f of files.sort()) hash.update(f).update(readFileSync(f));
      const urls = ['./', ...files.map(f => './' + relative(outDir, f).split('\\').join('/'))];
      const sw = readFileSync('tools/sw-template.js', 'utf8')
        .replace('__VERSION__', hash.digest('hex').slice(0, 12))
        .replace('__ASSETS__', JSON.stringify(urls));
      writeFileSync(join(outDir, 'sw.js'), sw);
    },
  };
}

// BASE is set by the GitHub Pages workflow to /<repo>/, local dev uses /
export default defineConfig({
  base: process.env.BASE ?? '/',
  build: { target: 'es2022', chunkSizeWarningLimit: 1500, assetsInlineLimit: 0 },
  server: { port: 5190 },
  // worktrees share one node_modules through a junction: keep its path inside the project so the dev server may serve fonts from it
  resolve: { preserveSymlinks: true },
  plugins: [precache()],
});
