"""Các kiểm tra chất lượng dữ liệu nguồn trước khi thay database dashboard."""
import re

import pandas as pd

from schema import ACTION_STATUSES, INVESTORS
from number_normalizer import parse_number_series


class DataQualityError(RuntimeError):
    """Dữ liệu vi phạm quy tắc bắt buộc; pipeline không được xuất dashboard mới."""


def _frame(frames, file, sheet):
    return frames.get((file, sheet), pd.DataFrame())


def _add(issues, level, scope, message, count=0):
    issues.append({"level": level, "scope": scope, "message": message, "count": int(count)})


def _invalid_number(issues, df, columns, scope, required=True, nonnegative=False):
    for column in columns:
        if column not in df.columns:
            continue
        values = parse_number_series(df[column])
        invalid = values.isna() if required else (df[column].notna() & values.isna())
        if invalid.any():
            _add(issues, "error", scope, f"{column} phải là số", invalid.sum())
        if nonnegative:
            negative = values.notna() & (values < 0)
            if negative.any():
                _add(issues, "error", scope, f"{column} không được âm", negative.sum())
        df[column] = values


def _allowed(issues, df, column, allowed, scope):
    if column not in df.columns or df.empty:
        return
    invalid = ~df[column].isin(allowed)
    if invalid.any():
        _add(issues, "error", scope, f"{column} không thuộc tập giá trị cho phép", invalid.sum())


def _ohlc(issues, df, scope):
    columns = ["open", "high", "low", "close"]
    _invalid_number(issues, df, columns, scope, nonnegative=True)
    if df.empty or not set(columns).issubset(df.columns):
        return
    valid = df[columns].notna().all(axis=1)
    malformed = valid & ((df.low > df[["open", "close"]].min(axis=1)) | (df.high < df[["open", "close"]].max(axis=1)))
    if malformed.any():
        _add(issues, "error", scope, "low/open/close/high không theo thứ tự giá hợp lệ", malformed.sum())


def _blank_keys(issues, frames):
    for (file, sheet), df in frames.items():
        from schema import SCHEMA
        keys = SCHEMA[file][sheet]["key"]
        if df.empty:
            continue
        missing = pd.Series(False, index=df.index)
        for column in keys:
            value = df[column]
            missing |= value.isna() | value.astype(str).str.strip().eq("")
        if missing.any():
            _add(issues, "error", f"{file}/{sheet}", f"thiếu khóa: {', '.join(keys)}", missing.sum())


