/**
 * One real market-data request per source — CoinGecko + DexScreener, both keyless.
 *
 *   npm run smoke:market
 *
 * Exits non-zero if either source is unreachable (rate limits included).
 */
import { fetchJson } from '../src/http.js'

console.log('— smoke:market — CoinGecko…')
const cg = await fetchJson<{ bitcoin?: { usd?: number } }>(
  'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
)
if (cg.bitcoin?.usd === undefined) throw new Error('CoinGecko returned no BTC price')
console.log(`✅ CoinGecko OK — BTC = $${cg.bitcoin.usd}`)

console.log('— smoke:market — DexScreener…')
const ds = await fetchJson<{ pairs?: Array<{ chainId: string; priceUsd: string }> }>(
  'https://api.dexscreener.com/latest/dex/search?q=WETH%2FUSDC',
)
const pair = ds.pairs?.[0]
if (!pair) throw new Error('DexScreener returned no pairs')
console.log(`✅ DexScreener OK — top pair on ${pair.chainId} @ $${pair.priceUsd}`)

console.log('\nmarket data sources OK')