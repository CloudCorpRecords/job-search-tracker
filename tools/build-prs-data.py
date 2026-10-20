#!/usr/bin/env python3
"""Regenerate data/prs.json for the job-search-tracker site.

Why this exists: the PR tracker sheet's Status column describes the outcome
of our linked pull request (for example "CLOSED unmerged 2026-10-17 by
hay-kot"), and the site rendered that text as the status of the ISSUE row.
Issue state and PR outcome are different facts and were being conflated:
mealie-recipes/mealie issue #8735 is open, but the site showed it as closed
because our PR #8753 was closed unmerged.

This script reads the tracked row list from the sheet (read only), then asks
the GitHub API for each issue's own state and each linked PR's own state,
and writes them as separate fields:

  issueState / issueClosedAt / status   -> the issue itself
  prNumber / prState / prDate / prLabel -> the linked pull request, if any

Rows with no issue number (PR-only or product rows) get issueState null and
status "PR only" / "No linked issue"; their PR state still comes from the
API when the PR URL is a real /pull/N link.

Usage: python3 tools/build-prs-data.py [--api-base URL] [--out PATH]
API base defaults to the local credential proxy http://127.0.0.1:8792 and
falls back to https://api.github.com (unauthenticated, rate limited).
"""

import argparse
import csv
import io
import json
import re
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

SHEET_ID_FALLBACK = "1hGmP9KBrvN_C8D_VRAK7qh9b5g-5vgKrBIyGXtcSGyc"


def sheet_id():
    try:
        with open("config.js") as f:
            m = re.search(r'prsSheetId:\s*"([^"]+)"', f.read())
            if m:
                return m.group(1)
    except OSError:
        pass
    return SHEET_ID_FALLBACK


def fetch(url, api_base, timeout=30):
    req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json",
                                                 "User-Agent": "tracker-data-builder"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode("utf-8"))


def get_json(path, api_base):
    last = None
    for attempt in range(3):
        try:
            return fetch(api_base.rstrip("/") + path, api_base)
        except Exception as e:  # noqa: BLE001 - report and retry uniformly
            last = e
    raise last


def day(iso):
    return iso[:10] if iso else None


