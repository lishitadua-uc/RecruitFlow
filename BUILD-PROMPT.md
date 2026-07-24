# RecruitFlow — End-to-End Build Prompt

Copy everything below into Claude to rebuild the platform from scratch.

---

## ▓▓▓ PART 1 — THE PROMPT (paste this to Claude) ▓▓▓

> Build me a local recruitment-automation platform called **RecruitFlow** that runs entirely
> on one macOS laptop, runs candidate outreach and screening over the recruiter's **own
> WhatsApp number**, books a recruiter call, and shows everything on a live local dashboard.
> No cloud, no login, no external database. Below is the full feature spec — build each
> feature with the sub-features and the exact working described. Use the verbatim message
> texts from the "Chat training" section (Part 3) for every candidate-facing message.

### Tech stack & shape
- **Node.js 22 + Express** — one `server.js` that serves both a REST API and a static
  dashboard on `http://localhost:3000`.
- **whatsapp-web.js** (headless Chromium via Puppeteer) for WhatsApp automation.
- **One `index.html`** dashboard — vanilla JS, no framework.
- **One `data.json`** for all persistence (no DB).
- **Google Calendar** (OAuth) + `.ics` email fallback for booked calls.
- **Optional `@anthropic-ai/sdk`** (model `claude-opus-4-8`), OFF by default.
- Files: `server.js`, `index.html`, `start.command`, `package.json`, `README.md`,
  `CONVERSATION-FLOW.md`. Git-ignore `data.json`, `.wwebjs_auth/`, `uploads/`, `server.log`.

---

### FEATURE 1 — Local-first deployment & always-on runtime
**What it is:** the whole platform runs on the recruiter's laptop with zero infrastructure.
**Sub-features:**
- One-click launcher (`start.command`) — double-click to run.
- Auto-start on login + auto-restart on crash.
- Keeps the Mac awake so it keeps replying while the screen is locked.
- First-run self-setup (installs Node + npm deps automatically).

**How it works:** `start.command` is a bash script — on first run it downloads a private
Node 22 build if none exists, runs `npm install` (which fetches the headless Chromium), then
launches `server.js` under `caffeinate -dims` (prevents display/idle/disk/system sleep) and
opens the browser to `:3000`. A **launchd LaunchAgent** plist (`RunAtLoad`, `KeepAlive`,
`ThrottleInterval`) starts it at login, relaunches it if it ever exits, and sets an
`RF_MANAGED=1` env var. The server detects `RF_MANAGED` to choose its recovery strategy
(see Feature 11). `save()` persists the entire in-memory `db` object to `data.json`; an
`RF_TEST` env flag makes `save()` a no-op so automated tests never touch real data.

---

### FEATURE 2 — WhatsApp integration (own number)
**What it is:** sends and receives on the recruiter's personal WhatsApp via a linked device.
**Sub-features:**
- QR linking with an auto-refreshing code in the dashboard.
- Native **WhatsApp Polls** for tappable answers + free-text fallback.
- Strict inbound matching — only ever replies to people the recruiter contacted.
- Ignores WhatsApp voice/video-call notifications and system messages.
- Resolves masked `@lid` privacy IDs to the real phone number.

**How it works:** a whatsapp-web.js `Client` with `LocalAuth` (session saved in
`.wwebjs_auth/`). `client.on('qr')` renders a data-URL QR the dashboard polls and shows;
`client.on('ready')` flips status to ready. Outgoing structured questions are sent as `Poll`
objects; answers arrive via the `vote_update` event, mapped back to text by `voteToAnswer()`.
Incoming text arrives via `client.on('message')`: it first drops group/status/`fromMe`
messages and message `type`s like `call_log`/`e2e_notification` (so a missed call never
triggers a reply), then `resolveNumber()` extracts the real number (preferring
`contact.id.server === 'c.us'`) because WhatsApp now masks senders as `@lid`. Then
`findCandidateByPhone()` matches the sender to a contacted candidate — **unknown numbers are
ignored entirely** (no auto-reply). The matched chat is pinned to the candidate via `chatId`.

---

