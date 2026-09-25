"""
Lấy OHLCV ngày cho VN-Index và các mã trong POSITIONS bằng vnstock.
Ghi vào: market.xlsx/VNINDEX, portfolio.xlsx/PRICES (upsert theo ngày + mã).
"""
from datetime import date, timedelta
from importlib.util import find_spec
import json
import time
import pandas as pd
from config import DATA_DIR, PRICE_LOOKBACK_DAYS, PRICE_REQUESTS_PER_MINUTE, VNSTOCK_SOURCE
from xlsx_io import read_sheet, upsert


class _RequestPacer:
    """Giãn đều từng lời gọi nguồn giá để không tạo burst vượt hạn mức."""

    def __init__(self, requests_per_minute: int, clock=None, sleeper=None):
        self.requests_per_minute = min(55, max(1, int(requests_per_minute)))
        self.interval = 60.0 / self.requests_per_minute
        self.clock = clock or time.monotonic
        self.sleeper = sleeper or time.sleep
        self.next_request_at = 0.0

    def wait(self):
        now = self.clock()
        delay = self.next_request_at - now
        if delay > 0:
            self.sleeper(delay)
            now = self.clock()
        self.next_request_at = max(now, self.next_request_at) + self.interval


def _history(symbol: str, start: str, end: str, pacer=None) -> pd.DataFrame:
    """Thử API Unified UI trước, sau đó API vnstock 3.x cổ điển."""
    errors = []
    try:
        if pacer:
            pacer.wait()
        from vnstock import Market  # Unified UI
        df = Market().equity(symbol).ohlcv(start=start, end=end, interval="1D")
        if df is not None and len(df):
            return df
    except Exception as e:  # noqa: BLE001
        errors.append(f"Unified UI: {e}")
    try:
        if pacer:
            pacer.wait()
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


def run(retries: int = 3, pause: float = 1.2, lookback_days: int = PRICE_LOOKBACK_DAYS):
    # Vnstock là nguồn giá tùy chọn. Nếu image chưa cài được thư viện (ví dụ
    # PyPI/registry tạm thời không trả phiên bản tương thích), trả lỗi nguồn
    # một lần để dashboard vẫn được dựng từ dữ liệu hợp lệ đang có.
    if find_spec("vnstock") is None:
        print("  vnstock is unavailable in this environment - skipping price refresh.")
        return ["vnstock"]
    pacer = _RequestPacer(PRICE_REQUESTS_PER_MINUTE)
    print(f"  Tuần tự tối đa {pacer.requests_per_minute} request/phút")
    end = date.today()
    start = end - timedelta(days=max(3, int(lookback_days)))
    s, e = start.isoformat(), end.isoformat()

    pos = read_sheet("portfolio.xlsx", "POSITIONS")
    tickers = sorted({str(t).strip().upper() for t in pos.get("ticker", []) if str(t).strip() and str(t) != "nan"} | _manual_alert_tickers())
    failed = []

    idx = None
    for i in range(retries):
        try:
            idx = _normalize(_history("VNINDEX", s, e, pacer)); break
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
                df = _normalize(_history(t, s, e, pacer)); df.insert(1, "ticker", t); frames.append(df); break
            except Exception as ex:  # noqa: BLE001
                if i == retries - 1:
                    print(f"  {t}: {ex}"); failed.append(t)
                time.sleep(pause * (i + 1) * 3)
    if frames:
        print(f"  PRICES: {upsert('portfolio.xlsx', 'PRICES', pd.concat(frames))} dòng, {len(frames)} mã")
    if failed:
        print(f"  Lỗi: {', '.join(failed)}")
    return failed


if __name__ == "__main__":
    run()
