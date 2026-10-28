"""Copy the confirmed profile and sent documents from JobHuntAgent into Supabase.

    python3 scripts/import_profile.py            # preview only, uploads nothing
    python3 scripts/import_profile.py --upload   # upload

Sources (read-only):
  candidate_profile/skill_profile.md   skills, results, roles, education, summary
                                       (the consolidated, confirmed profile)
  candidate_profile/verified_facts.md  only the job-preference lines
                                       (minimum salary, start date, location, titles)
  candidate_profile/karen_base_resume.pdf, plus each sent resume and cover letter
  PDF recorded in data/jobs.db, stored privately and linked to its job

Never uploaded: phone number, current salary, political interests, and the
"accuracy rules" / caveat lines (they are instructions, not facts).

Re-running is safe: imported facts are replaced, preferences are merged, and
files already uploaded are skipped (sent documents are locked in the database).
Uses SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and ALLOWED_EMAIL from .env.
"""
import argparse
import json
import re
import sqlite3
import sys
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from import_jobhunt import Supabase, load_env  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
JHA = ROOT.parent / "JobHuntAgent"
PROFILE = JHA / "candidate_profile" / "skill_profile.md"
FACTS = JHA / "candidate_profile" / "verified_facts.md"
DB = JHA / "data" / "jobs.db"
SENT = ("APPLIED", "EMAILED", "INTERVIEWING", "OFFER", "EMPLOYER_REJECTED")
DASHES = str.maketrans({"–": "-", "—": "-"})


def bullets(lines):
    """Markdown bullets with wrapped continuation lines joined."""
    out = []
    for line in lines:
        if line.startswith("- "):
            out.append(line[2:].strip())
        elif out and line.startswith("  ") and line.strip():
            out[-1] += " " + line.strip()
    return [b.translate(DASHES) for b in out]


def sections(text, level):
    """{heading: [lines]} for headings of exactly this level."""
    marker = "#" * level + " "
    out, current = {}, None
    for line in text.splitlines():
        if line.startswith(marker):
            current = line[len(marker):].strip()
            out[current] = []
        elif re.match(r"^#{1,%d} " % (level - 1), line):
            current = None
        elif current is not None:
            out[current].append(line)
    return out


def parse_profile(text):
    facts = []
    top = sections(text, 2)
    summary = " ".join(l.strip() for l in top.get("Professional profile", []) if l.strip())
    if summary:
        facts.append(("summary", "Summary", summary.translate(DASHES)))

    skill_block = "\n".join(top.get("Skill profile", []))
    for group, lines in sections("## x\n" + skill_block, 3).items():
        name = group.split(" and ")[0] if len(group) > 40 else group
        for b in bullets(lines):
            facts.append(("skill", name[:120], b))

    acc_block = "\n".join(top.get("Verified accomplishments", []))
    for heading, lines in sections("## x\n" + acc_block, 3).items():
        employer, _, title = heading.partition(" - ")
        employer = employer.strip()
        if title:
            facts.append(("role", employer, f"{title.strip()}, {employer}".translate(DASHES)))
        for b in bullets(lines):
            facts.append(("result", employer[:120], b))

    for b in bullets(top.get("Education", [])):
        facts.append(("education", "Education", b))
    return facts


def parse_prefs(text):
    """Only the preference lines; salary history and contact details are left out."""
    lines = {}
    for b in bullets(sections(text, 2).get("Compensation and availability", [])):
        key, _, value = b.partition(":")
        lines[key.strip().lower()] = value.strip()
    prefs = {}
    m = re.search(r"\$?([\d,]+)", lines.get("minimum acceptable", ""))
    if m:
        prefs["salary_min"] = int(m.group(1).replace(",", ""))
    if lines.get("earliest start date"):
        prefs["earliest_start"] = lines["earliest start date"]
    if lines.get("locations"):
        prefs["location"] = lines["locations"]
    if lines.get("target titles"):
        prefs["target_titles"] = lines["target titles"]
    return prefs


def sent_documents():
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    marks = ",".join("?" * len(SENT))
    docs = [{"kind": "resume", "path": JHA / "candidate_profile" / "karen_base_resume.pdf",
             "title": "Base resume", "source_id": None, "sent": False, "date": None}]
    for j in con.execute(f"select id, company, applied_on, resume_pdf_path, cover_letter_path from jobs where status in ({marks}) order by id", SENT):
        for kind, rel in (("resume", j["resume_pdf_path"]), ("letter", j["cover_letter_path"])):
            if rel:
                docs.append({"kind": kind, "path": JHA / rel, "source_id": j["id"], "sent": True, "date": (j["applied_on"] or "")[:10] or None,
                             "title": f"{'Resume' if kind == 'resume' else 'Cover letter'} · {j['company']}"})
    con.close()
    return docs


