"""
Lấy OHLCV ngày cho VN-Index và các mã trong POSITIONS bằng vnstock.
Ghi vào: market.xlsx/VNINDEX, portfolio.xlsx/PRICES (upsert theo ngày + mã).
"""
from datetime import date, timedelta
from importlib.util import find_spec
import json
import time
import pandas as pd
from config import DATA_DIR, PRICE_LOOKBACK_DAYS, VNSTOCK_SOURCE
from xlsx_io import read_sheet, upsert


def _history(symbol: str, start: str, end: str) -> pd.DataFrame:
    """Thử API Unified UI trước, sau đó API vnstock 3.x cổ điển."""
    errors = []
    try:
        from vnstock import Market  # Unified UI
        df = Market().equity(symbol).ohlcv(start=start, end=end, interval="1D")
        if df is not None and len(df):
            return df
    except Exception as e:  # noqa: BLE001
        errors.append(f"Unified UI: {e}")
    try:
        from vnstock import Vnstock
        df = Vnstock().stock(symbol=symbol, source=VNSTOCK_SOURCE).quote.history(
            start=start, end=end, interval="1D")
        if df is not None and len(df):
            return df
    except Exception as e:  # noqa: BLE001
        errors.append(f"Vnstock 3.x: {e}")
    raise RuntimeError(f"Không lấy được giá {symbol}: " + " | ".join(errors))


def _normalize(df: pd.DataFrame) -> pd.DataFrame:
    df = df.rename(columns={c: c.lower() for c in df.columns})
    df = df.rename(columns={"time": "date", "tradingdate": "date"})
    df["date"] = pd.to_datetime(df["date"]).dt.normalize()
    return df[["date", "open", "high", "low", "close", "volume"]]


def _manual_alert_tickers():
    """Các mã cảnh báo cá nhân cũng cần được đưa vào nguồn giá."""
    try:
        payload = json.loads((DATA_DIR / "price-alerts.json").read_text(encoding="utf-8"))
        return {str(item.get("ticker", "")).strip().upper() for item in payload.get("alerts", [])
                if item.get("enabled") is True and str(item.get("ticker", "")).strip()}
    except (FileNotFoundError, json.JSONDecodeError, OSError, AttributeError):
        return set()


def run(retries: int = 3, pause: float = 1.2):
    # Vnstock là nguồn giá tùy chọn. Nếu image chưa cài được thư viện (ví dụ
    # PyPI/registry tạm thời không trả phiên bản tương thích), trả lỗi nguồn
    # một lần để dashboard vẫn được dựng từ dữ liệu hợp lệ đang có.
    if find_spec("vnstock") is None:
        print("  vnstock is unavailable in this environment - skipping price refresh.")
        return ["vnstock"]
    end = date.today()
    start = end - timedelta(days=PRICE_LOOKBACK_DAYS)
    s, e = start.isoformat(), end.isoformat()

    pos = read_sheet("portfolio.xlsx", "POSITIONS")
    tickers = sorted({str(t).strip().upper() for t in pos.get("ticker", []) if str(t).strip() and str(t) != "nan"} | _manual_alert_tickers())
    failed = []

    idx = None
    for i in range(retries):
        try:
            idx = _normalize(_history("VNINDEX", s, e)); break
        except Exception as ex:  # noqa: BLE001
            print(f"  VNINDEX lần {i+1}: {ex}"); time.sleep(pause * (i + 1) * 3)
    if idx is not None:
        print(f"  VNINDEX: {upsert('market.xlsx', 'VNINDEX', idx)} dòng")
    else:
        failed.append("VNINDEX")

    frames = []
    for t in tickers:
        for i in range(retries):
            try:
                df = _normalize(_history(t, s, e)); df.insert(1, "ticker", t); frames.append(df); break
            except Exception as ex:  # noqa: BLE001
                if i == retries - 1:
                    print(f"  {t}: {ex}"); failed.append(t)
                time.sleep(pause * (i + 1) * 3)
        time.sleep(pause)  # tránh rate limit
    if frames:
        print(f"  PRICES: {upsert('portfolio.xlsx', 'PRICES', pd.concat(frames))} dòng, {len(frames)} mã")
    if failed:
        print(f"  Lỗi: {', '.join(failed)}")
    return failed


if __name__ == "__main__":
    run()
