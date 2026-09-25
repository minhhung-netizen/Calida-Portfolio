"""
Lấy OHLCV ngày cho VN-Index và các mã trong POSITIONS bằng vnstock.
Ghi vào: market.xlsx/VNINDEX, portfolio.xlsx/PRICES (upsert theo ngày + mã).
"""
from datetime import date, datetime, timedelta
from importlib.util import find_spec
import json
from numbers import Real
import os
import time
from zoneinfo import ZoneInfo
import pandas as pd
from config import (DATA_DIR, PRICE_LOOKBACK_DAYS, PRICE_REQUESTS_PER_MINUTE,
                    VNSTOCK_QUOTE_PRICE_DIVISOR, VNSTOCK_QUOTE_SOURCE, VNSTOCK_SOURCE)
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


def _current_quote(symbol: str, pacer=None) -> pd.DataFrame:
    """Lấy ảnh chụp giá trong phiên từ Unified UI của vnstock 4.x."""
    if pacer:
        pacer.wait()
    from vnstock import Market
    return Market().equity(symbol).quote(source=VNSTOCK_QUOTE_SOURCE)


def _quote_timestamp_date(value):
    if value is None or pd.isna(value):
        return None
    if isinstance(value, Real):
        seconds = float(value) / 1000 if float(value) > 10_000_000_000 else float(value)
        return datetime.fromtimestamp(seconds, ZoneInfo("Asia/Ho_Chi_Minh")).date()
    parsed = pd.to_datetime(value, errors="coerce")
    return None if pd.isna(parsed) else parsed.date()


def _normalize_current_quote(symbol: str, quote: pd.DataFrame, today=None) -> pd.DataFrame:
    """Đưa bảng giá VND về schema nghìn đồng đang dùng trong dashboard."""
    if quote is None or quote.empty:
        raise ValueError(f"Bảng giá {symbol} không có dữ liệu")
    frame = quote.rename(columns={column: str(column).lower() for column in quote.columns})
    if "symbol" in frame.columns:
        matched = frame[frame["symbol"].astype(str).str.upper() == symbol.upper()]
        if len(matched):
            frame = matched
    row = frame.iloc[-1]
    expected_date = today or date.today()
    quote_date = _quote_timestamp_date(row.get("time"))
    if quote_date is not None and quote_date != expected_date:
        raise ValueError(f"Bảng giá {symbol} mới nhất là {quote_date.isoformat()}, chưa có dữ liệu {expected_date.isoformat()}")
    divisor = VNSTOCK_QUOTE_PRICE_DIVISOR
    if not divisor or divisor <= 0:
        raise ValueError("VNSTOCK_QUOTE_PRICE_DIVISOR phải lớn hơn 0")

    def price(column, fallback=None):
        value = pd.to_numeric(pd.Series([row.get(column)]), errors="coerce").iloc[0]
        if pd.isna(value) or float(value) <= 0:
            return fallback
        return float(value) / divisor

    close = price("close_price")
    if close is None:
        raise ValueError(f"Bảng giá {symbol} chưa có giá khớp trong phiên")
    open_price = price("open_price", close)
    high = price("high_price", max(open_price, close))
    low = price("low_price", min(open_price, close))
    volume = pd.to_numeric(pd.Series([row.get("volume_accumulated")]), errors="coerce").fillna(0).iloc[0]
    return pd.DataFrame([{
        "date": pd.Timestamp(expected_date), "ticker": symbol.upper(),
        "open": open_price, "high": high, "low": low, "close": close,
        "volume": max(0, int(volume)),
    }])


def _manual_alert_tickers():
    """Các mã cảnh báo cá nhân cũng cần được đưa vào nguồn giá."""
    try:
        payload = json.loads((DATA_DIR / "price-alerts.json").read_text(encoding="utf-8"))
        return {str(item.get("ticker", "")).strip().upper() for item in payload.get("alerts", [])
                if item.get("enabled") is True and str(item.get("ticker", "")).strip()}
    except (FileNotFoundError, json.JSONDecodeError, OSError, AttributeError):
        return set()


def run(retries: int = 3, pause: float = 1.2, lookback_days: int = PRICE_LOOKBACK_DAYS, intraday: bool = False):
    # Nguồn giá là bắt buộc đối với quy trình --prices-only. Không được âm thầm
    # bỏ qua vì giao diện sẽ tiếp tục hiển thị giá cũ mà quản trị viên không biết.
    if find_spec("vnstock") is None:
        raise RuntimeError("Thiếu thư viện vnstock; không thể cập nhật giá")
    has_api_key = bool(os.getenv("VNSTOCK_API_KEY", "").strip())
    safe_request_rate = PRICE_REQUESTS_PER_MINUTE if has_api_key else min(18, PRICE_REQUESTS_PER_MINUTE)
    pacer = _RequestPacer(safe_request_rate)
    access_mode = "API key" if has_api_key else "khách"
    print(f"  Tuần tự tối đa {pacer.requests_per_minute} request/phút (chế độ {access_mode})")
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
                if intraday:
                    df = _normalize_current_quote(t, _current_quote(t, pacer))
                else:
                    df = _normalize(_history(t, s, e, pacer)); df.insert(1, "ticker", t)
                frames.append(df)
                break
            except Exception as ex:  # noqa: BLE001
                if i == retries - 1:
                    print(f"  {t}: {ex}"); failed.append(t)
                time.sleep(pause * (i + 1) * 3)
    if frames:
        mode = "trong phiên" if intraday else "lịch sử"
        print(f"  PRICES {mode}: {upsert('portfolio.xlsx', 'PRICES', pd.concat(frames))} dòng, {len(frames)} mã")
    if failed:
        print(f"  Lỗi: {', '.join(failed)}")
    return failed


if __name__ == "__main__":
    run()
