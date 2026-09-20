import { describe, it, expect } from 'vitest'
import { markdownToTelegramHtml, escapeHtml } from '../src/telegram/render.js'

describe('markdownToTelegramHtml — model prose renders, not bleeds symbols', () => {
  it('converts bold, italic, code and headings', () => {
    const out = markdownToTelegramHtml('**BTC signal:** RSI 66\n*Journaled* `ta:BTC:HOLD`\n## Verdict')
    expect(out).toContain('<b>BTC signal:</b>')
    expect(out).toContain('<i>Journaled</i>')
    expect(out).toContain('<code>ta:BTC:HOLD</code>')
    expect(out).toContain('<b>Verdict</b>')
    expect(out).not.toContain('**')
    expect(out).not.toContain('`ta')
  })

  it('renders fenced code as <pre> and protects its content from transforms', () => {
    const out = markdownToTelegramHtml('before\n```json\n{"ta:SOL:BUY": "*not italic*"}\n```\nafter')
    expect(out).toContain('<pre><code>')
    expect(out).toContain('*not italic*') // untouched inside the fence
    expect(out).toContain('after')
    expect(out).not.toContain('@@FENCE')
  })

  it('renders "> quote" lines as Telegram blockquotes', () => {
    const out = markdownToTelegramHtml('> what a good signal?\nreply text')
    expect(out).toContain('<blockquote>what a good signal?</blockquote>')
    expect(out).not.toContain('&gt; what')
  })

  it('links and strikethrough convert; URLs keep escaped query strings', () => {
    const out = markdownToTelegramHtml('[desk](https://x.com/a?b=1&c=2) ~~gone~~')
    expect(out).toContain('<a href="https://x.com/a?b=1&amp;c=2">desk</a>')
    expect(out).toContain('<s>gone</s>')
  })

  it('escapes dangerous HTML in the source before anything else', () => {
    const out = markdownToTelegramHtml('try <b>injection</b> & <script>x</script>')
    expect(out).toContain('&lt;b&gt;injection&lt;/b&gt;')
    expect(out).toContain('&lt;script&gt;')
    expect(out).not.toContain('<script>')
  })

  it('leaves unbalanced markdown as literal characters instead of mangling prose', () => {
    const out = markdownToTelegramHtml('2 * 3 = 6 and a stray ** bold never closed')
    expect(out).toContain('2 * 3 = 6')
    expect(out).toContain('**')
    expect(out).not.toContain('<i>')
    expect(out).not.toContain('<b>')
  })

  it('plain desk text passes through with only escaping', () => {
    const plain = '👀 Position guardian:\n🟡 WATCH ETH: −10% from entry'
    expect(markdownToTelegramHtml(plain)).toBe(escapeHtml(plain))
  })
})