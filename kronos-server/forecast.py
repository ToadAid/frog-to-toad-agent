#!/usr/bin/env python3
"""Kronos forecast runner — stdin JSON in, quantile-band forecast JSON out.

Protocol (one request per process; the desk spawns us fresh each call):
  stdin : {"candles":[{"time":unixsec,"open":o,"high":h,"low":l,"close":c,"volume":v}, ...],
           "predLen":12, "T":1.0, "topP":0.9, "sampleCount":8, "maxContext":512}
  stdout: {"ok":true,  "p25":[...], "p50":[...], "p75":[...], "pUp":0.62, ...}
        | {"ok":false, "error":"human-readable reason"}

The candles must be oldest→newest, hourly or daily, OHLCV with volume.
Quantiles are computed across per-sample forecast paths (see ATTRIBUTION.md
for the upstream patch that exposes them). P(up) is the fraction of sample
paths whose final close exceeds the last historical close.

Every failure exits 0 and emits {"ok":false} — the desk turns that into a
tool-result the LLM can read, never a crash.
"""

import json
import math
import sys
import time

MODEL_NAME = "NeoQuasar/Kronos-small"
TOKENIZER_NAME = "NeoQuasar/Kronos-Tokenizer-base"

DEFAULT_PRED_LEN = 12
DEFAULT_T = 1.0
DEFAULT_TOP_P = 0.9
DEFAULT_SAMPLE_COUNT = 8
DEFAULT_MAX_CONTEXT = 512

MIN_CANDLES = 240  # below this the context is too thin to bother loading torch


def fail(msg: str) -> None:
    json.dump({"ok": False, "error": msg}, sys.stdout)
    sys.stdout.write("\n")


