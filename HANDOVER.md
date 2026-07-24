# RecruitFlow — Project Handover

Owner: Lishita Dua (lishitadua@urbancompany.com) · Repo: https://github.com/lishitadua-uc/RecruitFlow

This document is a cold-start handover: what the platform is, how to run it, how it's built,
what was decided and why, known caveats, and where to go next.

---

## 1. What it is (in one paragraph)

**RecruitFlow** is a self-hosted recruiter tool. It runs on one laptop, sends candidate
outreach from the recruiter's **own WhatsApp number**, runs a full structured screening
conversation (mostly tappable WhatsApp polls, with Hindi/Hinglish support), books a
15-minute recruiter call on Google Calendar, and shows everything on a local white-themed
dashboard. It **never rejects** a candidate — anyone who doesn't meet auto-schedule criteria
is routed to human review and flagged. It's engineered to survive a flaky personal-WhatsApp
link and a sleeping laptop. Free keyword rules run the conversation by default (zero cost);
an optional Claude AI layer only fires for messages the rules can't parse.

---

## 2. How to run it

**Download:** https://github.com/lishitadua-uc/RecruitFlow/archive/refs/heads/main.zip
(or green **Code → Download ZIP** on the repo)

- **macOS:** unzip → double-click **`start.command`** (first time: right-click → Open → Open).
- **Windows:** install Node.js 22 from nodejs.org → unzip → double-click **`start.bat`**.
- **Linux/manual:** `npm install` then `npm start`.

First run self-installs Node deps (incl. a headless Chromium, ~2–3 min) and opens the
dashboard at **http://localhost:3000**. Then click the WhatsApp status → **scan the QR** from
your phone (WhatsApp → Settings → Linked Devices → Link a Device).

Each teammate runs their **own copy** on their **own laptop** with their **own WhatsApp** —
data is private per machine, nothing is shared or uploaded.

> ⚠️ Automating a personal WhatsApp number is against WhatsApp's Terms and can get the number
> restricted/banned — keep volumes low. This is the single biggest operational risk.

---

## 3. Files & where things live

| File | Purpose |
|---|---|
| `server.js` | Everything backend: Express API, WhatsApp bot, the conversation flow engine, scheduling, self-healing. ~1700 lines. |
| `index.html` | The entire dashboard (vanilla JS, no framework). |
| `start.command` / `start.bat` | One-click launchers (macOS / Windows). |
| `package.json` | Deps: express, whatsapp-web.js, qrcode, nodemailer, imapflow, mailparser, @anthropic-ai/sdk, googleapis. |
| `README.md` | Download-and-run instructions (renders on the repo page). |
| `CONVERSATION-FLOW.md` | Plain-English description of the screening conversation. |
| `BUILD-PROMPT.md` | Full feature spec + verbatim chat scripts to rebuild the platform from scratch on Claude. |
| **Git-ignored (private, per-laptop):** | `data.json` (all jobs/candidates/settings), `.wwebjs_auth/` (WhatsApp session), `uploads/` (resumes/JDs), `server.log` |

**macOS always-on:** a launchd LaunchAgent (`~/Library/LaunchAgents/com.urbancompany.recruitflow.plist`)
auto-starts it on login, keeps it alive, and runs it under `caffeinate` so the Mac doesn't
sleep. (Windows has no equivalent yet — see Caveats.)

---

## 4. Architecture in 60 seconds

- **One stage machine** — `handleIncoming(candidate, channel, text)` in `server.js` drives the
  whole conversation. Same engine powers WhatsApp (`c.wa`) and the (paused) email channel (`c.em`).
- **Rules-first** — `rulesUnderstand()` decides if free keyword rules can handle a message.
  Only if they can't, AND an Anthropic key is set, does it call Claude. Default install is
  100% free and deterministic.
- **Polls-first UX** — ~70–80% of questions are native WhatsApp polls; the rest are open text.
  Candidates can always type instead of tapping.
- **JSON persistence** — the whole `db` object is written to `data.json` by `save()` (no
  database). `RF_TEST=1` makes `save()` a no-op for tests.
- **Dashboard** — polls `GET /api/state` and `GET /api/status` every ~3s and re-renders.

The screening stage order (never rejects anyone):
`outreach → location → workpref → preflocation → experience → currentctc → expectedctc →
notice → skills → resume → availdate → availtime → scheduled`.

For the full feature-by-feature breakdown **read `BUILD-PROMPT.md`** — it documents all 17
features with sub-features and how each works.

---

## 5. What was built (development journey & key decisions)

Chronological summary of what this project went through, so the team knows *why* things are
the way they are:

1. **WhatsApp-only mode.** Automatic email outreach was paused; WhatsApp is the channel.
   Manual email send stays available. Follow-up nudges: 24h, then +48h, then stop.
2. **Rules-first + optional AI.** Trained the free keyword engine extensively for real-world
   English and Hindi/Hinglish; AI (Claude) is an optional paid backstop, off by default.
3. **Poll-based conversation.** Most questions became tappable WhatsApp polls for a cleaner
   candidate experience.