def build_row(row, api_base):
    repo = (row.get("Repo") or "").strip()
    issue_no = (row.get("Issue #") or "").strip()
    pr_url = (row.get("PR URL") or "").strip()
    sheet_status = (row.get("Status") or "").strip()

    out = {
        "date": (row.get("Date Found") or "").strip(),
        "repo": repo,
        "issue": issue_no,
        "title": (row.get("Issue Title") or "").strip(),
        "issueUrl": (row.get("Issue URL") or "").strip(),
        "type": (row.get("Type") or "").strip(),
        "labels": (row.get("Labels") or "").strip(),
        "trackerStatus": sheet_status,
        "branch": (row.get("Fork / Branch") or "").strip(),
        "files": (row.get("Files Changed") or "").strip(),
        "notes": (row.get("Notes / Next Step") or "").strip(),
        "issueState": None,
        "issueClosedAt": None,
        "status": "Unknown",
        "prNumber": None,
        "prUrl": "",
        "prState": None,
        "prDate": None,
        "prLabel": "",
        "stage": "Unknown",
        "error": "",
    }

    # --- the issue itself ---
    # The Issue URL is the canonical pointer: on some rows the Repo column
    # names the repo our PR went to, while the issue lives in a parent repo.
    iss_coord = None
    um = re.search(r"github\.com/([^/]+/[^/]+)/issues/(\d+)", out["issueUrl"])
    if um:
        iss_coord = (um.group(1), um.group(2))
    elif re.fullmatch(r"\d+", issue_no) and "/" in repo:
        iss_coord = (repo, issue_no)
    if iss_coord:
        try:
            iss = get_json(f"/repos/{iss_coord[0]}/issues/{iss_coord[1]}", api_base)
            out["issueState"] = iss.get("state")
            out["issueClosedAt"] = day(iss.get("closed_at"))
            if iss.get("title"):
                out["title"] = iss["title"].strip()
            out["issueUrl"] = iss.get("html_url") or out["issueUrl"]
            if iss.get("state") == "open":
                out["status"] = "Open"
            elif iss.get("state") == "closed":
                out["status"] = f"Closed {out['issueClosedAt']}" if out["issueClosedAt"] else "Closed"
        except Exception as e:  # noqa: BLE001
            out["error"] = f"issue fetch failed: {e}"

    # --- the linked pull request, if the tracker recorded a real one ---
    m = re.search(r"github\.com/([^/]+/[^/]+)/pull/(\d+)", pr_url)
    if m:
        pr_repo, pr_no = m.group(1), int(m.group(2))
        out["prNumber"] = pr_no
        out["prUrl"] = f"https://github.com/{pr_repo}/pull/{pr_no}"
        try:
            pr = get_json(f"/repos/{pr_repo}/pulls/{pr_no}", api_base)
            if pr.get("merged_at"):
                out["prState"] = "merged"
                out["prDate"] = day(pr["merged_at"])
                out["prLabel"] = f"PR #{pr_no} merged {out['prDate']}"
            elif pr.get("state") == "open":
                out["prState"] = "open"
                out["prLabel"] = f"PR #{pr_no} open"
            else:
                out["prState"] = "closed"
                out["prDate"] = day(pr.get("closed_at"))
                out["prLabel"] = f"PR #{pr_no} closed unmerged {out['prDate']}"
        except Exception as e:  # noqa: BLE001
            out["error"] = (out["error"] + " " if out["error"] else "") + f"pr fetch failed: {e}"
            out["prLabel"] = f"PR #{pr_no}"
    elif not re.fullmatch(r"\d+", issue_no or ""):
        out["prLabel"] = ""

    # --- pipeline stage: PR outcome first, then the issue's own state ---
    if out["prState"] == "merged":
        out["stage"] = "Merged"
    elif out["prState"] == "open":
        out["stage"] = "PR open"
    elif out["prState"] == "closed":
        out["stage"] = "PR closed unmerged"
    elif out["issueState"] == "open":
        out["stage"] = "Issue open"
    elif out["issueState"] == "closed":
        out["stage"] = "Issue closed"

    # Rows that track a PR (or a product) rather than an issue.
    if out["issueState"] is None and not out["error"]:
        out["status"] = "PR only" if out["prNumber"] else "No linked issue"

    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api-base", default="http://127.0.0.1:8792")
    ap.add_argument("--out", default="data/prs.json")
    ap.add_argument("--sheet-csv", default=None, help="local CSV instead of downloading the sheet")
    args = ap.parse_args()

    if args.sheet_csv:
        with open(args.sheet_csv, newline="", encoding="utf-8") as f:
            raw = list(csv.DictReader(f))
    else:
        url = f"https://docs.google.com/spreadsheets/d/{sheet_id()}/gviz/tq?tqx=out:csv&sheet=Sheet1"
        with urllib.request.urlopen(url, timeout=60) as res:
            raw = list(csv.DictReader(io.StringIO(res.read().decode("utf-8"))))
    raw = [r for r in raw if (r.get("Repo") or "").strip()]
    print(f"sheet rows: {len(raw)}", file=sys.stderr)

    with ThreadPoolExecutor(max_workers=10) as ex:
        rows = list(ex.map(lambda r: build_row(r, args.api_base), raw))

    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": "GitHub API issue and PR objects; row list from the PR tracker sheet (read only)",
        "rows": rows,
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=1, ensure_ascii=False)
    print(f"wrote {args.out}: {len(rows)} rows", file=sys.stderr)

    # --- discrepancy report: where did the sheet status misstate the issue? ---
    wrong_open, wrong_date, wrong_stale = [], [], []
    for r in rows:
        if r["issueState"] is None:
            continue
        head = r["trackerStatus"]
        mdate = re.search(r"(?:CLOSED|MERGED)[^0-9]*(\d{4}-\d{2}-\d{2})", head, re.I)
        claims_closed = bool(re.search(r"\b(CLOSED|MERGED)\b", head, re.I))
        if claims_closed and r["issueState"] == "open":
            wrong_open.append(r)
        elif claims_closed and mdate and r["issueClosedAt"] and mdate.group(1) != r["issueClosedAt"]:
            wrong_date.append(r)
        elif r["issueState"] == "closed" and not claims_closed:
            wrong_stale.append(r)
    errs = [r for r in rows if r["error"]]
    print(f"WRONG (sheet said closed/merged, issue open): {len(wrong_open)}", file=sys.stderr)
    for r in wrong_open:
        print(f"  {r['repo']} #{r['issue']}: sheet={r['trackerStatus'][:60]!r} issue=open", file=sys.stderr)
    print(f"WRONG DATE (issue closed on a different day than sheet said): {len(wrong_date)}", file=sys.stderr)
    for r in wrong_date:
        print(f"  {r['repo']} #{r['issue']}: sheet={r['trackerStatus'][:60]!r} issue closed {r['issueClosedAt']}", file=sys.stderr)
    print(f"WRONG (issue closed, sheet showed an open pipeline stage): {len(wrong_stale)}", file=sys.stderr)
    for r in wrong_stale:
        print(f"  {r['repo']} #{r['issue']}: sheet={r['trackerStatus'][:60]!r} issue closed {r['issueClosedAt']}", file=sys.stderr)
    print(f"fetch errors: {len(errs)}", file=sys.stderr)
    for r in errs:
        print(f"  {r['repo']} #{r['issue']}: {r['error']}", file=sys.stderr)


if __name__ == "__main__":
    main()