def preview(facts, prefs, docs):
    from collections import Counter
    print("Profile facts (all marked confirmed, source: import):")
    for kind, n in Counter(k for k, _, _ in facts).items():
        print(f"  {n:>3} {kind}")
    print("\n  Sample:")
    for kind in ("summary", "skill", "result", "role", "education"):
        for k, g, t in [f for f in facts if f[0] == kind][:2]:
            print(f"   [{k}/{g}] {t[:110]}{'...' if len(t) > 110 else ''}")
    print("\nJob preferences:")
    for k, v in prefs.items():
        print(f"  {k}: {v}")
    print("\nDocuments (stored privately in Supabase Storage):")
    for d in docs:
        state = "missing!" if not d["path"].exists() else f"{d['path'].stat().st_size // 1024} KB"
        print(f"  {'SENT ' if d['sent'] else 'base '} {d['kind']:<6} {d['path'].name:<58} {state}")
    print("\nNot uploaded: phone, current salary, political interests, accuracy rules and caveats.")


def upload(env, facts, prefs, docs):
    sb = Supabase(env)
    uid = sb.owner_id(env["ALLOWED_EMAIL"])

    sb.call("DELETE", f"/rest/v1/profile_facts?user_id=eq.{uid}&source=eq.import")
    pos = {}
    rows = []
    for kind, group, text in facts:
        pos[(kind, group)] = pos.get((kind, group), 0) + 1
        rows.append({"user_id": uid, "kind": kind, "group_title": group, "position": pos[(kind, group)],
                     "text": text, "verified": True, "source": "import"})
    sb.call("POST", "/rest/v1/profile_facts", rows)
    print(f"  {len(rows)} facts")

    sb.call("POST", "/rest/v1/profile_prefs?on_conflict=user_id", [{"user_id": uid, **prefs}],
            prefer="resolution=merge-duplicates")
    print(f"  preferences ({', '.join(prefs)})")

    jobs = {j["source_id"]: j["id"] for j in sb.call("GET", f"/rest/v1/jobs?select=id,source_id&user_id=eq.{uid}") if j["source_id"]}
    existing = {d["file_path"] for d in sb.call("GET", f"/rest/v1/documents?select=file_path&user_id=eq.{uid}") if d["file_path"]}
    added = 0
    for d in docs:
        if not d["path"].exists():
            print(f"  skipped (file missing): {d['path'].name}")
            continue
        object_path = f"{uid}/import/{d['path'].name}"
        if object_path in existing:
            continue
        sb.upload(f"/storage/v1/object/docs/{urllib.parse.quote(object_path)}", d["path"].read_bytes(), "application/pdf")
        sb.call("POST", "/rest/v1/documents", [{
            "user_id": uid, "job_id": jobs.get(d["source_id"]), "kind": d["kind"], "source": "uploaded",
            "title": d["title"], "file_path": object_path, "file_name": d["path"].name,
            "sent": d["sent"], "sent_at": f"{d['date']}T12:00:00Z" if d["sent"] and d["date"] else None}])
        added += 1
    print(f"  {added} documents uploaded ({len(docs) - added} already there or missing)")

    n_facts = len(sb.call("GET", f"/rest/v1/profile_facts?select=id&user_id=eq.{uid}&source=eq.import"))
    n_docs = len(sb.call("GET", f"/rest/v1/documents?select=id&user_id=eq.{uid}"))
    ok = n_facts == len(rows)
    print(f"\nIn Supabase: {n_facts} imported facts (expected {len(rows)}), {n_docs} documents  {'PASS' if ok else 'MISMATCH'}")
    return ok


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--upload", action="store_true")
    args = ap.parse_args()
    facts = parse_profile(PROFILE.read_text())
    prefs = parse_prefs(FACTS.read_text())
    docs = sent_documents()
    preview(facts, prefs, docs)
    if not args.upload:
        print("\nPreview only. Nothing was uploaded. Re-run with --upload to copy.")
        return
    print("\nUploading...")
    sys.exit(0 if upload(load_env(), facts, prefs, docs) else 1)


if __name__ == "__main__":
    main()
