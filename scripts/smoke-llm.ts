/**
 * One real LLM request — verifies AUTH for whatever brain .env points at.
 *
 *   npm run smoke:llm                          # uses .env as-is
 *   LLM_PROVIDER=openai LLM_API_KEY=sk-… npm run smoke:llm
 *   LLM_PROVIDER=ollama npm run smoke:llm      # needs `ollama serve` running
 *   BRAIN=codex npm run smoke:llm              # needs `npm run desk login` first
 *
 * Prints the model's reply + token usage, exits non-zero on auth/HTTP failure.
 */
import { loadConfig, describeConfig } from '../src/config.js'
import { createLlmClient } from '../src/llm/client.js'
import { log } from '../src/log.js'

const cfg = loadConfig()
console.log(describeConfig(cfg))
console.log('\n— smoke:llm — sending one test completion…')

try {
  // Same brain seam as src/index.ts — the codex lane answers for BRAIN=codex.
  const llm = cfg.brain === 'codex'
    ? await import('../src/llm/codex.js').then((m) => m.createCodexLlmClient(cfg))
    : createLlmClient(cfg)
  const res = await llm.complete({
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
  })
  const text = res.message.content.trim()
  console.log(`✅ auth OK — ${cfg.llm.provider}/${cfg.llm.model} replied: "${text}"`)
  if (res.usage) console.log(`   usage: in=${res.usage.in} out=${res.usage.out}`)
  if (!text.toLowerCase().includes('ok')) {
    console.log('   ⚠️ reply did not contain "OK" — endpoint works but answer looks off')
  }
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  log.error(`smoke:llm FAILED: ${msg}`)
  if (/HTTP 40[13]/.test(msg)) {
    console.error('   → auth problem: check LLM_API_KEY for this provider')
  } else if (/HTTP 404/.test(msg)) {
    console.error('   → model or endpoint not found: check LLM_MODEL / LLM_BASE_URL')
  } else if (/fetch failed|ECONNREFUSED/i.test(msg)) {
    console.error('   → endpoint unreachable: is the server running? (ollama: `ollama serve`)')
  }
  process.exit(1)
}