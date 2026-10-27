"""Copy sent applications from JobHuntAgent's local tracker into Supabase.

    python3 scripts/import_jobhunt.py            # preview only, uploads nothing
    python3 scripts/import_jobhunt.py --upload   # back up jobs.db, then upload

Only sent applications are copied (APPLIED, EMAILED, INTERVIEWING, OFFER,
EMPLOYER_REJECTED). Jobs still under review or passed on stay local.
Re-running is safe: rows are matched on the tracker's job id and replaced.

Not copied: recruiter emails, scrape source, match score, missing keywords,
local file paths (only the file name is kept), and status-history notes.

Uses SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and ALLOWED_EMAIL from .env.
Never prints keys. Python 3.9+, standard library only.
"""
import argparse
import json
import sqlite3
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB = ROOT.parent / "JobHuntAgent" / "data" / "jobs.db"
SENT = ("APPLIED", "EMAILED", "INTERVIEWING", "OFFER", "EMPLOYER_REJECTED")


def load_env():
    env = {}
    for line in (ROOT / ".env").read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip("\"'")
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "ALLOWED_EMAIL"):
        if not env.get(k):
            sys.exit(f"{k} is missing from .env")
    url = env["SUPABASE_URL"].rstrip("/")
    if url.endswith("/rest/v1"):
        url = url[: -len("/rest/v1")]
    env["SUPABASE_URL"] = url
    return env


def split_list(text):
    """Tracker strengths/weaknesses are '; '-separated prose."""
    if not text:
        return []
    return [p.strip().rstrip(".") + "." for p in text.split(";") if p.strip()]


def file_name(path):
    return Path(path).name if path else None


def date_only(value):
    return value[:10] if value else None


def read_tracker(db_path):
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    marks = ",".join("?" * len(SENT))
    jobs = con.execute(f"select * from jobs where status in ({marks}) order by id", SENT).fetchall()
    out = []
    for j in jobs:
        answers = con.execute(
            "select position, question, answer, char_limit from answers where job_id=? order by position",
            (j["id"],)).fetchall()
        history = con.execute(
            f"select status, at from status_history where job_id=? and status in ({marks}) order by at",
            (j["id"], *SENT)).fetchall()
        out.append({
            "job": {
                "source_id": j["id"],
                "company": j["company"],
                "role_title": j["role_title"],
                "location": j["location"],
                "url": j["url"],
                "jd_text": j["jd_text"],
                "status": j["status"],
                "applied_on": date_only(j["applied_on"]),
                "fit_score": j["fit_score"],
                "odds_score": j["odds_score"],
                "strengths": split_list(j["strengths"]),
                "gaps": split_list(j["weaknesses"]),
                "resume_file": file_name(j["resume_pdf_path"]),
                "cover_letter_file": file_name(j["cover_letter_path"]),
                "notes": j["notes"],
            },
            "answers": [dict(a) for a in answers],
            "history": [{"status": h["status"], "changed_at": h["at"]} for h in history],
        })
    con.close()
    return out


def preview(records):
    print(f"{len(records)} sent applications will be copied:\n")
    print(f"  {'id':>3}  {'status':<17} {'applied':<10}  {'fit':>3}  {'ans':>3}  {'hist':>4}  docs  company / role")
    for r in records:
        j = r["job"]
        docs = ("R" if j["resume_file"] else "-") + ("C" if j["cover_letter_file"] else "-")
        print(f"  {j['source_id']:>3}  {j['status']:<17} {j['applied_on'] or '(none)':<10}  "
              f"{j['fit_score'] if j['fit_score'] is not None else '-':>3}  {len(r['answers']):>3}  "
              f"{len(r['history']):>4}  {docs:<4}  {j['company']} / {j['role_title']}")
    n_ans = sum(len(r["answers"]) for r in records)
    n_hist = sum(len(r["history"]) for r in records)
    n_jd = sum(1 for r in records if r["job"]["jd_text"])
    print(f"\nTotals: {len(records)} jobs ({n_jd} with full posting text), "
          f"{n_ans} form answers, {n_hist} status-history entries.")
    print("Docs: R = resume file name, C = cover letter file name (names only, no files are uploaded).")