### FEATURE 3 — Channel-agnostic conversation flow engine (the brain)
**What it is:** one stage machine that runs the entire screening conversation.
**Sub-features:**
- Single `handleIncoming(candidate, channel, text)` drives both WhatsApp (`c.wa`) and the
  (paused) email channel (`c.em`) identically.
- A fixed, ordered stage sequence with per-stage prompts.
- Hybrid **poll-or-text** rendering per stage (~70–80% polls, rest open text).
- "Pending" sub-states for follow-up questions inside a stage.

**How it works:** each candidate is `{ id, jobId, name, email, phone, dnc, wa:{...}, em:{...} }`
and each channel is `{ stage, answers, flags, transcript, pending, chatId, skillIdx,
activePoll, activePollMsgId, lastProcessedTs, nudgeCount }`. `handleIncoming` switches on
`ch.stage`, records the answer into `ch.answers`, and calls `advance(c, ch, nextStage, out)`
which sets the stage and pushes that stage's prompt via `stagePrompt()`. **Stage order:**
`outreach → location → workpref → preflocation → experience → currentctc → expectedctc →
notice → skills → resume → availdate → availtime → scheduled`. When a stage is poll-able,
`sendRepliesWA()` sends the native poll instead of the text prompt (it matches the pushed
prompt text against `pollForStage()` and suppresses the duplicate text). **Pending
sub-states** handle mid-stage follow-ups without changing stage — e.g. `last_working_day`
(after "serving notice"), `resume_file` (awaiting the attachment), `preflocation_more`/
`preflocation_extra` ("any other city?"), `avail_none_confirm`/`avail_open` (no slot fits).
While a `pending` is set, `sendRepliesWA()` suppresses any poll so the follow-up stays free text.

---

### FEATURE 4 — Rules-first understanding with optional AI
**What it is:** free keyword rules handle the conversation; Claude is a paid, optional backstop.
**Sub-features:**
- Deterministic intent/answer detectors (interest, comfort, experience, CTC, notice, dates,
  times) — no API cost.
- **Hindi / Hinglish** comprehension (haan, nahi, bilkul, theek hai, "chaar saal", etc.).
- AI layer that only fires for messages the rules genuinely can't parse.

**How it works:** for every inbound message, `rulesUnderstand(c, ch, text)` returns whether
the free rules can handle it at the current stage (e.g. at `experience` it checks
`detectExperience()`; at `notice` it checks the serving-notice regex / `detectNoticeDays()`).
If rules can handle it → run `handleIncoming` directly (free). Only if rules **cannot** parse
it **and** an Anthropic key is configured does it call `aiProcess() → aiDecide()`, which calls
Claude with a forced `decide` tool (returns intent + extracted value + language), then feeds
the canonical value back into the same rule engine so polls/flags/scheduling still run. AI is
off unless a key is added in Settings, so the default install is 100% free and deterministic.

---

### FEATURE 5 — Structured screening (fixed order, mostly polls)
**What it is:** the ordered set of questions every interested candidate goes through.
**Sub-features & exact formats:**
1. **Outreach** — intro text + JD PDF + interest **poll** (Yes / Not now).
2. **Current location** — open text.
3. **Comfort with office location** — **poll** (Yes / No), shows city + days/week.
4. **Preferred location(s)** — open text; after each city, asks "any other city?" until "no".
5. **Total experience** — **poll** (0–2 / 3–5 / 5–8 / 8+).
6. **Current CTC** — open text.
7. **Expected CTC** — open text.
8. **Notice period** — **poll**; "serving notice" branches to a last-working-day text question.
9. **Recruiter-configurable questions** — **poll(s)**, Yes/No, or multi-choice if phrased "A or B".
10. **Resume** — open text, must be a PDF/Word **attachment** (never a link), or "skip".
11. **Date** — **poll** (next 5 dates from tomorrow).
12. **Time** — **poll** (11–12 … 4–5).

**How it works:**
- **CTC parsing** (`parseCTCValue`) accepts `12`, `12.5`, `12 LPA`, `₹12,00,000`, `1200000`,
  `8 lakh`, `8L`, and monthly figures (auto-converted to annual LPA). Expected CTC is compared
  to current; if lower, it politely re-asks — it **never rejects** over CTC.
