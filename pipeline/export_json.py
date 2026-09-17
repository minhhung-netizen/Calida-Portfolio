"""
SQLite → web/data/dashboard.json (đúng cấu trúc giao diện dùng).
Mọi chỉ số tổng hợp (MTD/YTD, bình quân gia quyền NAV, Δ kỳ trước…) tính ở đây.
"""
import json
import math
import sqlite3
from datetime import datetime
import pandas as pd
from config import DB_PATH, JSON_OUT, FUND_UNIVERSE_TOTAL
from schema import INVESTORS, ACTION_STATUSES


def q(con, sql, *args):
    return pd.read_sql(sql, con, params=args)


def clean(o):
    """NaN/Inf → None, numpy → python để json.dump."""
    if isinstance(o, dict):
        return {k: clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if hasattr(o, "item"):
        o = o.item()
    if isinstance(o, float) and (math.isnan(o) or math.isinf(o)):
        return None
    return o


def num(v, d=2):
    try:
        f = float(v)
        return None if math.isnan(f) else round(f, d)
    except (TypeError, ValueError):
        return None


def split(v, sep=","):
    return [x.strip() for x in str(v).split(sep) if x.strip()] if v and str(v) != "nan" else []


def ddmmyyyy(s):
    return datetime.strptime(s, "%Y-%m-%d").strftime("%d/%m/%Y") if s else None


# ------------------------------------------------------------------ market
def market(con, as_of):
    idx = q(con, "SELECT date, close FROM vnindex WHERE date <= ? ORDER BY date", as_of)
    view = q(con, "SELECT * FROM view WHERE date <= ? ORDER BY date DESC LIMIT 1", as_of)
    m = {"index": None, "chg": None, "pct": None, "spark": []}
    if len(idx) >= 2:
        last, prev = idx.close.iloc[-1], idx.close.iloc[-2]
        m.update(index=num(last), chg=num(last - prev), pct=num((last / prev - 1) * 100), spark=[num(x) for x in idx.close.tail(20)])
    if len(view):
        v = view.iloc[0]
        m.update(
            viewDate=v.date, sentiment=v.sentiment,
            support=[num(v.support_lo), num(v.support_hi)], resist=[num(v.resist_lo), num(v.resist_hi)],
            expected=[num(v.expected_lo), num(v.expected_hi)],
            today=v.today_text or "", week=v.week_text or "",
            focusSectors=split(v.focus_sectors), risks=split(v.risks),
            strategyShort=v.strategy_short or "", strategyLong=v.strategy_long or "",
            weekActions=split(v.week_actions, "|"),
        )
    return m


def news(con, as_of):
    df = q(con, "SELECT * FROM news WHERE substr(published_at,1,10) <= ? ORDER BY published_at DESC LIMIT 30", as_of)
    return [{"tab": r.tab, "title": r.title, "src": r.source, "url": r.url, "at": r.published_at} for r in df.itertuples()]


def events(con, as_of):
    df = q(con, "SELECT * FROM events WHERE date >= ? ORDER BY date, time LIMIT 15", as_of)
    return [{"date": r.date, "time": r.time, "name": r.name, "country": r.country, "impact": r.impact,
             "fc": r.forecast, "prev": r.previous} for r in df.itertuples()]


# ------------------------------------------------------------------ flows
def flows(con, as_of):
    inv = q(con, "SELECT * FROM investor_flow WHERE date <= ?", as_of)
    inv["net_value"] = pd.to_numeric(inv.net_value, errors="coerce")
    month, year = as_of[:7], as_of[:4]

    def agg(df):
        s = df.groupby("investor").net_value.sum()
        return {k: num(s.get(k, 0), 0) for k in INVESTORS}

    dates = sorted(inv.date.unique())[-5:]
    hist = {"dates": [datetime.strptime(d, "%Y-%m-%d").strftime("%d/%m") for d in dates]}
    for k in INVESTORS:
        hist[k] = [num(inv[(inv.date == d) & (inv.investor == k)].net_value.sum(), 0) for d in dates]

    tk = q(con, "SELECT * FROM ticker_flow WHERE date = ?", as_of)
    sc = q(con, "SELECT * FROM sector_flow WHERE date = ?", as_of)
    return {
        "investors": {"Hôm nay": agg(inv[inv.date == as_of]), "MTD": agg(inv[inv.date.str[:7] == month]),
                      "YTD": agg(inv[inv.date.str[:4] == year])},
        "history": hist,
        "tickers": [{"t": r.ticker, "v": num(r.net_value, 0), "main": r.main_investor,
                     "note": None if pd.isna(r.note) else r.note} for r in tk.itertuples()],
        "sectors": [{"s": r.sector, "v": num(r.net_value, 0), "chg": num(r.chg_pct, 1), "w": num(r.weight_pct, 1)}
                    for r in sc.itertuples()],
    }


# ------------------------------------------------------------------ portfolio
def portfolio(con, as_of):
    pos = q(con, "SELECT * FROM positions")
    px = q(con, "SELECT * FROM prices WHERE date <= ? ORDER BY ticker, date", as_of)
    last = px.groupby("ticker").tail(1).set_index("ticker")
    prev = px.groupby("ticker").nth(-2).set_index("ticker") if len(px) else px
    out = []
    for r in pos.itertuples():
        t = r.ticker
        close = last.close.get(t) if t in last.index else None
        pclose = prev.close.get(t) if len(prev) and t in prev.index else None
        buy = [num(r.buy_lo), num(r.buy_hi)] if pd.notna(r.buy_lo) and pd.notna(r.buy_hi) else None
        out.append({
            "t": t, "name": r.name, "sector": r.sector, "book": r.book, "status": r.status,
            "price": num(close), "chg": num(close - pclose) if close is not None and pclose is not None else None,
            "low": num(last.low.get(t)) if t in last.index else None,
            "priceDate": last.date.get(t) if t in last.index else None,
            "buy": buy, "target": num(r.target), "stop": num(r.stop), "cost": num(r.cost),
            "recDate": ddmmyyyy(r.rec_date) if isinstance(r.rec_date, str) else None,
            "w": num(r.weight_pct, 1) or 0, "thesis": r.thesis if isinstance(r.thesis, str) else "",
        })
    today = [{"t": p["t"], "a": p["status"],
              "z": f"{p['buy'][0]:g} – {p['buy'][1]:g}".replace(".", ",") if p["buy"] and p["status"] == "MUA" else "—"}
             for p in out if p["status"] in ACTION_STATUSES]
    tx = q(con, "SELECT * FROM transactions ORDER BY date DESC LIMIT 50")
    history = [{"d": ddmmyyyy(r.date), "t": r.ticker, "a": r.action,
                "p": "" if pd.isna(r.price) else str(r.price), "note": "" if pd.isna(r.note) else r.note}
               for r in tx.itertuples()]
    sm = q(con, "SELECT * FROM summary WHERE date <= ? ORDER BY date DESC LIMIT 1", as_of)
    stock_w = sum(p["w"] for p in out)
    if len(sm):
        s = sm.iloc[0]
        ytd = num(s.ytd_pct, 1)
        alloc = {"Cổ phiếu": num(s.stock_pct, 1), "Tiền mặt": num(s.cash_pct, 1), "Khác": num(s.other_pct, 1)}
    else:
        ytd = None
        alloc = {"Cổ phiếu": num(stock_w, 1), "Tiền mặt": num(max(0, 100 - stock_w), 1), "Khác": 0}
    return {"ytd": ytd, "alloc": alloc, "positions": out, "today": today, "history": history}


# ------------------------------------------------------------------ funds
def _pkey(p):
    m, y = str(p).split("/")
    return int(y) * 100 + int(m)


def funds(con):
    fs = q(con, "SELECT * FROM fund_summary")
    if fs.empty:
        return None
    fs["nav_bn"] = pd.to_numeric(fs.nav_bn, errors="coerce")
    periods = sorted(fs.period.unique(), key=_pkey)
    P, P0 = periods[-1], (periods[-2] if len(periods) > 1 else None)
    aa = q(con, "SELECT * FROM asset_allocation")
    ind = q(con, "SELECT * FROM industry")
    th = q(con, "SELECT * FROM top_holdings")
    for d in (aa, ind, th):
        d["weight_pct"] = pd.to_numeric(d.weight_pct, errors="coerce")

    def nav_of(p):
        return fs[fs.period == p].set_index("fund_code").nav_bn

    def stock_w(p):  # % cổ phiếu từng quỹ
        return aa[(aa.period == p) & (aa.asset_type == "Cổ phiếu")].set_index("fund_code").weight_pct

    def cash_w(p):
        return aa[(aa.period == p) & (aa.asset_type == "Tiền mặt")].set_index("fund_code").weight_pct

    def wavg(weights, nav):
        j = pd.concat([weights.rename("w"), nav.rename("n")], axis=1).dropna()
        return (j.w * j.n).sum() / j.n.sum() if len(j) else None

    def by_group(df, p, col):
        nav = nav_of(p); tot = nav.sum()
        d = df[df.period == p].merge(nav.rename("n"), left_on="fund_code", right_index=True)
        return (d.weight_pct * d.n).groupby(d[col]).sum() / tot

    nav, nav0 = nav_of(P), (nav_of(P0) if P0 else pd.Series(dtype=float))
    common = nav.index.intersection(nav0.index)
    sw, sw0 = stock_w(P), (stock_w(P0) if P0 else pd.Series(dtype=float))
    stockW = wavg(sw, nav)
    dStockW = (wavg(sw.reindex(common), nav.reindex(common)) - wavg(sw0.reindex(common), nav0.reindex(common))) if len(common) else None
    stock_val = lambda s, n: (s.reindex(n.index) * n / 100).sum()
    dStockVal = (stock_val(sw, nav.reindex(common)) - stock_val(sw0, nav0.reindex(common))) if len(common) else None

    sec = by_group(ind, P, "industry")
    sec0 = by_group(ind, P0, "industry") if P0 else pd.Series(dtype=float)
    sectors = [{"s": k, "w": num(v), "d": num(v - sec0.get(k, 0)) if P0 else None} for k, v in sec.sort_values(ascending=False).items()]
    hold = by_group(th, P, "ticker").sort_values(ascending=False).head(10)

    dfund = (sw.reindex(common) - sw0.reindex(common)).dropna().sort_values()
    top = fs[fs.period == P].sort_values("nav_bn", ascending=False).head(10)
    return {
        "period": P, "prevPeriod": P0,
        "updated": int(nav.notna().sum()),
        "total": FUND_UNIVERSE_TOTAL or int(fs.fund_code.nunique()),
        "nav": num(nav.sum(), 0), "navPrevChg": num(nav.reindex(common).sum() - nav0.reindex(common).sum(), 0) if len(common) else None,
        "navPrevChgPct": num((nav.reindex(common).sum() / nav0.reindex(common).sum() - 1) * 100) if len(common) else None,
        "stockW": num(stockW), "cashW": num(wavg(cash_w(P), nav)),
        "dStockW": num(dStockW), "dStockVal": num(dStockVal, 0),
        "sectors": sectors,
        "stocks": [{"t": k, "w": num(v)} for k, v in hold.items()],
        "fundUp": [{"f": k, "d": num(v)} for k, v in dfund[dfund > 0].sort_values(ascending=False).head(5).items()],
        "fundDown": [{"f": k, "d": num(v)} for k, v in dfund[dfund < 0].head(5).items()],
        "top": [{"f": r.fund_code, "nav": num(r.nav_bn, 0), "ytd": num(r.ytd_pct, 1), "cp": num(sw.get(r.fund_code), 1)} for r in top.itertuples()],
    }


# ------------------------------------------------------------------ reports
def reports(con):
    rep = q(con, "SELECT * FROM reports ORDER BY date DESC")
    st = q(con, "SELECT * FROM report_stocks")
    se = q(con, "SELECT * FROM report_sectors")
    rk = q(con, "SELECT * FROM report_risks")
    out = []
    for r in rep.itertuples():
        rid = r.id
        out.append({
            "id": rid, "broker": r.broker, "date": r.date, "type": r.type, "title": r.title, "stance": r.stance,
            "vnTarget": num(r.vn_target, 0), "horizon": r.horizon if isinstance(r.horizon, str) else "",
            "summary": r.summary if isinstance(r.summary, str) else "", "source": r.source if isinstance(r.source, str) else "",
            "ow": se[(se.report_id == rid) & (se.view == "OW")].sector.tolist(),
            "uw": se[(se.report_id == rid) & (se.view == "UW")].sector.tolist(),
            "stocks": [{"t": s.ticker, "rec": s.rec, "target": num(s.target, 1)} for s in st[st.report_id == rid].itertuples()],
            "risks": [{"k": k.topic, "s": int(k.severity) if pd.notna(k.severity) else 2} for k in rk[rk.report_id == rid].itertuples()],
        })
    return out


def run():
    con = sqlite3.connect(DB_PATH)
    cands = [q(con, f"SELECT MAX(date) d FROM {t}").d.iloc[0] for t in ("investor_flow", "vnindex", "view")]
    as_of = max([c for c in cands if c] or [datetime.now().strftime("%Y-%m-%d")])
    meta = q(con, "SELECT * FROM _meta")
    data = {
        "asOf": as_of,
        "meta": {"generatedAt": datetime.now().isoformat(timespec="seconds"),
                 "dbBuiltAt": meta.built_at.iloc[0] if len(meta) else None,
                 "rows": dict(zip(meta.table, meta.rows.astype(int)))},
        "market": market(con, as_of), "news": news(con, as_of), "events": events(con, as_of),
        "flows": flows(con, as_of), "portfolio": portfolio(con, as_of),
        "funds": funds(con), "reports": reports(con),
    }
    con.close()
    JSON_OUT.parent.mkdir(parents=True, exist_ok=True)
    tmp = JSON_OUT.with_suffix(".tmp")
    tmp.write_text(json.dumps(clean(data), ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(JSON_OUT)
    print(f"  {JSON_OUT.name}: ngày dữ liệu {as_of}, {JSON_OUT.stat().st_size/1024:.0f} KB")


if __name__ == "__main__":
    run()
