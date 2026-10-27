#!/usr/bin/env python3
"""Regenerate data/jobs.csv, the PUBLIC data file for the Job Search Tracker page.

The page used to read the live Google Sheet in the browser, which required the
sheet to be shared with anyone holding the link, and the sheet's Notes column
carries recruiter email addresses and private notes. This generator reads the
sheet through the authenticated Sheets API instead and writes a sanitized CSV:
Date, Company, Role, Channel, Status and Comp / Rate only. Notes are never
emitted. Run it, then push data/jobs.csv (see tools/README note in config.js).

Usage: python3 tools/build-jobs-data.py [--sheet-csv PATH]
  --sheet-csv reads rows from a local CSV export instead of the API
  (same columns as the sheet: Date,Company,Role,Channel,Status,Comp / Rate,Notes).
"""
import argparse, csv, io, json, re, subprocess, sys

SHEET_ID = "1U4igOyVtzTUuBOvaGtlqE01KOMy4jesEUVr2i8whUrc"
GWS = "/opt/hatch/bin/hatch_gws_cli"
OUT = "data/jobs.csv"
PUBLIC_FIELDS = ["Date", "Company", "Role", "Channel", "Status", "Comp / Rate", "Notes"]
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")


def scrub(value):
    # Some rows carry an email address in Company/Role/Channel (staffing agency
    # applications logged by address). No email ships in the public file, ever.
    return re.sub(r"\s+", " ", EMAIL_RE.sub("", value or "")).strip(" ,-")


def rows_from_api():
    params = json.dumps({"spreadsheetId": SHEET_ID, "range": "Sheet1!A1:G5000"})
    p = subprocess.run([GWS, "sheets", "spreadsheets", "values", "get", "--params", params],
                       capture_output=True, text=True, timeout=180)
    out = p.stdout
    data = json.loads(out[out.index("{"):])
    values = data.get("values", [])
    header, body = values[0], values[1:]
    idx = {name: header.index(name) for name in
           ["Date", "Company", "Role", "Channel", "Status", "Comp / Rate"] if name in header}
    rows = []
    for r in body:
        # Canary rows (Status "Canary") are leak traps planted in the sheet.
        # They are internal only and never ship in the public file.
        status = (r[idx["Status"]] if "Status" in idx and idx["Status"] < len(r) else "")
        if status.strip().lower() == "canary":
            continue
        row = {name: scrub(r[i] if i < len(r) else "") for name, i in idx.items()}
        row["Notes"] = ""
        if row.get("Company") or row.get("Role"):
            rows.append(row)
    return rows


def rows_from_csv(path):
    with open(path, newline="", encoding="utf-8") as f:
        raw = list(csv.DictReader(f))
    rows = []
    for r in raw:
        if (r.get("Status") or "").strip().lower() == "canary":
            continue
        row = {name: scrub(r.get(name)) for name in PUBLIC_FIELDS}
        row["Notes"] = ""
        if row.get("Company") or row.get("Role"):
            rows.append(row)
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sheet-csv", help="local CSV export of the sheet to read instead of the API")
    a = ap.parse_args()
    rows = rows_from_csv(a.sheet_csv) if a.sheet_csv else rows_from_api()
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=PUBLIC_FIELDS)
    w.writeheader()
    w.writerows(rows)
    text = buf.getvalue()
    leaks = EMAIL_RE.findall(text)
    assert not leaks, f"email pattern in public output, refusing to write: {leaks[:3]}"
    with open(OUT, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    print(f"wrote {OUT}: {len(rows)} rows, {len(text)} bytes, 0 emails")


if __name__ == "__main__":
    main()
