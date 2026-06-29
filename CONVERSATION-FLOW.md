# RecruitFlow — Conversation Flow (current)

> The exact logic the bot runs today. Edit anything and I'll implement the change.

---

## 0. Big picture

- **Two channels:** WhatsApp (tappable **polls** + text) and Email (text).
- **WhatsApp-first:** outreach goes on WhatsApp. If no reply in **24 h**, the same outreach auto-sends by **email**.
- **Same brain on both channels** — identical questions; only the format differs (polls on WhatsApp, plain text on email).
- **Only replies to people you contacted.** Unknown inbound numbers are ignored.
- **1-day follow-up nudge:** if a candidate goes quiet after our message, we nudge once a day, **max 2 times**, then stop.
- **Free keyword brain by default.** Optional AI (Claude) can be switched on later; it only fires when the rules can't parse a message ("rules first").

---

## 1. Main question sequence (in order)

| # | Stage | WhatsApp format | What we ask | Pipeline column |
|---|-------|-----------------|-------------|-----------------|
| 1 | Outreach | text + JD pdf + **poll** | "Are you open to exploring this [role]?" → Yes / Not now | Outreach |
| 2 | Current location | text | "What is your current city?" | In discussion |
| 3 | Preferred location | text | "Which city would you prefer?" | In discussion |
| 4 | Office comfort | **poll** | "[Location], [X] days/week from office — comfortable?" → Yes / No | In discussion |
| 5 | Experience | **poll** | "Years of experience?" → 0–2 / 3–5 / 5–8 / 8+ | In discussion |
| 6 | Current CTC | text — **number required (>0)** | "Current CTC (LPA)?" | In discussion |
| 7 | Expected CTC | text — **number required (>0)** | "Expected CTC (LPA)?" | In discussion |
| 8 | Notice period | **poll** | Immediate / 15 / 30 / 60 / 90+ days / Serving notice | In discussion |
| 9 | Skill questions | text | each custom question set on the job | In discussion |
| 10 | Resume | text (or "skip") | "Share an updated resume link?" | In discussion |
| 11 | Availability — **date** | **poll** | next 5 real dates from tomorrow ("Thursday - 25 June") | Scheduling |
| 12 | Availability — **time** | **poll** | 11–12, 12–1, 1–2, 2–3, 3–4, 4–5 | Scheduling |
| ✅ | Scheduled | — | confirmation + **added to Google Calendar**, candidate invited | Scheduled ✓ |

Candidates can always **type** instead of tapping a poll — both work.

---

## 2. Branches & end states

- **Not interested** (step 1) → "We'll keep your profile…" → **Dropped off**
- **Won't do office** (step 4) → "requires office presence in [Location]…" → **Reject**
- **Notice too long** (step 8, beyond the job's max) → "needs someone who can join within [max]…" → **Reject**
- **Serving notice** (step 8) → asks **"What's your last working day?"** → applies the notice check
- **Stopped replying** 3+ days mid-conversation → **Dropped off**

Pipeline: `Not started → Outreach → In discussion → Scheduling → Scheduled ✓`, plus **Dropped off** and **Reject**.

---

## 3. Real-life situations handled (free rules — no AI, no cost)

| Situation | What the bot does |
|---|---|
| **Hindi / Hinglish** for key answers (haan, nahi, bilkul, theek hai, "chaar saal", etc.) | Understood and processed |
| Question mid-flow (CTC, growth, remote, benefits) | Templated answer, then continues |
| Question it can't answer | "Our recruiter is best placed…" + **flags it** for you |
| "thanks / ok / 👍" | One-time polite acknowledgement (won't repeat) |
| Typo / gibberish | "I couldn't quite understand — please resend" |
| "no problem / no worries" | Correctly read as **yes** (not a rejection) |
| **"stop messaging me"** | Marks **do-not-contact**; stops all outreach/nudges/follow-ups |
| **"wrong number"** | Stops contacting + flags |
| **"talk to a recruiter / human"** | "Our recruiter will reach out" + flags |
| **"is this real / spam?"** | Reassures it's genuine, keeps going |
| **"I'm busy / text me later"** | "Take your time" — follows up later |
| **Reschedule** (after scheduling) | Re-opens the date + time polls |
| Casual chatter after they're done | Stays silent (only replies to role-relevant messages) |
| Laptop was off when they replied | Catches up and responds when it's back online |

---

## 4. Optional AI layer (off by default — needs a paid key)

If you ever add an Anthropic API key (Settings → 🤖 AI), the bot becomes **rules-first**: free rules handle everything they can, and **Claude is called only for messages the rules can't parse** — unusual phrasings, mixed languages, "actually my CTC is 15", negotiation, ambiguous intent. You pay only a fraction of a cent for those occasional messages. Everything in Sections 1–3 keeps working unchanged.

**Test Lab** (Settings → 🤖 AI → 🧪 Test messages): fire any sample message at any stage and see exactly how the bot reads & replies — without touching a real candidate.

---

## 5. After scheduling

- Call is **added directly to your Google Calendar** (if connected) and the **candidate is invited** automatically; otherwise both get an emailed calendar invite (.ics) + a one-tap "Add to Calendar" link.
- The candidate also gets the add-to-calendar link right in the WhatsApp confirmation.

---

## 6. Your changes (write here)

> Reword anything, reorder questions, change options, or describe a new situation to handle.

-
-
-