- **Skill questions** come from the job. `parseSkillQuestionOptions()` detects an "A or B"
  phrasing and turns it into a proper 2-option poll; otherwise it's a Yes/No poll. `skillIdx`
  tracks which question is active.
- **Resume** must be a real file: an incoming WhatsApp media of type PDF/DOC/DOCX is saved to
  `uploads/`; a pasted link is rejected with a re-ask; "skip" moves on.
- **Notice "serving notice"** sets `pending='last_working_day'` and asks for the date as text.

---

### FEATURE 6 — "Never reject" screening logic
**What it is:** no answer ever triggers a rejection message; the bot either schedules or routes
to human review, always warmly.
**Sub-features:**
- Auto-schedule when the candidate clears simple criteria.
- Notice ≤ 60 days (default; per-job override) → schedule directly.
- Notice > 60 days → route to recruiter review (never reject).
- Experience below the role's required range → route to recruiter review.
- Everything else that can't auto-schedule → "recruiter will review your profile."

**How it works:** after the resume step, `proceedAfterScreening()` calls
`meetsAutoScheduleCriteria(ch, j)`, which returns false if `workComfortable === 'No'`, or
`noticePeriodDays > effectiveMaxNotice(j)` (the job's `maxNoticeDays`, else a
`DEFAULT_MAX_NOTICE_DAYS = 60`), or the candidate's experience bucket index is below the job's
required bucket (`expBucketIndex()` compares against the same bucket labels). If it passes →
`advance(...,'availdate')` (start scheduling). If not → `stage = 'pending_review'` with the
warm review message. **No branch produces a rejection.** `notice_dropout`/`location_dropout`
exist only as legacy terminal labels — new conversations never enter them.

---

### FEATURE 7 — Location-mismatch parking + auto-match to future jobs
**What it is:** a candidate who wants a different city isn't dropped — they're parked and
auto-pulled into a matching future opening.
**Sub-features:**
- If not comfortable with the office city, still collect preferred city(ies), then **end**
  gracefully ("we'll revisit when we have a relevant <role> in <city>").
- Park in an `awaiting_role` state (terminal, but tracked).
- When a **new job** with the **same title + a matching city** is created, **auto-add** the
  candidate to it and **highlight** them in that job as auto-added.

**How it works:** `afterPreferredLocation()` checks `workComfortable === 'No'` and, if so, sets
`stage = 'awaiting_role'`, flags the profile with what it's waiting for, and sends the
revisit message (instead of continuing to experience). On job creation (`POST /api/jobs`, only
for brand-new jobs), `autoMatchAwaitingCandidates(newJob)` scans all `awaiting_role`
candidates: if the candidate's original job title matches the new job's title (case-insensitive)
**and** `locationMatches(preferredLocation, newJob.location)` (handles multi-city lists,
"open to relocation" = matches anywhere, and partial names like Mumbai ↔ Navi Mumbai), it
creates a fresh `new`-stage candidate under the new job tagged `autoAdded` + `autoAddedFrom`.
It won't duplicate someone already in that job. The dashboard highlights auto-added rows
(light-blue row + "✨ auto-added" badge) and toasts a count on job creation.

---

### FEATURE 8 — Flagging system
**What it is:** surfaces anything a recruiter should personally eyeball.
**Sub-features:**
- Auto-flags: experience below range, the notice-period value (always), location parking.
- Question-flags: any candidate question the bot couldn't answer from templates.
- Idempotent — a flag of a given kind is refreshed, never duplicated on re-runs.
- **Flagged is a filter inside Responses** (not a separate tab), with one-click resolve.

