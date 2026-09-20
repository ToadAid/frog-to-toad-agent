import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The repo mirror (data/sandbox/repo/) is a READ COPY for the agents — its
    // tests must never be discovered; a stale-mirror failure must never read
    // as a live-suite failure.
    exclude: ['**/node_modules/**', 'data/**', 'kronos-server/venv/**', 'cobo-wallet-server/venv/**'],
  },
})