def main() -> None:
    t0 = time.time()
    try:
        req = json.load(sys.stdin)
    except Exception as e:
        fail(f"bad request JSON: {e}")
        return

    candles = req.get("candles") or []
    pred_len = int(req.get("predLen") or DEFAULT_PRED_LEN)
    T = float(req.get("T") or DEFAULT_T)
    top_p = float(req.get("topP") or DEFAULT_TOP_P)
    sample_count = int(req.get("sampleCount") or DEFAULT_SAMPLE_COUNT)
    max_context = int(req.get("maxContext") or DEFAULT_MAX_CONTEXT)
    interval = req.get("interval") or "hourly"

    if sample_count < 2:
        sample_count = 2  # quantiles from a single path are meaningless
    if sample_count > 32:
        sample_count = 32  # CPU budget
    if not (1 <= pred_len <= 120):
        fail("predLen must be 1..120")
        return
    if len(candles) < MIN_CANDLES:
        fail(f"need at least {MIN_CANDLES} candles for a usable context, got {len(candles)}")
        return

    try:
        import numpy as np
        import pandas as pd
        import torch

        from model.kronos import Kronos, KronosPredictor, KronosTokenizer, calc_time_stamps
        from model.kronos import auto_regressive_inference
    except Exception as e:
        fail(f"kronos runtime unavailable: {e}")
        return

    df = pd.DataFrame(candles)
    for col in ("open", "high", "low", "close", "volume"):
        if col not in df.columns:
            fail(f"candle column '{col}' missing")
            return
        df[col] = pd.to_numeric(df[col], errors="coerce")
    if df[["open", "high", "low", "close", "volume"]].isnull().values.any():
        fail("candle series contains non-finite values")
        return
    # amount = volume * mean price (the upstream predictor derives it the same way)
    df["amount"] = df["volume"] * df[["open", "high", "low", "close"]].mean(axis=1)

    # Series (not DatetimeIndex) — upstream calc_time_stamps needs a .dt accessor
    ts = pd.Series(pd.to_datetime(pd.to_numeric(df["time"]), unit="s"))
    last_close = float(df["close"].iloc[-1])

    try:
        tokenizer = KronosTokenizer.from_pretrained(TOKENIZER_NAME)
        model = Kronos.from_pretrained(MODEL_NAME)
        predictor = KronosPredictor(model, tokenizer, device="cpu", max_context=max_context)
    except Exception as e:
        fail(f"model load failed (weights in ~/.cache/huggingface): {e}")
        return

    # Normalization mirrors KronosPredictor.predict() exactly.
    price_cols = predictor.price_cols
    x = df[price_cols + ["volume", "amount"]].values.astype(np.float32)
    x_mean, x_std = np.mean(x, axis=0), np.std(x, axis=0)
    x_norm = np.clip((x - x_mean) / (x_std + 1e-5), -predictor.clip, predictor.clip)

    x_stamp = calc_time_stamps(ts.iloc[: len(ts)]).values.astype(np.float32)
    step = pd.Timedelta(days=1) if interval == "daily" else pd.Timedelta(hours=1)
    y_ts = pd.date_range(ts.iloc[-1] + step, periods=pred_len, freq="D" if interval == "daily" else "h")
    y_stamp = calc_time_stamps(pd.Series(y_ts)).values.astype(np.float32)

    xt = torch.from_numpy(x_norm[np.newaxis, :].astype(np.float32))
    xst = torch.from_numpy(x_stamp[np.newaxis, :].astype(np.float32))
    yst = torch.from_numpy(y_stamp[np.newaxis, :].astype(np.float32))

    try:
        # Patched upstream call: per-sample paths, (batch, sample_count, pred_len, feat).
        samples = auto_regressive_inference(
            predictor.tokenizer, predictor.model, xt, xst, yst,
            predictor.max_context, pred_len,
            predictor.clip, T, 0, top_p, sample_count, verbose=False,
            return_samples=True,
        )
    except TypeError:
        # Unpatched vendored copy — fall back to the averaged path and say so.
        mean_preds = auto_regressive_inference(
            predictor.tokenizer, predictor.model, xt, xst, yst,
            predictor.max_context, pred_len,
            predictor.clip, T, 0, top_p, sample_count, verbose=False,
        )
        fail(f"vendored kronos.py lacks return_samples patch (got averaged path only, shape {mean_preds.shape})")
        return

    close_idx = price_cols.index("close")
    # De-normalize: preds * (x_std + 1e-5) + x_mean. The decoded window is the
    # full max_context (history re-decoded + forecast appended) — keep only the
    # last pred_len steps, exactly like upstream generate()'s [:, -pred_len:, :].
    close_paths = (samples[0, :, :, close_idx] * (x_std[close_idx] + 1e-5) + x_mean[close_idx])[:, -pred_len:]

    p25 = np.percentile(close_paths, 25, axis=0)
    p50 = np.percentile(close_paths, 50, axis=0)
    p75 = np.percentile(close_paths, 75, axis=0)
    mean_path = close_paths.mean(axis=0)

    finals = close_paths[:, -1]
    p_up = float(np.mean(finals > last_close))
    band_low, band_high = float(p25[-1]), float(p75[-1])
    band_width_pct = (band_high - band_low) / last_close * 100 if last_close else float("nan")
    horizon_move_pct = (float(p50[-1]) - last_close) / last_close * 100 if last_close else float("nan")

    def clean(arr):
        return [None if not math.isfinite(v) else round(float(v), 6) for v in arr]

    json.dump(
        {
            "ok": True,
            "model": MODEL_NAME,
            "sampleCount": sample_count,
            "predLen": pred_len,
            "lookback": int(len(df)),
            "lastClose": round(last_close, 6),
            "pUp": round(p_up, 4),
            "p25": clean(p25.tolist()),
            "p50": clean(p50.tolist()),
            "p75": clean(p75.tolist()),
            "mean": clean(mean_path.tolist()),
            "horizonMovePct": round(horizon_move_pct, 3),
            "bandWidthPct": round(band_width_pct, 3),
            "bandLow": round(band_low, 6),
            "bandHigh": round(band_high, 6),
            "elapsedMs": int((time.time() - t0) * 1000),
        },
        sys.stdout,
    )
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()