**How it works:** `flagOnce(ch, kind, text)` pushes `{q, kind, auto, ts, resolved}` but updates
the existing entry if that `kind` already exists (so retriggers don't pile up duplicates).
`addScreeningFlags()` runs at `proceedAfterScreening` and flags experience-below-range and the
notice period (⚠ if beyond the window, ℹ if within). Template/unanswerable questions are
flagged inline during the chat. On the dashboard, the Responses view has a **Flagged** stat
card that filters to candidates with unresolved flags, a **⚑ Flags** column showing the reasons
inline, and "✓ Mark reviewed" → `POST /api/flags/resolve-all`.

---

### FEATURE 9 — Scheduling & calendar
**What it is:** books a 15-minute recruiter call and puts it on the calendar with both parties.
**Sub-features:**
- Date poll (next 5 dates) → time poll (six hourly slots). Calls are **15 minutes**.
- Open-text fallback when none of the offered dates work ("still want a call?" → propose your
  own date/time, booked directly).
- Direct Google Calendar insert (OAuth) inviting recruiter + candidate; `.ics` email + an
  "Add to Calendar" link as fallback when Calendar isn't connected.
- Reschedule handling after a call is booked.
- Confirmation wording is a **recruiter "call"**, not an "interview".

**How it works:** date selection stores `_dateISO`; time selection sets
`scheduledStartISO`/`scheduledEndISO` (start + 15 min) and `availability`, then
`confirmSchedule()` sets `stage='scheduled'` and calls `onScheduled()`. `onScheduled()` builds
one-tap `gcalLink()`s for both parties; if Calendar is connected it `insertGoogleEvent()`
(with `sendUpdates:'all'`), else it emails `.ics` invites. `matchExplicitTimeSlot()` only
treats a message as a time if it has an explicit am/pm/colon marker — so "Saturday - 4 July"
is never mis-read as "4 PM" (a bug that once auto-scheduled without asking the time).
`wantsReschedule()` after a booking re-opens the date/time polls.

---

### FEATURE 10 — Follow-ups, nudges & reminders
**What it is:** gentle re-engagement without spamming.
**Sub-features:**
- Quiet-candidate nudges: 24h after our last message, then +48h, then stop (max 2).
- Respects do-not-contact (opt-outs never get nudged).
- Day-of reminders to **both** the candidate and the recruiter's own number.

**How it works:** `checkNudges()` runs hourly; for any non-terminal channel whose last message
was ours and whose `nudgeCount < 2`, it sends the appropriate nudge text once the 24h / +48h
gap has passed, incrementing `nudgeCount`. `checkDayOfReminders()` runs every 30 min; on the
morning of a `scheduled` call (matched by `scheduledStartISO` date == today, once via a
`reminderSent` flag) it messages the candidate and pings the recruiter's own WhatsApp
(`waInfo`) with the candidate name, role, time, and phone.

---

### FEATURE 11 — Reliability & self-healing (critical: personal number + sleepy laptop)
**What it is:** the connection recovers itself and never silently dies or spams.
**Sub-features:**
- Clean Chrome on every start (kill stale processes, clear singleton locks).
- 90-second watchdog; full-process restart under launchd for the most reliable reset.
- Catches fatal Puppeteer errors instead of hanging as a fake "ready".
- Auto-resets a logged-out session so a fresh QR appears (no dead-QR loop).
- Periodic catch-up sweep to recover any missed messages.

**How it works:** `startWhatsApp()` runs `killStaleChrome()` + `clearChromeLocks()` before
`client.initialize()`. `armWatchdog()` sets a 90s timer; if the client isn't `ready`/`qr` by
then, `recoverWhatsApp()` fires — under `RF_MANAGED` it does `client.destroy()` then
`process.exit(1)` and lets launchd restart clean (fastest, most reliable). All sends go through
`waSend()`/`waIsRegistered()` wrappers that detect fatal errors (`detached Frame`,
`Execution context was destroyed`, `Session closed`, `Target closed`, `Protocol error`) and
trigger recovery instead of leaving `waStatus` stuck at "ready". On a **LOGOUT/CONFLICT**
disconnect, it writes a `.reset_session` marker; on next `startWhatsApp()` (Chrome already
dead → files unlocked) it wipes `.wwebjs_auth`/`.wwebjs_cache` and shows a clean QR.
`catchUpWhatsApp()` runs on reconnect and every 2 min: for each active candidate it fetches
recent chat messages newer than `lastProcessedTs` and processes any it missed.

---

### FEATURE 12 — "Never message randomly" guarantees
**What it is:** hard guarantees that no candidate gets an unexpected or duplicate message.
**Sub-features:**
- After outreach, the next message only goes out once the candidate has actually responded.
- No double outreach on a double-click.
- No re-processing the same message twice.
- Never replays a phone number's old chat history as fresh replies.
- Unclear messages wait for a clearer follow-up before the bot says "I couldn't understand".
- On duplicate phone records, routes to the most recently active conversation.

**How it works:**
- **Double-send lock:** `sendWhatsAppOutreachTo` holds a synchronous `sendingOutreach` Set +
  flips `stage='outreach'` *before any await*, so a second concurrent call fails the
  `stage !== 'new'` check and can't send again (rolls back to `new` only if the number isn't
  on WhatsApp).
