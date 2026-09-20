# Kronos — vendored model code

`model/` in this folder is vendored from
[shiyu-coder/Kronos](https://github.com/shiyu-coder/Kronos) (MIT license,
`LICENSE-Kronos` alongside). Models are loaded from HuggingFace:
`NeoQuasar/Kronos-Tokenizer-base` + `NeoQuasar/Kronos-small` (open weights).

## The one patch we carry

`model/kronos.py` — `auto_regressive_inference()` gains a
`return_samples=False` parameter. With `True` it returns the per-sample
forecast paths **before** the `np.mean(preds, axis=1)` collapse:

    z: (batch, sample_count, pred_len, feat)

The desk needs the per-sample paths to compute forecast **quantile bands**
(p25/p50/p75 + P(up)) — the original API only exposes the averaged path,
and an averaged point forecast without a spread is a vibe, not a signal.

Everything else in `model/` is unmodified upstream code.

## How the desk uses this

The desk spawns `run.sh` (this folder's venv), writes a JSON request to
stdin, reads a JSON response from stdout — see `forecast.py` for the exact
protocol. The model is advisory: `kronos_forecast` is a **readonly** tool,
journalled and graded like every other signal. Wide band ⇒ no trade.