def validate(frames):
    """Trả về issues. Các issue error phải chặn việc ghi database mới."""
    issues = []
    _blank_keys(issues, frames)

    market = _frame(frames, "market.xlsx", "VNINDEX")
    _ohlc(issues, market, "market.xlsx/VNINDEX")
    _invalid_number(issues, market, ["volume"], "market.xlsx/VNINDEX", nonnegative=True)
    _allowed(issues, _frame(frames, "market.xlsx", "EVENTS"), "impact", {"Cao", "Trung bình", "Thấp"}, "market.xlsx/EVENTS")

    flows = _frame(frames, "flows.xlsx", "INVESTOR_FLOW")
    _allowed(issues, flows, "investor", set(INVESTORS), "flows.xlsx/INVESTOR_FLOW")
    _invalid_number(issues, flows, ["net_value"], "flows.xlsx/INVESTOR_FLOW")
    if not flows.empty and flows.net_value.notna().all():
        imbalance = flows.groupby("date").net_value.sum().abs() > 1
        if imbalance.any():
            _add(issues, "warning", "flows.xlsx/INVESTOR_FLOW", "tổng mua/bán ròng theo ngày lệch quá 1 tỷ", imbalance.sum())
    ticker_flows = _frame(frames, "flows.xlsx", "TICKER_FLOW")
    _allowed(issues, ticker_flows, "main_investor", set(INVESTORS), "flows.xlsx/TICKER_FLOW")
    _invalid_number(issues, ticker_flows, ["net_value"], "flows.xlsx/TICKER_FLOW")
    sector_flows = _frame(frames, "flows.xlsx", "SECTOR_FLOW")
    _invalid_number(issues, sector_flows, ["net_value", "chg_pct", "weight_pct"], "flows.xlsx/SECTOR_FLOW")
    if "weight_pct" in sector_flows:
        invalid_weight = sector_flows.weight_pct.notna() & ~sector_flows.weight_pct.between(0, 100)
        if invalid_weight.any():
            _add(issues, "error", "flows.xlsx/SECTOR_FLOW", "weight_pct phải trong khoảng 0–100", invalid_weight.sum())

    positions = _frame(frames, "portfolio.xlsx", "POSITIONS")
    _allowed(issues, positions, "status", {"MUA", "NẮM GIỮ", "TĂNG TỶ TRỌNG", "GIẢM TỶ TRỌNG", "THEO DÕI"}, "portfolio.xlsx/POSITIONS")
    _invalid_number(issues, positions, ["buy_lo", "buy_hi", "target", "stop", "cost", "weight_pct"], "portfolio.xlsx/POSITIONS", required=False)
    if not positions.empty:
        bad_buy = positions.buy_lo.notna() & positions.buy_hi.notna() & (positions.buy_lo > positions.buy_hi)
        if bad_buy.any(): _add(issues, "error", "portfolio.xlsx/POSITIONS", "buy_lo phải nhỏ hơn hoặc bằng buy_hi", bad_buy.sum())
        bad_target = positions.target.notna() & positions.stop.notna() & (positions.target <= positions.stop)
        if bad_target.any(): _add(issues, "error", "portfolio.xlsx/POSITIONS", "target phải lớn hơn stop", bad_target.sum())
        bad_weight = positions.weight_pct.notna() & ~positions.weight_pct.between(0, 100)
        if bad_weight.any(): _add(issues, "error", "portfolio.xlsx/POSITIONS", "weight_pct phải trong khoảng 0–100", bad_weight.sum())
    prices = _frame(frames, "portfolio.xlsx", "PRICES")
    _ohlc(issues, prices, "portfolio.xlsx/PRICES")
    _invalid_number(issues, prices, ["volume"], "portfolio.xlsx/PRICES", nonnegative=True)
    summary = _frame(frames, "portfolio.xlsx", "SUMMARY")
    _invalid_number(issues, summary, ["stock_pct", "cash_pct", "other_pct"], "portfolio.xlsx/SUMMARY", required=False)
    if not summary.empty:
        allocation = summary[["stock_pct", "cash_pct", "other_pct"]].sum(axis=1, min_count=3)
        bad_allocation = allocation.notna() & ((allocation - 100).abs() > 0.1)
        if bad_allocation.any(): _add(issues, "warning", "portfolio.xlsx/SUMMARY", "tổng stock/cash/other không bằng 100%", bad_allocation.sum())

    fund_summary = _frame(frames, "funds.xlsx", "FUND_SUMMARY")
    _invalid_number(issues, fund_summary, ["nav_bn", "ytd_pct"], "funds.xlsx/FUND_SUMMARY")
    allocations = _frame(frames, "funds.xlsx", "ASSET_ALLOCATION")
    _allowed(issues, allocations, "asset_type", {"Cổ phiếu", "Tiền mặt", "Trái phiếu", "Khác"}, "funds.xlsx/ASSET_ALLOCATION")
    _invalid_number(issues, allocations, ["weight_pct"], "funds.xlsx/ASSET_ALLOCATION", nonnegative=True)
    if not allocations.empty and allocations.weight_pct.notna().all():
        totals = allocations.groupby(["period", "fund_code"]).weight_pct.sum()
        mismatch = (totals - 100).abs() > 0.1
        if mismatch.any(): _add(issues, "warning", "funds.xlsx/ASSET_ALLOCATION", "tổng phân bổ tài sản quỹ không bằng 100%", mismatch.sum())
    for sheet in ("INDUSTRY", "TOP_HOLDINGS"):
        _invalid_number(issues, _frame(frames, "funds.xlsx", sheet), ["weight_pct"], f"funds.xlsx/{sheet}", nonnegative=True)

    reports = _frame(frames, "reports.xlsx", "REPORTS")
    _allowed(issues, reports, "type", {"Chiến lược", "Vĩ mô", "Ngành", "Doanh nghiệp"}, "reports.xlsx/REPORTS")
    _allowed(issues, reports, "stance", {"Tích cực", "Trung lập", "Thận trọng", "Tiêu cực"}, "reports.xlsx/REPORTS")
    _invalid_number(issues, reports, ["vn_target"], "reports.xlsx/REPORTS", required=False)
    report_ids = set(reports.id.dropna().astype(str)) if "id" in reports else set()
    for sheet in ("REPORT_STOCKS", "REPORT_SECTORS", "REPORT_RISKS"):
        children = _frame(frames, "reports.xlsx", sheet)
        if not children.empty:
            orphans = ~children.report_id.astype(str).isin(report_ids)
            if orphans.any(): _add(issues, "error", f"reports.xlsx/{sheet}", "report_id không tồn tại trong REPORTS", orphans.sum())
    report_stocks = _frame(frames, "reports.xlsx", "REPORT_STOCKS")
    _allowed(issues, report_stocks, "rec", {"MUA", "KHẢ QUAN", "TRUNG LẬP", "KÉM KHẢ QUAN", "BÁN"}, "reports.xlsx/REPORT_STOCKS")
    _invalid_number(issues, report_stocks, ["target"], "reports.xlsx/REPORT_STOCKS", required=False)
    report_sectors = _frame(frames, "reports.xlsx", "REPORT_SECTORS")
    _allowed(issues, report_sectors, "view", {"OW", "UW"}, "reports.xlsx/REPORT_SECTORS")
    report_risks = _frame(frames, "reports.xlsx", "REPORT_RISKS")
    _invalid_number(issues, report_risks, ["severity"], "reports.xlsx/REPORT_RISKS")
    if "severity" in report_risks:
        invalid = report_risks.severity.notna() & ~report_risks.severity.isin([1, 2, 3])
        if invalid.any(): _add(issues, "error", "reports.xlsx/REPORT_RISKS", "severity phải là 1, 2 hoặc 3", invalid.sum())

    for item in issues:
        item["id"] = re.sub(r"[^a-z0-9]+", "-", f"{item['scope']}-{item['message']}".lower()).strip("-")[:120]
    return issues


def raise_for_errors(issues):
    errors = [item for item in issues if item["level"] == "error"]
    if errors:
        summary = "; ".join(f"{item['scope']}: {item['message']} ({item['count']} dòng)" for item in errors[:5])
        raise DataQualityError(f"Dữ liệu không đạt kiểm tra chất lượng — {summary}")