- **Message dedup:** a `processedWaMsgKeys` Set keyed `candidateId|msgId` guards both the live
  handler and the catch-up sweep.
- **No history replay:** outreach stamps `lastProcessedTs = Date.now()`, so catch-up never
  treats pre-outreach chat history as new replies (the bug that once flushed old messages).
- **5-minute clarify hold:** when a message can't be parsed (and AI is off), it's held ~5 min
  in a `clarifyHold` map instead of instantly replying "couldn't understand"; if a clearer
  message arrives first, the held one is dropped and the bot replies only to the clear one.
- **Routing:** `findCandidateByPhone()` prefers the most recently active (non-terminal)
  matching record when one phone maps to several candidates (e.g. re-contacted for a 2nd job).

---

### FEATURE 13 — Retrigger & resurface
**What it is:** tools to re-engage a candidate on demand or when they're due.
**Sub-features:**
- **Retrigger** button — resends the exact question the candidate was last on (as its original
  poll if it was one), or re-opens with a fresh interest check if their conversation had ended.
- **Resurface banner** — surfaces candidates whose "reach out later" window has arrived, with
  Re-run / Dismiss actions.

**How it works:** `retriggerCandidate(c)` clears any pending/poll state, then either resends the
last system message from the transcript (poll-aware via `sendRepliesWA`) or, if terminal,
re-opens at `outreach` with a warm check-in. The resurface banner is driven by
`resurfaceDate` on declined-but-keep-profile candidates; "Re-run" calls the same retrigger.

---

### FEATURE 14 — Dashboard (single `index.html`)
**What it is:** the recruiter's whole control surface — clean white theme, lots of whitespace,
clear hierarchy.
**Sub-features:**
- Tabs: **Jobs & Candidates**, **Pipeline** (kanban), **Responses**, **Settings**.
- **Pipeline** columns: New → Outreach → In discussion → Scheduling → Scheduled ✓, plus
  Revisit later, Pending review, Dropped.
- **Responses**: every captured answer, filter cards (All / Interested / Scheduled / **Flagged**
  / Revisit / Dropped / Reject), sortable, CSV export.
- Tidy candidate rows: primary action (▶ WhatsApp / 🔁 Retrigger / status) + 💬 Chat + a **⋯
  menu** (Email / Edit / Delete) rendered as a body-level popup so the table's scroll can't clip it.
- Chat viewer with WhatsApp-style bubbles + manual reply box.
- Job form: title, location, days/week, remote, required experience, **max notice**, **custom
  skill questions**, JD PDF upload.
- **Phone normalized to +91** on save (prefilled "+91 " in the add form, editable, preserves an
  explicit other country code).
- WhatsApp connect modal with an auto-refreshing QR + live activity log.
- **Test Lab** — fire any sample message at any stage and see exactly how the bot reads & replies,
  without touching a real candidate.

**How it works:** vanilla JS polls `GET /api/state` (jobs + candidates) and `GET /api/status`
(WhatsApp/email/calendar status) every ~3s and re-renders. Actions are plain `fetch` calls to
the REST API. `pipeCol()` maps each candidate's stage to a pipeline column. The Test Lab hits
`POST /api/simulate`, which runs a throwaway candidate through the real `handleIncoming`
logic and returns `{engine, understood, decision, replies, newStage, answers}` without sending
anything or persisting.

---

### FEATURE 15 — Data model & persistence
**What it is:** everything in one JSON file; nothing private ever leaves the laptop.
**How it works:** `data.json` holds `{ company, jobs:[...], candidates:[...], settings:{...} }`.
Jobs carry title, location, workingDays, remote, experience, maxNoticeDays, skillQuestions, JD
file ref. Candidates carry identity + `wa`/`em` channel objects. `save()` writes the whole file
(no-op under `RF_TEST`). `.gitignore` excludes `data.json`, `.wwebjs_auth/`, `uploads/`,
`server.log` so the repo is shareable but private data stays local.

