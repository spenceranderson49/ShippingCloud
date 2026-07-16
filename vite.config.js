import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    target: 'es2020',
    // Split rarely-changing dependencies into their own long-cached chunks. The app bundle
    // (index-*.js) gets a fresh hash on every deploy, but react / lucide icons / qrcode keep
    // theirs as long as the dep versions don't change — so a reload after a deploy only
    // re-downloads the app chunk, not the whole ~1.4 MB every time.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('lucide')) return 'icons';        // before the react check — lucide-react's path contains "react"
          if (id.includes('qrcode')) return 'vendor';
          if (id.includes('react') || id.includes('scheduler')) return 'react';
          return 'vendor';
        },
      },
    },
  },
});
