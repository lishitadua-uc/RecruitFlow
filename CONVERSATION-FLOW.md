# RecruitFlow — Conversation Flow (current)

> The exact logic the bot runs today. Edit anything and I'll implement the change.

---

## 0. Big picture

- **WhatsApp-only outreach.** (Email follow-ups are paused; manual email is still available from the dashboard.)
- **Warm, human, conversational tone throughout** — never robotic or transactional.
- **~70–80% of questions are native WhatsApp Polls**; the rest are open text, used only where a free-text answer is genuinely needed.
- **Only replies to people you contacted.** Unknown inbound numbers are ignored.
- **Follow-up nudges:** if a candidate goes quiet, we nudge after 24h, then again 48h after that, then stop.
- **Free keyword brain by default.** Optional AI (Claude) can be switched on later; it only fires when the rules can't parse a message ("rules first").
- **Never rejects a candidate.** No answer (location comfort, CTC, notice period) disqualifies anyone — see Section 3.

---

## 1. Introduction

| Step | Format | Message |
|---|---|---|
| Outreach | Text + JD (poll follows) | Intro message about the role |
| Interest poll | **Poll** | "Are you open to exploring this [role] opportunity?" → *Yes, tell me more* / *Not right now* |

If the candidate instead asks something like **"Tell me more"**, **"Is this genuine?"**, or **"What's this about?"** — the bot politely explains it's a genuine outreach from Urban Company about a potential opportunity, and asks if they'd like to explore it. The conversation then continues from the same point.

---

## 2. If the candidate is not interested

Instead of ending immediately, the bot:

1. Thanks them politely.
2. Asks (**Poll**): *"Would it be okay if we kept your profile on file for future opportunities?"* → **Yes, please** / **No, that's okay**
   - **No** → thanks them and ends warmly.
   - **Yes** → asks (**Poll**): *"When do you think you'll be open to exploring new opportunities?"* → **Within 1 month / In 2–3 months / In 3–6 months / After 6 months / Not sure yet**
3. Ends with a warm message: we'll reach out again around that time, and mentions they can also check Urban Company's LinkedIn and Careers pages in the meantime.

The candidate is automatically resurfaced on the dashboard once their chosen window arrives.

---

## 3. Screening flow (fixed order — never changes)

| # | Stage | Format | What we ask |
|---|-------|--------|-------------|
| 1 | Current Location | **Open text** | "Which city are you currently based in?" |
| 2 | Comfort with Job Location | **Poll** | "[Location], [X] days/week from office — comfortable with that?" → Yes / No |
| 3 | Preferred Location(s) | **Open text**, with a follow-up | "Which city would you prefer to work in?" → after each city, asks "Would you like to add any other city?" until they say no |
| 4 | Total Experience | **Poll** | "How many years of experience?" → 0–2 / 3–5 / 5–8 / 8+ |
| 5 | Current CTC | **Open text** | "Could you share your current CTC?" — accepts any common format |
| 6 | Expected CTC | **Open text** | "And what's your expected CTC?" — accepts any common format |
| 7 | Notice Period | **Poll** | Immediate / 15 / 30 / 60 / 90+ days / Currently serving notice — if "serving notice", asks the *last working day* as a plain follow-up question (no poll re-fires while this is pending) |
| 8 | Recruiter-configurable questions | **Poll**, Yes/No **or** multi-choice | If the question is phrased "A or B" (e.g. "blue collar or white collar"), the poll offers those two choices instead of a forced Yes/No |
| 9 | Resume | **Open text** (attachment) | "Do you have an updated resume in PDF or Word format?" — candidate attaches the file directly (or says "skip") |

Candidates can always **type** instead of tapping a poll — both work.

**Experience gating**: if a job has a required experience range set, a candidate below that range is not auto-scheduled — they're routed to recruiter review instead (never rejected, never told "no").

---

## 4. Current & Expected CTC

Accepts all common formats: `12`, `12.5`, `12 LPA`, `₹12,00,000`, `1200000`, `8 lakh`, `8L`, and monthly figures (auto-converted to annual).

- If Expected CTC comes in **lower** than Current CTC, the bot politely asks the candidate to re-enter it — it never disqualifies anyone over this.

---

## 5. Notice Period

Collected only — **never used to reject or disqualify** a candidate, regardless of length.

---

## 6. Screening logic (no hard rejections)

Once screening (Sections 3–5) is complete:

- **If the profile meets auto-scheduling criteria** (comfortable with location, notice period within the job's limit) → proceeds straight to **Section 7 — Scheduling**.
- **Otherwise** → the bot thanks the candidate warmly and lets them know a recruiter will personally review their profile and reach out if there's a suitable next step. (Dashboard: **Pending recruiter review**.)

No answer — location comfort, CTC, or notice period — ever produces an automatic rejection message to the candidate.

---

## 7. Scheduling flow

| # | Stage | Format | What we ask |
|---|-------|--------|-------------|
| 1 | Date | **Poll** | Next 5 real dates from tomorrow |
| 2 | Time slot | **Poll** | 11–12, 12–1, 1–2, 2–3, 3–4, 4–5 |
| ✅ | Confirmation | — | "Your call with the recruiter has been scheduled for [date/time]. You'll receive a calendar invite shortly — please accept it." + a **15-minute** calendar event created (Google Calendar, both parties invited) |

This is a recruiter screening **call**, not an interview — the wording throughout (confirmation, reminders, calendar) reflects that.

**If none of the offered dates work**: the bot asks whether they'd still like to go ahead with a call. If yes, since this is a high-priority role we're hoping to close within 3–4 days, it asks them to propose their own date/time in **open text** (not a poll, since we can't pre-list arbitrary dates) and books that directly. If no, it thanks them and routes to recruiter review instead of leaving them hanging.

---

## 8. Conversation style

Warm, friendly, human, conversational, and professional — never abrupt or transactional. Every stage transition includes a brief acknowledgement before the next question.

---

## 9. Poll vs. Open Text — quick reference

| Question | Type |
|---|---|
| Interest in the role | **Poll** |
| Keep profile on file? | **Poll** |
| When open to new opportunities? | **Poll** |
| Current Location | **Open text** |
| Comfort with job location | **Poll** |
| Preferred Location(s) | **Open text** |
| Total Experience | **Poll** |
| Current CTC | **Open text** |
| Expected CTC | **Open text** |
| Notice Period | **Poll** |
| Recruiter-configurable skill/fit questions | **Poll** (Yes/No, one per question) |
| Resume link | **Open text** |
| Interview date | **Poll** |
| Interview time slot | **Poll** |

---

## 10. Real-life situations handled (free rules — no AI, no cost)

| Situation | What the bot does |
|---|---|
| **Hindi / Hinglish** for key answers (haan, nahi, bilkul, theek hai, "chaar saal", etc.) | Understood and processed |
| "Tell me more / What's this about?" (during introduction) | Explains the outreach, asks if they'd like to explore it |
| "Is this real / spam?" (at any stage) | Reassures it's genuine, re-shows the current question |
| Question mid-flow (CTC, growth, remote, benefits) | Templated answer, then continues |
| Question it can't answer | "Our recruiter is best placed…" + **flags it** for you |
| "thanks / ok / 👍" | One-time polite acknowledgement (won't repeat) |
| Typo / gibberish | Waits ~5 minutes for a clearer follow-up before saying "I couldn't understand" — if a clearer message arrives in that window, it replies to that instead (never both) |
| "no problem / no worries" | Correctly read as **yes** (not a rejection) |
| **"stop messaging me"** | Marks **do-not-contact**; stops all outreach/nudges/follow-ups |
| **"wrong number"** | Stops contacting + flags |
| **"talk to a recruiter / human"** | "Our recruiter will reach out" + flags |
| **"I'm busy / text me later"** | "Take your time" — follows up later |
| **Reschedule** (after scheduling) | Re-opens the date + time polls |
| Casual chatter after they're done | Stays silent (only replies to role-relevant messages) |
| Laptop was off when they replied | Catches up and responds when it's back online |

---

## 11. Optional AI layer (off by default — needs a paid key)

If you ever add an Anthropic API key (Settings → 🤖 AI), the bot becomes **rules-first**: free rules handle everything they can, and **Claude is called only for messages the rules can't parse** — unusual phrasings, mixed languages, "actually my CTC is 15", negotiation, ambiguous intent. Everything in Sections 1–10 keeps working unchanged.

**Test Lab** (Settings → 🤖 AI → 🧪 Test messages): fire any sample message at any stage and see exactly how the bot reads & replies — without touching a real candidate.

---

## 12. After scheduling

- Call is **added directly to your Google Calendar** (if connected) and the **candidate is invited** automatically; otherwise both get an emailed calendar invite (.ics) + a one-tap "Add to Calendar" link.
- The candidate also gets the add-to-calendar link right in the WhatsApp confirmation.

---

## 13. Your changes (write here)

> Reword anything, reorder questions, change options, or describe a new situation to handle.

-
-
-