---

### FEATURE 16 — Email channel (optional, currently paused)
**What it is:** the same screening over email, reusing the flow engine.
**How it works:** SMTP send (nodemailer) + IMAP read (imapflow/mailparser). Incoming replies run
through the same `handleIncoming`. `isAutomatedEmail()` filters out no-reply/calendar/
notification emails so a forwarded Calendar invite is never mistaken for a candidate reply.
Automatic email is paused (WhatsApp-only mode); manual email send stays available from the
dashboard.

---

### FEATURE 17 — Test & QA harness
**What it is:** confidence that flow changes don't regress.
**How it works:** with `RF_TEST=1`, `save()` no-ops and the module exports `handleIncoming` and
detectors so offline scripts can drive conversations directly (fake channels, assert the
resulting stage/replies). Plus the in-app **Test Lab** endpoint for live manual checks.

Use the exact candidate-facing message texts from Part 3 verbatim.

---

## ▓▓▓ PART 2 — SUMMARY ▓▓▓

**RecruitFlow** is a self-hosted recruiter tool: it messages candidates from the recruiter's
own WhatsApp, runs a full structured screening conversation (mostly tappable polls), books a
15-minute recruiter call on Google Calendar, and shows everything on a local white-themed
dashboard. It **never rejects** a candidate — anyone who doesn't meet auto-schedule criteria is
routed to human review and flagged. It's built to survive a flaky personal-WhatsApp link and a
sleeping laptop: self-healing connection, session-reset on logout, no duplicate or random
messages, and catch-up recovery. Free keyword rules (incl. Hindi/Hinglish) handle the
conversation by default; an optional Claude layer only fires for messages the rules can't parse.

**Files:** `server.js` (backend + bot + flow engine), `index.html` (dashboard),
`start.command` (macOS launcher), `README.md`, `CONVERSATION-FLOW.md`, `package.json`.
**Runtime data (git-ignored):** `data.json`, `.wwebjs_auth/`, `uploads/`, `server.log`.

---

## ▓▓▓ PART 3 — CHAT TRAINING (verbatim messages) ▓▓▓

Placeholders: `{name}` candidate name · `{company}` = Urban Company · `{title}` job title ·
`{location}` job city · `{days}` office days/week · `{preferred}` candidate's preferred city.

### Reach-out (outreach) — text + JD PDF, then the interest poll
```
Hi {name}! 👋

I'm reaching out from *{company}*. We came across your profile and think you could be a great fit for our *{title}* role based in {location}.

📄 I've attached the full job description below — do take a look.

Are you open to exploring this opportunity? 😊 Feel free to ask me anything about the role.
```
**Interest POLL** — name: `Are you open to exploring this {title} opportunity? 😊`
options: `Yes, tell me more 👍` / `Not right now`

If they ask "what's this about / tell me more" instead of answering:
```
Of course! 😊 We're reaching out from *{company}* about a potential *{title}* opportunity that we think could be a great fit for you. Would you like to explore it further?
```

### 1. Current location (open text)
```
Great! 🙌 To help us find the best fit for you, I just have a few quick, easy questions.

First — which city are you currently based in?
```
If they give a vague answer (e.g. "anywhere"): `Got it! 🙂 And just so we have it right — which city are you *based in right now*?`

### 2. Comfort with office location — POLL
Prompt: `Lovely! This role is based in *{location}* and involves *{days} days/week from office*. There is no remote option for this role.\n\nAre you comfortable with that?`
POLL name: `This role is in {location} — {days} days/week from office (no remote option). Are you comfortable with this?`
options: `Yes, I'm comfortable` / `No, that won't work`
If **No**: `Thanks for being upfront about that! 🙂` → then ask preferred location → then END (see "Location mismatch" below).

### 3. Preferred location(s) (open text)
```
Thanks for sharing! 😊 And which city would you prefer to work in? (If you're open to relocating, feel free to list all the cities that would work for you.)
```
After a city: `Got it — *{city}* noted! 🙂 Would you like to add any other city? (yes/no)`
On yes: `Sure! Which other city? 🙂` → then `Added *{city}*! 😊 Would you like to add any other city? (yes/no)`

