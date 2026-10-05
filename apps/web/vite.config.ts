import tailwindcss from '@tailwindcss/vite';
import devtoolsJson from 'vite-plugin-devtools-json';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type PluginOption } from 'vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit() as unknown as PluginOption, devtoolsJson()],
	// SQLite, harper.js and mrml resolve WASM relative to their own files. Dep
	// pre-bundling rewrites those paths to `.vite/deps/` where the binary isn't
	// copied, so it 404s in dev. Excluding them serves the packages from
	// node_modules with their wasm alongside. (They are dynamically imported, so
	// exclusion costs nothing.)
	optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm', 'harper.js', 'harper.js/binary', 'mrml', 'mrml/web/mrml_wasm.js'] }
});