4. **Never-reject policy (major spec change).** Reworked screening so no answer ever rejects a
   candidate. Notice ≤ 60 days auto-schedules; > 60 days → recruiter review. Experience below
   the role's range → recruiter review. All such cases are **flagged**, never rejected. CTC
   accepts any format; expected-below-current politely re-asks.
5. **15-minute recruiter "call"** (not "interview"), with an open-text fallback when none of
   the offered slots work, and day-of reminders to both the candidate and the recruiter.
6. **Location-mismatch handling.** If a candidate wants a different city, collect their
   preferred city, end warmly, and **park** them in `awaiting_role`. When a new job with the
   **same title + that city** is created, the candidate is **auto-added** and highlighted.
7. **Flagging as a Responses filter** (the separate "Flagged" tab was removed).
8. **Dashboard redesign** — clean white theme, more whitespace, clearer hierarchy, fewer
   buttons per row (primary + Chat + a ⋯ menu). Phone numbers normalized to `+91` (editable).
9. **Reliability hardening** (driven by real incidents — see below).
10. **Distribution** — public GitHub repo, README, Windows `start.bat`, shareable ZIP.

### Bugs found & fixed (real incidents — the team should know these existed)
- **Duplicate-candidate routing:** the same phone across two jobs routed replies to the wrong
  (old/closed) conversation → fixed to prefer the most recently active record.
- **Old-history replay:** on outreach, the catch-up sweep replayed a phone's *old* chat as
  fresh replies → fixed by stamping `lastProcessedTs` at outreach time.
- **Double outreach on double-click** → fixed with a synchronous in-flight lock + immediate
  stage flip.
- **Duplicate message processing** (real-time vs catch-up race) → fixed with per-candidate
  message-ID dedup.
- **Silent WhatsApp death** ("detached frame" Puppeteer errors left status stuck at "ready")
  → fixed by wrapping all sends to detect fatal errors and auto-recover.
- **LOGOUT loop:** a logged-out session cycled QR codes forever without linking → fixed by
  auto-wiping the dead session on next startup so a fresh QR appears.
- **Date mis-read as time:** "Saturday - 4 July" was read as "4 PM" and auto-scheduled without
  asking the time → fixed to require an explicit am/pm/time marker for combined date+time.
- **Repeated "I couldn't understand":** now holds an unclear message ~5 min for a clearer
  follow-up before replying, and drops it if a clear message arrives.

---

## 6. Day-to-day operations (for whoever runs it)

- **Add jobs/candidates** on the dashboard (single or CSV bulk). Set the job's location,
  days/week, required experience, max notice period, and custom skill questions.
- **Run outreach** with the ▶ WhatsApp button per candidate (or per job).
- **Watch the pipeline** (New → Outreach → In discussion → Scheduling → Scheduled ✓, plus
  Revisit / Pending review / Dropped).
- **Review flags** via the Responses → ⚑ Flagged filter; "✓ Mark reviewed" to clear.
- **Retrigger** re-sends the exact last question to a quiet candidate; the resurface banner
  surfaces candidates whose "reach out later" window has arrived.
- **Scheduled calls** land on Google Calendar (connect it in Settings) with both parties
  invited; otherwise an `.ics` invite is emailed.
- Keep the app window open (or rely on the macOS launchd auto-start) and the laptop plugged in.

---

## 7. Known caveats / open risks

- **WhatsApp ToS risk** — personal-number automation can get the number restricted. Highest risk.
  Keep volumes modest.
- **Connection stability** — the personal-WhatsApp link can drop; it self-heals, but expect
  occasional QR re-scans (especially after a phone-side logout).
- **Windows is not always-on** — `start.bat` runs only while its window is open; there's no
  Task Scheduler / keep-awake setup yet (macOS has it via launchd + caffeinate).
- **`start.bat` is unverified on real Windows** — it was written on a Mac; have one Windows
  teammate smoke-test it.
- **Google Calendar / email** need per-user setup in Settings (OAuth creds / Gmail app password).
- **Duplicate candidate records** for the same person across jobs are allowed by design
  (multi-job outreach) — just be aware when reading the candidate list.
- **AI layer** costs money if enabled (needs an Anthropic key); it's off by default.

---

## 8. Suggested next steps

- Windows always-on (Task Scheduler auto-start + prevent-sleep) to match macOS.
- Package a macOS `.app` and/or a GitHub Release for a cleaner, versioned download link.
- Verify `start.bat` on a real Windows machine.
- Optional: a lightweight shared view/export if the team wants central visibility (today each
  copy is fully local/private).

---

## 9. Key links

- **Repo:** https://github.com/lishitadua-uc/RecruitFlow
- **One-click download:** https://github.com/lishitadua-uc/RecruitFlow/archive/refs/heads/main.zip
- **Local dashboard (while running):** http://localhost:3000
- **Rebuild-from-scratch spec:** `BUILD-PROMPT.md` in the repo
- **Conversation reference:** `CONVERSATION-FLOW.md` in the repo