### 4. Experience — POLL
Prompt: `Wonderful! How many years of *experience* do you have in total?`
POLL name: `How many years of work experience do you have?`
options: `0–2 years` / `3–5 years` / `5–8 years` / `8+ years`

### 5. Current CTC (open text)
```
Could you share your *current CTC* (annual)? 😊 Any format works — e.g. "12", "12 LPA", "8 lakh", or "₹12,00,000".
```

### 6. Expected CTC (open text)
```
And what's your *expected CTC*? Same deal — any format is fine, e.g. "15" or "15 LPA".
```
If expected < current: `Just to double check — your expected CTC seems a little lower than your current CTC. 🙂 Could you re-enter your expected CTC?`

### 7. Notice period — POLL
Prompt: `Almost there! What's your *notice period*? (for example: "immediate", "30 days", or "2 months")`
POLL name: `What is your notice period?`
options: `Immediate` / `15 days` / `30 days` / `60 days` / `90+ days` / `Currently serving notice`
If "currently serving notice": `Got it — since you're serving your notice, what is your *last working day*? (please share the date, e.g. "15 July")`

### 8. Recruiter-configurable questions — POLL(s)
Each custom question is asked as a poll. Yes/No by default; if phrased "A or B"
(e.g. "Do you give training to blue collar or white collar") the poll offers those two options.
Intro line before the first: `You're doing great! 😊 Just a couple more quick questions.`
Nudge if unclear (Yes/No): `Just a quick yes or no would help here 🙂`
Nudge if unclear (A/B): `Just to confirm — {A} or {B}? 🙂`

### 9. Resume (open text — PDF/Word attachment only)
```
One last thing — do you have an *updated resume* you'd like to share, in *PDF or Word* format? 📄 You can attach it right here. If not, just say *"skip"* and we'll move on.
```
If they say yes / paste a link instead of attaching: `I'll need the actual file to share with our team 🙂 Could you please attach your resume here as a *PDF or Word* document? Or just say *"skip"* if you don't have one handy.`
If they send a link while awaiting the file: `I'll need the actual file, not a link 🙂 Please attach your resume here as a *PDF or Word* document — or say *"skip"* if you don't have one handy.`
Wrong file type: `Hmm, that doesn't look like a PDF or Word file 🙂 Could you please resend your resume as a PDF or DOCX?`

### 10. Scheduling — Date POLL
Prompt: `Brilliant! 🎉 Let's set up your call. Which *date* works best for you?\n\n<5 dates>\n\n(Reply with a date, e.g. "25 June".)`
POLL name: `Which date works best for a quick call? 📅` — options: next 5 dates ("Thursday - 25 June").
If none work: `No worries at all! 🙂 Would you still like to go ahead with a call with the recruiter?`
→ if yes: `Wonderful! 😊 Since this is a *high-priority role* and we're hoping to close things within the next *3-4 days*, what date and time would work best for you?` (open text booking)

### 11. Scheduling — Time POLL
Prompt: `Great! And which *time slot* suits you?\n\n<slots>\n\n(Reply with a slot, e.g. "3 PM".)`
POLL name: `And which time slot suits you? 🕘`
options: `11 AM – 12 PM` / `12 PM – 1 PM` / `1 PM – 2 PM` / `2 PM – 3 PM` / `3 PM – 4 PM` / `4 PM – 5 PM`

### ✅ Booking confirmation (15-minute call)
```
Wonderful! 🎉 Your call with the recruiter has been scheduled for *{date}, {slot}*. You'll receive a calendar invite shortly — please do accept it so we can confirm the slot. Looking forward to connecting you! 😊📞

📅 Add this call to your calendar: {link}
```