class Supabase:
    def __init__(self, env):
        self.url = env["SUPABASE_URL"]
        self.key = env["SUPABASE_SERVICE_ROLE_KEY"]

    def call(self, method, path, body=None, prefer=None):
        req = urllib.request.Request(self.url + path, method=method,
                                     data=json.dumps(body).encode() if body is not None else None)
        req.add_header("apikey", self.key)
        req.add_header("Authorization", f"Bearer {self.key}")
        req.add_header("Content-Type", "application/json")
        if prefer:
            req.add_header("Prefer", prefer)
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                text = res.read().decode()
                return json.loads(text) if text else None
        except urllib.error.HTTPError as e:
            detail = e.read().decode()[:300]
            sys.exit(f"Supabase {method} {path.split('?')[0]} failed: HTTP {e.code} {detail}")

    def owner_id(self, email):
        page = 1
        while True:
            users = self.call("GET", f"/auth/v1/admin/users?page={page}&per_page=100")["users"]
            for u in users:
                if (u.get("email") or "").lower() == email.lower():
                    return u["id"]
            if len(users) < 100:
                sys.exit("No account for ALLOWED_EMAIL yet. Run `npm run check:rls` once to create it.")
            page += 1


def backup(db_path):
    dest_dir = db_path.parent / "backups"
    dest_dir.mkdir(exist_ok=True)
    dest = dest_dir / f"jobs-{datetime.now().strftime('%Y%m%d-%H%M%S')}.db"
    src = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    out = sqlite3.connect(dest)
    src.backup(out)
    out.close()
    src.close()
    return dest


def upload(env, records):
    sb = Supabase(env)
    uid = sb.owner_id(env["ALLOWED_EMAIL"])
    for r in records:
        row = dict(r["job"], user_id=uid)
        saved = sb.call("POST", "/rest/v1/jobs?on_conflict=user_id,source_id", [row],
                        prefer="resolution=merge-duplicates,return=representation")[0]
        jid = saved["id"]
        # Replace children so re-runs mirror the tracker exactly.
        sb.call("DELETE", f"/rest/v1/application_answers?job_id=eq.{jid}")
        sb.call("DELETE", f"/rest/v1/status_history?job_id=eq.{jid}")
        if r["answers"]:
            sb.call("POST", "/rest/v1/application_answers",
                    [dict(a, user_id=uid, job_id=jid) for a in r["answers"]])
        if r["history"]:
            sb.call("POST", "/rest/v1/status_history",
                    [dict(h, user_id=uid, job_id=jid) for h in r["history"]])
        print(f"  uploaded {r['job']['source_id']:>3}  {r['job']['company']}")

    # Verify counts match what was sent.
    jobs = sb.call("GET", f"/rest/v1/jobs?select=id&user_id=eq.{uid}&source_id=not.is.null")
    ans = sb.call("GET", f"/rest/v1/application_answers?select=id&user_id=eq.{uid}")
    hist = sb.call("GET", f"/rest/v1/status_history?select=id&user_id=eq.{uid}")
    want = (len(records), sum(len(r["answers"]) for r in records), sum(len(r["history"]) for r in records))
    got = (len(jobs), len(ans), len(hist))
    ok = got == want
    print(f"\nIn Supabase: {got[0]} jobs, {got[1]} answers, {got[2]} history entries "
          f"(expected {want[0]}, {want[1]}, {want[2]})  {'PASS' if ok else 'MISMATCH'}")
    return ok


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", type=Path, default=DEFAULT_DB)
    ap.add_argument("--upload", action="store_true", help="back up jobs.db, then upload")
    args = ap.parse_args()

    if not args.db.exists():
        sys.exit(f"Tracker not found: {args.db}")
    records = read_tracker(args.db)
    preview(records)
    if not args.upload:
        print("\nPreview only. Nothing was uploaded. Re-run with --upload to copy.")
        return
    env = load_env()
    dest = backup(args.db)
    print(f"\nBacked up tracker to {dest}")
    sys.exit(0 if upload(env, records) else 1)


if __name__ == "__main__":
    main()
