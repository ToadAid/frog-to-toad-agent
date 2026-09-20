// Fake kronos runner for tests — reads stdin JSON, emits one JSON line per mode.
// Modes via FAKE_KRONOS_MODE: ok | error | silent | garbage
let data = ''
process.stdin.on('data', (d) => (data += d))
process.stdin.on('end', () => {
  const mode = process.env.FAKE_KRONOS_MODE ?? 'ok'
  if (mode === 'silent') {
    setInterval(() => {}, 10_000) // never responds, never exits — timeout path
    return
  }
  if (mode === 'garbage') {
    process.stdout.write('this is not json\n')
    process.exit(0)
  }
  let req = {}
  try {
    req = JSON.parse(data)
  } catch {
    req = {}
  }
  if (mode === 'error') {
    process.stdout.write(JSON.stringify({ ok: false, error: 'fake kronos boom' }) + '\n')
    process.exit(0)
  }
  const candles = req.candles ?? []
  const predLen = req.predLen ?? 12
  const lastClose = candles.length ? candles[candles.length - 1].close : 0
  const path = new Array(predLen).fill(lastClose)
  process.stdout.write(
    JSON.stringify({
      ok: true,
      model: 'Kronos-small',
      sampleCount: req.sampleCount ?? 8,
      predLen,
      lookback: candles.length,
      lastClose,
      pUp: 0.62,
      p25: path.map((v) => v * 0.98),
      p50: path,
      p75: path.map((v) => v * 1.02),
      mean: path,
      horizonMovePct: 0,
      bandWidthPct: 4,
      bandLow: lastClose * 0.98,
      bandHigh: lastClose * 1.02,
      elapsedMs: 1,
      echoedPredLen: predLen,
      echoedLastClose: lastClose,
    }) + '\n',
  )
  process.exit(0)
})