### Not interested → keep profile → resurface timing
Thank-you when they decline: `Thank you so much for letting us know! 🙏`
Keep-profile POLL name: `Would it be okay if we kept your profile on file for future opportunities? 🙂` — options: `Yes, please` / `No, that's okay`
On No: `No problem at all, and thank you so much for your time today! 🙏 Wishing you all the best.`
On Yes → resurface POLL name: `When do you think you'll be open to exploring new opportunities? 😊`
options: `Within 1 month` / `In 2–3 months` / `In 3–6 months` / `After 6 months` / `Not sure yet`
On a timeframe: `Perfect! 😊 We'll reach out again around *{Month Year}* if there's a great fit. In the meantime, do follow *{company}* on LinkedIn or check our Careers page for openings. Thank you so much, and take care until then! 🙏`
On "not sure": `No problem at all! 😊 We'll keep your profile on file and reach out if a great opportunity comes up. In the meantime, feel free to follow *{company}* on LinkedIn or check our Careers page for new openings. Thank you so much, and take care! 🙏`

### Location mismatch (not comfortable with office city) → parked for future roles
```
Thank you so much for your time! 🙏 Since this role is based in *{location}*, it may not be the right fit right now — but we'll keep your profile on file and reach out the moment we have a relevant *{title}* in *{preferred}*. Wishing you all the best! 😊
```

### Pending recruiter review (didn't meet auto-schedule criteria — never a rejection)
```
Thank you so much for sharing all these details with us! 🙏 Our recruiter will personally review your profile and get in touch if there's a great next step. We really appreciate your time today. 😊
```

### Smart intents (can arrive at any stage)
- **Opt-out** ("stop"): `Understood — I won't message you again. Wishing you all the best! 🙏`
- **Wrong number**: `Apologies for the mix-up — I'll remove this number. Have a great day!`
- **Talk to a human**: `Of course! 🙌 I'll have our recruiter reach out to you personally.`
- **Is this spam / real?**: `Great question — this is a genuine outreach from *{company}* about our *{title}* role. 😊 No spam, I promise! Feel free to look us up. Happy to tell you more.`
- **I'm busy / later**: `No problem at all — take your time. 😊 I'll check back later. Just reply here whenever you're free.`
- **Greeting only**: `Hello! 😊` (then re-show the current question)
- **Couldn't understand** (after the 5-min wait): `Hmm, I couldn't quite understand that — there may be a spelling error. Please resend your answer without any typos. 🙏`

### Templated answers to common questions (then continue the flow)
- CTC/salary: `As per company policy, we don't disclose CTC at this stage. However, our recruiter will discuss a compensation package based on your experience during your call. Shall we proceed?`
- Growth/career: `Great question! Our recruiter will walk you through career progression and upskilling opportunities during your call. Looking forward to it!`
- Remote/WFH: `This role requires {days} days from office in {location}. Our recruiter can discuss flexibility during your call.`
- Benefits/perks: `Our recruiter will give you a full overview of benefits and perks during your call. Let's get you scheduled!`
- Interview process (flagged): `Good question! 🙂 Our recruiter will take you through the full interview process on the call.`
- Timeline / next steps (flagged): `Our recruiter will share the timeline and next steps during your call. 🙂`
- Reporting structure (flagged): `Great question — your reporting structure will be covered by the recruiter on the call.`
- Team size (flagged): `The recruiter can share team details on your call. 🙂`
- Why is the role open (flagged): `The recruiter will explain the context of the role on the call.`
- About the role (flagged): `The full job description is attached above 📄 — and the recruiter can go deeper on the day-to-day during your call.`
- About the company: `We're Urban Company — a leading home-services platform. 😊 Happy to tell you more; the recruiter can share specifics on the call.`
- Anything else it can't answer (flagged): `That's a great question! Our recruiter is best placed to answer this in detail. Let's get you connected. Please share your availability — your preferred day and time for a call.`

### Follow-up nudges (candidate went quiet)
- First nudge (24h): `Hi {name}! 👋 Just following up on my previous message — whenever you get a chance, I'd love to hear back from you. 😊`
- Second nudge (+48h): `Hi {name}, just checking in once more 😊 — if now isn't the right time, no problem at all. Whenever you're ready, simply reply here and we'll pick up where we left off.`

### Day-of call reminders (morning of the scheduled call)
- To candidate: `Hi {name}! 👋 Just a friendly reminder — your call with the *{company}* recruiter is *today at {time}*. Please keep your phone handy, and all the best! 😊📞`
- To recruiter (own number): `🔔 Reminder: call with *{name}* ({title}) today at *{time}*.\n📱 {phone}`
