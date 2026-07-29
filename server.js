/* ============================================================
   RecruitFlow — Local WhatsApp Bridge (v2)
   Real WhatsApp send/receive from YOUR personal number.
   - Resolves WhatsApp privacy IDs (@lid) to real numbers
   - Understands natural-language replies (not just "1"/"2")
   - Sends the Job Description as a PDF attachment
   Data persists in data.json.
   WARNING: automating a personal number breaks WhatsApp ToS (ban risk).
============================================================ */
const express = require('express');
const { Client, LocalAuth, MessageMedia, Poll } = require('whatsapp-web.js');
const Anthropic = require('@anthropic-ai/sdk');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const UP_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UP_DIR)) fs.mkdirSync(UP_DIR);
const now = () => new Date().toISOString();
const uid = () => Math.random().toString(36).slice(2, 10);

/* ---------------- Persistence ---------------- */
let db = loadDB();
function loadDB() {
  try { const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); if (d && d.jobs) return d; } catch (e) {}
  return { company: 'Urban Company', jobs: [], candidates: [] };
}
function save() { if (process.env.RF_TEST) return; fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); }

/* ---------------- Helpers ---------------- */
const jobOf = c => db.jobs.find(j => j.id === c.jobId);
const candsOf = jid => db.candidates.filter(c => c.jobId === jid);
function normPhone(p) { let d = (p || '').replace(/\D/g, ''); if (d.length === 10) d = '91' + d; return d; }
const last10 = p => normPhone(p).slice(-10);
// Canonical display/storage form — always "+91XXXXXXXXXX" for Indian numbers. Empty stays empty.
function fmtPhone(p) { const d = normPhone(p); return d ? '+' + d : ''; }
// Normalize every existing candidate's phone to the canonical +91 form on startup (idempotent).
(() => { let changed = false; (db.candidates || []).forEach(c => { if (c && c.phone) { const f = fmtPhone(c.phone); if (f !== c.phone) { c.phone = f; changed = true; } } }); if (changed && !process.env.RF_TEST) fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); })();
const EXP = ['0-1 years', '1-3 years', '3-5 years', '5-8 years', '8+ years'];
const ROLE = ['Individual Contributor', 'Team Lead / Senior', 'Manager', 'Fresher / Looking for first role', 'Other'];
const TIME = ['Morning (9 AM - 12 PM)', 'Afternoon (12 PM - 3 PM)', 'Evening (3 PM - 6 PM)'];
const STAGE_LABEL = { new: 'Not started', outreach: 'Outreach sent', details_form: 'Details form sent', location: 'Asked location', preflocation: 'Preferred location', workpref: 'Work preference', experience: 'Experience', role: 'Current role', currentctc: 'Current CTC', opentocity: 'Open to location', expectedctc: 'Expected CTC', notice: 'Notice period', skills: 'Skill questions', resume: 'Resume request', keepprofile: 'Asked to keep profile', reason: 'Asked why not interested', resurface: 'Resurface timing', availnow: 'Available-now check', awaiting_recruiter_now: 'Checking recruiter for instant call', await_recruiter_slot: 'Recruiter to suggest a time', avail: 'Scheduling', availdate: 'Scheduling', availtime: 'Scheduling', avail_time: 'Scheduling', avail_day: 'Scheduling', scheduled: 'Call scheduled ✓', declined: 'Not interested', location_dropout: 'Location mismatch', awaiting_role: 'Awaiting a role in their city', notice_dropout: 'Notice too long', pending_review: 'Pending recruiter review' };
const isTerminal = s => ['scheduled', 'declined', 'location_dropout', 'awaiting_role', 'notice_dropout', 'pending_review', 'await_recruiter_slot'].includes(s);

// Classify a job as Managerial (Senior Manager & above) or Individual Contributor, from its title.
// Rule: "Senior … Manager" and above = Managerial; a plain Manager / Associate / IC title = IC.
function classifyRoleType(title) {
  const t = (title || '').toLowerCase();
  // "senior / sr / lead / group / principal ... manager" (words may sit in between, e.g. "Senior Category Manager")
  const seniorManager = /\b(senior|sr|lead|group|principal)\b.*\bmanager\b/;
  // Director and above
  const topTitles = /(\bdirector\b|vice\s*president|\bvp\b|\bavp\b|\bsvp\b|\bevp\b|\bhead\b|\bchief\b|\bpresident\b|general\s*manager|\bgm\b|\bceo\b|\bcto\b|\bcfo\b|\bcoo\b|\bcxo\b|\bcmo\b|\bcpo\b)/;
  return (seniorManager.test(t) || topTitles.test(t)) ? 'Managerial' : 'IC';
}
db.jobs.forEach(j => { j.roleType = classifyRoleType(j.title); });   // backfill existing jobs

/* ---------------- Predefined template Q&A ----------------
   flag:true  → recruiter should see it (added to Flagged tab)
   isFallback → the "share your availability" catch-all (jumps to scheduling mid-flow) */
const TEMPLATES = [
  { keys: ['ctc', 'salary', 'pay', 'compensation', 'package', 'lpa', 'stipend', 'hike', 'budget'], resp: () => "As per company policy, we don't disclose CTC at this stage. However, our recruiter will discuss a compensation package based on your experience during your call. Shall we proceed?" },
  { keys: ['growth', 'career', 'learning', 'upskill', 'progression', 'promot'], resp: () => "Great question! Our recruiter will walk you through career progression and upskilling opportunities during your call. Looking forward to it!" },
  { keys: ['remote', 'work from home', 'wfh', 'hybrid'], resp: (j) => `This role requires ${j.workingDays} days from office in ${j.location}. Our recruiter can discuss flexibility during your call.` },
  { keys: ['benefit', 'perk', 'insurance', 'leave', 'holiday'], resp: () => "Our recruiter will give you a full overview of benefits and perks during your call. Let's get you scheduled!" },
  // Process / role questions — answered warmly and flagged so the recruiter can address them on the call.
  { keys: ['how many round', 'interview round', 'rounds of interview', 'interview process', 'selection process', 'hiring process', 'how many interview'], resp: () => "Good question! 🙂 Our recruiter will take you through the full interview process on the call.", flag: true },
  { keys: ['hear back', 'get back to me', 'when will i know', 'response time', 'how long will', 'timeline', 'next steps', 'what happens next', 'when will i hear'], resp: () => "Our recruiter will share the timeline and next steps during your call. 🙂", flag: true },
  { keys: ['report to', 'reporting to', 'manager', 'who will i work', 'reporting structure', 'who do i report'], resp: () => "Great question — your reporting structure will be covered by the recruiter on the call.", flag: true },
  { keys: ['team size', 'how big is the team', 'team structure', 'how many people'], resp: () => "The recruiter can share team details on your call. 🙂", flag: true },
  { keys: ['new role', 'new position', 'replacement', 'backfill', 'why is this open'], resp: () => "The recruiter will explain the context of the role on the call.", flag: true },
  { keys: ['what does the role', 'role involve', 'responsibilities', 'day to day', 'what will i do', 'job description', 'more about the role', 'about this role'], resp: (j) => `The full job description is attached above 📄 — and the recruiter can go deeper on the day-to-day during your call.`, flag: true },
  { keys: ['who are you', 'which company', 'about the company', 'what is urban company', 'about urban company'], resp: () => `We're Urban Company — a leading home-services platform. 😊 Happy to tell you more; the recruiter can share specifics on the call.` },
];
const FALLBACK = "That's a great question! Our recruiter is best placed to answer this in detail. Let's get you connected. Please share your availability — your preferred day and time for a call.";
function matchTemplate(text, j) {
  const t = text.toLowerCase();
  for (const tpl of TEMPLATES) if (tpl.keys.some(k => t.includes(k))) return { resp: tpl.resp(j), flag: !!tpl.flag, isFallback: false };
  return { resp: FALLBACK, flag: true, isFallback: true };
}
const questionLike = t => /\?/.test(t) || TEMPLATES.some(tpl => tpl.keys.some(k => t.toLowerCase().includes(k)));

/* ---------------- Natural-language understanding ---------------- */
// A bare "no" that is NOT part of "no problem / no issue / no worries / no doubt" (those mean YES).
const NO_WORD = /\bno\b(?!\s*(problem|issue|issues|worr|doubt|probs|biggie|prob\b))|\bnope\b|\bnah\b/;
function detectInterest(t) {
  t = ' ' + t.toLowerCase() + ' ';
  // HARD no → decline immediately
  if (/(not interested|no thanks|no thank|i'?ll pass|please decline|\bdecline\b|already (have a job|placed|employed|working elsewhere|sorted)|remove me|\bstop\b|do ?n'?t contact|leave me alone|interested nahi|nahi chahiye|bilkul nahi)/.test(t) || NO_WORD.test(t)) return 'no';
  // SOFT hesitation → re-question (return 'maybe'). Checked BEFORE "yes" so "not a good fit" isn't read as the "good fit" yes-phrase.
  if (/(not (a )?(good |right |perfect )?fit|don'?t (think|feel)[^.]{0,18}fit|isn'?t a fit|not sure|not so sure|not looking|not actively looking|not looking out|maybe not|i don'?t think so|not really|not for me|on the fence|need to think|thinking about it|let me think|maybe|perhaps|depends|possibly|might|could be|shayad|pata nahi|sochna|dekhta hu|dekhte hai)/.test(t)) return 'maybe';
  // YES / interested — including implicit interest like "I'd be a good fit"
  if (/(\byes\b|yeah|yep|yup|\bsure\b|interested|keen|definitely|absolutely|\bok\b|okay|sounds good|why not|i'?m in|go ahead|tell me more|more details|more info|love to|happy to|let'?s|please|good fit|right fit|perfect fit|great fit|will be (a )?(good |great )?fit|i'?ll be fit|be a (good |great )?fit|i'?d be (a )?(good |great )?fit|suits? me|i can do (this|it|the)|i'?m a (good )?(fit|match)|good match|right for me|made for (this|me)|fit for (the|this|group|category|senior|that)|\bhaan\b|\bhan\b|\bhaa\b|\bha\b|\bji\b|ji haan|bilkul|theek hai|thik hai|han ji|haanji|batao|batayein|zaroor|jarur)/.test(t)) return 'yes';
  if (/^\s*(1|a)\b/.test(t)) return 'yes';
  if (/^\s*(2|b)\b/.test(t)) return 'no';
  return null;
}
// ---- "Not interested" → keep-profile + resurface-timing sub-flow ----
const KEEPPROFILE_YES = 'Yes, please';
const KEEPPROFILE_NO = "No, that's okay";
const RESURFACE_OPTS = ['Within 1 month', 'In 2–3 months', 'In 3–6 months', 'After 6 months', 'Not sure yet'];
// Returns a number of months (0 = never resurface), the string 'unsure' (keep profile, no set timing), or null (couldn't parse — ask again).
function parseResurfaceMonths(t) {
  const tl = (t || '').toLowerCase();
  if (/not sure|dont know|don'?t know|no idea|not certain|unsure/.test(tl)) return 'unsure';
  if (/don'?t|do not|never|stop|remove|no thanks|not at all|please don'?t/.test(tl)) return 0;
  if (/within 1|1 month|one month|\ba month\b|next month/.test(tl)) return 1;
  if (/2.?3|2 to 3|two.?three/.test(tl)) return 3;
  if (/3.?6|3 to 6|three.?six/.test(tl)) return 6;
  if (/after 6|6\+|more than 6|beyond 6/.test(tl)) return 9;
  if (/\b1\b/.test(tl) && !/[236]|three|six/.test(tl)) return 1;
  if (/\b3\b|three|quarter/.test(tl)) return 3;
  if (/\b6\b|six|half/.test(tl)) return 6;
  if (/\b2\b|two/.test(tl)) return 2;
  if (/\b12\b|year|twelve/.test(tl)) return 12;
  return null;
}
function detectComfort(t) {
  t = ' ' + t.toLowerCase() + ' ';
  // Clear NO signals (note: "no problem / no worries" are NOT a no — see NO_WORD).
  const strongNo = /(not comfortable|can'?t|cannot|won'?t work|won'?t be able|not possible|unable|\bnot ok\b|too far|prefer (remote|to work remote|wfh|work from home|a different|another|other)|relocat\w* (is )?(not|hard|difficult|an issue|a problem)|comfortable nahi|nahi ho payega|mushkil)/;
  if (strongNo.test(t) || NO_WORD.test(t)) return 'no';
  if (/(\byes\b|yeah|yup|\bsure\b|comfortable|\bfine\b|\bok\b|okay|no problem|no issue|no worries|works for me|that works|i can do|that'?s fine|happy to|willing|\bhaan\b|\bhan\b|\bji\b|bilkul|theek hai|thik hai|ho jayega|chalega|koi (problem|dikkat) nahi)/.test(t)) return 'yes';
  if (/^\s*(1|a)\b/.test(t)) return 'yes';
  if (/^\s*(2|b)\b/.test(t)) return 'no';
  return null;
}
function parseLetter(t, max) { t = t.trim().toLowerCase(); const m = t.match(/^\s*([a-e])\b/) || t.match(/^\s*([a-e])\)/); if (m) { const i = m[1].charCodeAt(0) - 97; if (i < max) return i; } const n = t.match(/\b([1-9])\b/); if (n) { const i = +n[1] - 1; if (i >= 0 && i < max) return i; } return null; }
function bucketExp(y) { if (y <= 1) return EXP[0]; if (y <= 3) return EXP[1]; if (y <= 5) return EXP[2]; if (y <= 8) return EXP[3]; return EXP[4]; }
function detectExperience(t) {
  const tl = t.toLowerCase();
  if (/\b(fresher|fresh|no experience|just graduated|final year|student|naya|koi experience nahi)\b/.test(tl)) return EXP[0];
  // Explicit "X years / yrs / saal" always means years of experience → bucket it.
  let m = tl.match(/(\d+(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?|yr|saal|sal|varsh|years\s*ka|saal\s*ka)\b/);
  if (m) return bucketExp(parseFloat(m[1]));
  // Hindi number words for years (optional) — common small values.
  const hindiNums = { ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5, chhe: 6, che: 6, saat: 7, aath: 8, nau: 9, das: 10 };
  const hm = tl.match(/\b(ek|do|teen|chaar|char|paanch|panch|chhe|che|saat|aath|nau|das)\b\s*(?:saal|sal|varsh|years?)/);
  if (hm) return bucketExp(hindiNums[hm[1]]);
  // A standalone small number/letter = menu option (1-5).
  const i = parseLetter(t, 5); if (i != null) return EXP[i];
  // A bare number with no menu context (e.g. "10+") = years.
  m = tl.match(/^\s*(\d+(?:\.\d+)?)\s*\+?\s*$/);
  if (m) return bucketExp(parseFloat(m[1]));
  return null;
}
function detectRole(t) {
  const tl = t.toLowerCase();
  const i = parseLetter(t, 5); if (i != null) return { idx: i };
  if (/\bmanager\b|\bmgr\b|heading|head of/.test(tl)) return { idx: 2 };
  if (/\b(lead|senior|sr\.?|principal|staff|architect)\b/.test(tl)) return { idx: 1 };
  if (/\b(fresher|first role|first job|no experience|student|graduate|intern)\b/.test(tl)) return { idx: 3 };
  if (/\b(individual|\bic\b|developer|engineer|analyst|designer|associate|executive|specialist|consultant|sde)\b/.test(tl)) return { idx: 0 };
  if (!questionLike(t) && t.trim().length > 1) return { idx: 4, other: t.trim() }; // unknown but plausible → Other
  return null;
}
function detectSlot(t) {
  const tl = t.toLowerCase();
  if (/\bmorning\b/.test(tl)) return TIME[0];
  if (/after\s?noon|afternoon|\bnoon\b/.test(tl)) return TIME[1];
  if (/\bevening\b|\beve\b/.test(tl)) return TIME[2];
  const i = parseLetter(t, 3); if (i != null) return TIME[i];
  return null;
}
function detectSkip(t) {
  return /\b(skip|prefer not|rather not|not comfortable|confidential|private|wont share|won'?t share|don'?t want|do not want|can'?t share|cannot share|n\/?a)\b/i.test(t) || /^\s*(no|nope|pass|skip|na)\s*[.!]?\s*$/i.test(t);
}
// Short acknowledgement / pleasantry (not a real question) — e.g. "thanks", "ok done", "sure 👍".
function detectAck(t) {
  t = (t || '').trim(); if (!t) return false;
  return /^([\s.,!👍🙏😊👌✅]*(thanks?|thank you|thankyou|tysm|ty|ok(?:ay)?|okk+|kk?|great|cool|sure|done|got it|noted|perfect|awesome|nice|good|alright|all good|no problem|np|welcome|bye|cheers|👍|🙏|👌|✅))+[\s.,!👍🙏😊👌✅]*$/i.test(t);
}
// Candidate wants to change/cancel their scheduled call.
function wantsReschedule(t) {
  return /\b(reschedul|re-?schedul|postpone|change.*(time|slot|date|call)|different (time|slot|day)|another (time|slot|day)|can'?t make|cannot make|won'?t make|move (the )?call|new (time|slot)|shift the call)/i.test(t || '');
}
// ---- Deterministic "smart intent" detectors (no AI needed) ----
function detectOptOut(t) { return /\b(stop|unsubscribe|opt ?out|remove me|do ?n'?t (message|contact|text|call) me|dont (message|contact|text|call) me|leave me alone|do not contact|stop messaging|stop texting|block me|mat karo message|message mat)\b/i.test(t || ''); }
function detectWrongNumber(t) { return /\b(wrong (number|person)|you have the wrong|not the right person|this is not [a-z]+ ?'?s? number|galat number|galat insaan)\b/i.test(t || ''); }
function detectHandoff(t) { return /\b((talk|speak|connect|call|chat) (to|with|me to|me with)?\s*(a |an )?(human|person|recruiter|someone|agent|representative)|real (person|human|recruiter)|actual (person|human|recruiter)|human (please|agent)|baat kara|kisi se baat)\b/i.test(t || ''); }
function detectScamDoubt(t) { return /\b(who (is this|are you|'?s this)|kaun (ho|hai)|is this (real|legit|genuine|a scam|spam|fake|fraud)|is it (real|legit|genuine)|are you (real|a bot|genuine)|scam|spam|fraud|legit\??|fake|real (job|opportunity|company)\??)\b/i.test(t || ''); }
// Genuine curiosity about the outreach itself ("what's this about?"), distinct from skepticism/scam-doubt.
function detectWhatIsThis(t) { return /\b(what('?s| is) this( about| regarding| for)?\??|what do you (want|need)|why (are you|you) (messaging|texting|contacting) me|what('?s| is) (the|this) (opportunity|role|job)( about)?\??|tell me (about|more about) (this|it|the (role|opportunity|job)))\b/i.test(t || ''); }
function detectBusy(t) { return /\b((call|text|message|contact|reach|ping|connect) me (later|tomorrow|after|in a|next)|busy (right now|at the moment|currently|today)|i'?m busy|i am busy|talk later|reach out later|some other time|another time|abhi (busy|nahi)|thoda busy|baad (me|mein)|kal baat|busy hu)\b/i.test(t || ''); }
// Pure greeting with no other content ("hi", "hello there", "good morning") → greet + re-ask.
function detectGreeting(t) { return /^[\s!.,]*(hi+|hey+|hello+|heya|hii+|helo|yo|namaste|namaskar|good\s*(morning|afternoon|evening|day)|gm|gud\s*(mrng|morning)|greetings)([\s!.,👋🙏😊]+(there|team|sir|maam|ma'?am|mam|everyone|all|folks|dear))*[\s!.,👋🙏😊]*$/i.test((t || '').trim()); }
// Candidate is flexible about scheduling — pick/confirm a slot instead of re-asking.
function isFlexibleSchedule(t) { return /\b(any ?time|anytime|any ?day|any slot|whenever|you (decide|choose|pick|tell)|up to you|as per you(r)?|your convenience|free all day|free the whole day|free anytime|no preference|whatever works|whichever|either works|both work|as you like|jab bhi|kabhi bhi|aap batao)\b/i.test(t || ''); }
// A "location" answer that isn't actually a city (flexibility statements).
function isVagueLocation(t) { return /(any ?where|open to (relocat|any|work)|willing to relocat|can relocat|relocat|remote|flexible|any location|any city|wherever|no preference|open for any|doesn'?t matter|does not matter|koi bhi)/i.test(t || ''); }
// None of the offered date/time options work for the candidate (not the same as "I'm flexible").
function detectUnavailable(t) { return /\b(none (of (these|those|the above))?( work| works| suit| suits)?|not available (on )?(any|these|those)|don'?t have (any|these) (day|days|date|dates) free|can'?t make (any|these|it)|nothing works|doesn'?t work for me|not free (on )?(any|these)|no,? (none|these)? ?(dates?|days?) work)\b/i.test(t || ''); }

// Is this message actually about the role / hiring process (vs. casual chit-chat)?
// Used after a candidate is finished (scheduled/declined) so we don't reply to random messages.
function isRecruitmentRelevant(t) {
  const kw = /\b(role|job|position|vacanc|ctc|salary|package|compensation|stipend|hike|location|office|onsite|on-site|remote|hybrid|wfh|notice period|joining|join date|offer|interview|recruiter|\bhr\b|opportunit|j\.?d\b|description|profile|hiring|process|shortlist|selected|next round|next step|timing|\btime\b|slot|schedule|call|meeting|appointment|reschedul|experience|skill|company|team|work|address|venue|directions|where|link|zoom|google ?meet|gmeet|teams|phone|number to call|format|reschedule|confirm)\b/i;
  return /\?/.test(t || '') ? kw.test(t) : false;   // must be a question AND mention something role-related
}
function detectNoticeDays(t) {
  const tl = t.toLowerCase();
  if (/\b(immediate|immediately|right away|asap|available now|no notice|none|already serving|serving now|can join now|0\s*days?)\b/.test(tl)) return 0;
  let m = tl.match(/(\d+(?:\.\d+)?)\s*(months?|mon|mo)\b/); if (m) return Math.round(parseFloat(m[1]) * 30);
  m = tl.match(/(\d+(?:\.\d+)?)\s*(weeks?|wk)\b/); if (m) return Math.round(parseFloat(m[1]) * 7);
  m = tl.match(/(\d+)\s*(days?)\b/); if (m) return parseInt(m[1]);
  m = tl.match(/^\s*(\d+)\s*$/); if (m) return parseInt(m[1]);   // bare number → days
  return null;
}
function noticeLabel(days) { days = Number(days); if (isNaN(days)) return ''; if (days === 0) return 'immediately'; if (days % 30 === 0) return (days / 30) + ' month' + (days / 30 > 1 ? 's' : ''); return days + ' days'; }
// Canonical notice period for recording — "Immediate" / "15 days" / "1 month" (so 15, "15 days", "1 month" all normalize).
function canonicalNotice(days) { days = Number(days); if (isNaN(days)) return ''; if (days === 0) return 'Immediate'; return noticeLabel(days); }
// Does the text contain a recognizable day / time? (used to validate availability before scheduling)
function hasDay(t) { return /\b(today|tomorrow|tmrw|day after|mon|tue|wed|thu|fri|sat|sun)/i.test(t) || /\d{1,2}\s*[\/\-]\s*\d{1,2}/.test(t) || /\d{1,2}\s*(st|nd|rd|th)\b/i.test(t) || /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(t); }
function hasTime(t) { return /\b\d{1,2}\s*(?::\d{2})?\s*(am|pm)\b/i.test(t) || /\b\d{1,2}:\d{2}\b/.test(t) || /\b(morning|afternoon|evening|noon|after\s?noon)\b/i.test(t); }
const CALL_START = 12, CALL_END = 17;   // recruiters call between 12 PM and 5 PM
// Pull a normalized day token out of free text ("3 friday" -> "friday", "25/12" -> "25/12").
function extractDay(t) {
  const tl = (t || '').toLowerCase();
  if (/day after/.test(tl)) return 'day after tomorrow';
  if (/tomorrow|tmrw/.test(tl)) return 'tomorrow';
  if (/\btoday\b/.test(tl)) return 'today';
  const full = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (let i = 0; i < 7; i++) if (tl.includes(full[i].slice(0, 3))) return full[i];
  const dm = tl.match(/\d{1,2}\s*[\/\-]\s*\d{1,2}/) || tl.match(/\d{1,2}\s*(?:st|nd|rd|th)?\s*(?:of\s*)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*/) || tl.match(/(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s*\d{1,2}/);
  return dm ? dm[0] : null;
}
// Parse a time into a 24h hour. Bare numbers are read in calling-hours context (e.g. "3" -> 3 PM).
function parseTimeHour(t) {
  const tl = (t || '').toLowerCase();
  let m = tl.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/);
  if (m) { let h = (+m[1]) % 12; if (m[3] === 'pm') h += 12; return { hour: h, min: m[2] ? +m[2] : 0 }; }
  if (/\bnoon\b/.test(tl)) return { hour: 12, min: 0 };
  if (/afternoon/.test(tl)) return { hour: 15, min: 0 };
  if (/\bmorning\b/.test(tl)) return { hour: 11, min: 0 };
  if (/\bevening\b/.test(tl)) return { hour: 17, min: 0 };
  m = tl.match(/(?:^|\D)(\d{1,2})(?!\s*(?:st|nd|rd|th))(?::(\d{2}))?(?:$|\D)/);   // standalone number, not an ordinal date
  if (m) { let n = +m[1]; const mm = m[2] ? +m[2] : 0; if (n === 12) return { hour: 12, min: mm }; if (n >= 1 && n <= 5) return { hour: n + 12, min: mm }; if (n >= 6 && n <= 11) return { hour: n, min: mm }; }
  return null;
}
function fmtHour(h, m) { const ap = h >= 12 ? 'PM' : 'AM'; let hh = h % 12; if (hh === 0) hh = 12; return hh + (m ? (':' + String(m).padStart(2, '0')) : '') + ' ' + ap; }

/* ---------------- Scheduling: real dates from tomorrow + fixed time slots ---------------- */
const WDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function fmtDateOpt(d) { return `${WDAYS[d.getDay()]} - ${d.getDate()} ${MONTHS_FULL[d.getMonth()]}`; }   // "Thursday - 25 June"
// The next 5 dates starting tomorrow.
/* ---------------- Scheduling: 30-min slots, calendar-aware, ≥1hr from now ---------------- */
const WORK_START = 11, WORK_END = 17, SLOT_MIN = 30, CALL_MIN = 30, LEAD_MIN = 60;
let _busyCache = { at: 0, intervals: [] };
// Refresh the recruiter's busy intervals (next ~8 days) from their connected Google Calendar.
async function refreshBusy() {
  try {
    if (!calendarConnected()) { _busyCache = { at: Date.now(), intervals: [] }; return; }
    const cal = google.calendar({ version: 'v3', auth: oauthClient() });
    const r = await cal.events.list({ calendarId: 'primary', timeMin: new Date().toISOString(), timeMax: new Date(Date.now() + 8 * 864e5).toISOString(), singleEvents: true, maxResults: 250, orderBy: 'startTime' });
    const iv = [];
    for (const e of (r.data.items || [])) {
      if (e.status === 'cancelled' || e.transparency === 'transparent') continue;   // skip cancelled / "free" events
      const s = e.start && (e.start.dateTime || (e.start.date && e.start.date + 'T00:00:00'));
      const en = e.end && (e.end.dateTime || (e.end.date && e.end.date + 'T23:59:59'));
      if (s && en) iv.push({ start: new Date(s).getTime(), end: new Date(en).getTime() });
    }
    _busyCache = { at: Date.now(), intervals: iv };
  } catch (e) { log('Calendar busy refresh failed: ' + e.message); }
}
if (!process.env.RF_TEST) { setInterval(() => refreshBusy().catch(() => {}), 2 * 60 * 1000); setTimeout(() => refreshBusy().catch(() => {}), 8000); }
const slotIsBusy = (sMs, eMs) => _busyCache.intervals.some(b => sMs < b.end && eMs > b.start);
// Free 30-min slots for a date: within work hours, ≥1hr from now, not in the past, not clashing with the calendar.
function daySlots(date) {
  const out = [], earliest = Date.now() + LEAD_MIN * 60000;
  for (let h = WORK_START; h < WORK_END; h++) for (const mm of [0, 30]) {
    const s = new Date(date); s.setHours(h, mm, 0, 0); const sMs = s.getTime(), eMs = sMs + CALL_MIN * 60000;
    if (sMs < earliest) continue;
    if (calendarConnected() && slotIsBusy(sMs, eMs)) continue;
    const e = new Date(eMs);
    out.push({ label: fmtHour(h, mm) + ' – ' + fmtHour(e.getHours(), e.getMinutes()), start: s });
  }
  return out;
}
// Dates (skip Sundays) that still have at least one free slot.
function availDateOptions() {
  const opts = [], base = new Date();
  for (let i = 0; opts.length < 5 && i <= 12; i++) { const d = new Date(base); d.setDate(d.getDate() + i); d.setHours(0, 0, 0, 0); if (d.getDay() === 0) continue; if (!daySlots(d).length) continue; opts.push({ label: fmtDateOpt(d), date: d }); }
  return opts;
}
// Match a typed/chosen time to one of that date's free slots.
function matchTimeSlot(text, dateISO) {
  const slots = dateISO ? daySlots(new Date(dateISO)) : [];
  const t = (text || '').toLowerCase();
  for (const s of slots) { const l = s.label.toLowerCase(); if (t.includes(l) || t.replace(/\s/g, '').includes(l.replace(/\s/g, ''))) return s; }
  const tm = parseTimeHour(text);
  if (tm) { const want = new Date(); const s = slots.find(x => x.start.getHours() === tm.hour && x.start.getMinutes() === (tm.min >= 30 ? 30 : 0)) || slots.find(x => x.start.getHours() === tm.hour); if (s) return s; }
  return null;
}
// Stricter version for messages that also contain a date (e.g. "Saturday - 4 July") — the day-of-month
// number ("4") must not be misread as a bare time. Only matches a slot label or an explicit time-of-day
// marker (am/pm, "3:30", "noon", "morning" etc.), never the loose bare-number fallback in parseTimeHour.
function matchExplicitTimeSlot(text, dateISO) {
  if (!/\b(am|pm|noon|morning|afternoon|evening|\d{1,2}:\d{2})\b/i.test(text || '')) return null;
  return matchTimeSlot(text, dateISO);
}
// Extract a positive number from a CTC answer; returns null if none. Used to make CTC mandatory (and reject 0).
const WORD_NUMS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, twentyfive: 25, thirty: 30, thirtyfive: 35, forty: 40, fifty: 50 };
function parseAmount(text) {
  if (!text) return null;
  const m = text.match(/\d+(?:\.\d+)?/);
  if (m) return parseFloat(m[0]);
  const tl = text.toLowerCase();
  for (const [w, n] of Object.entries(WORD_NUMS)) if (new RegExp('\\b' + w + '\\b').test(tl)) return n;   // "twelve lakhs" → 12
  return null;
}
// Robust CTC parser — accepts "12", "12.5", "12 LPA", "₹12,00,000", "1200000", "8 lakh", "8L", monthly figures.
// Returns a number in LPA (lakhs per annum) for validation/comparison, or null if unparseable.
function parseCTCValue(text) {
  if (!text) return null;
  let t = text.toLowerCase().replace(/₹|rs\.?|inr/g, '').replace(/,/g, '').trim();
  let numMatch = t.match(/\d+(?:\.\d+)?/);
  let num = numMatch ? parseFloat(numMatch[0]) : null;
  if (num === null) { for (const [w, n] of Object.entries(WORD_NUMS)) if (new RegExp('\\b' + w + '\\b').test(t)) { num = n; break; } }
  if (num === null || num <= 0) return null;
  const isLakh = /lakh|lac|\bl\b/.test(t);
  const isLPA = /lpa|per annum|\bpa\b|annual/.test(t);
  const isMonthly = /\bk\b|thousand|month|monthly|\/mo\b|p\.?m\.?\b/.test(t);
  if (isLakh || isLPA) return num;
  if (isMonthly) { let monthlyRupees = num; if (/\bk\b|thousand/.test(t)) monthlyRupees = num * 1000; return (monthlyRupees * 12) / 100000; }
  // Bare number with no unit words: large numbers are absolute rupees; small ones are already LPA.
  if (num >= 1000) return num / 100000;
  return num;
}
// Tidy a CTC answer for the recruiter; converts a monthly figure to an approx annual LPA.
function normalizeCTC(text) {
  const t = (text || '').trim(), tl = t.toLowerCase();
  const monthly = /month|monthly|\/mo\b|\bp\.?m\.?\b|per month|permonth/.test(tl);
  if (monthly) {
    const m = tl.match(/(\d+(?:\.\d+)?)\s*(k|thousand|lakh|lac|l\b)?/);
    if (m) {
      let val = parseFloat(m[1]); const unit = m[2] || '';
      if (/k|thousand/.test(unit)) val *= 1000; else if (/lakh|lac|l/.test(unit)) val *= 100000; else if (val < 1000) val *= 100000; // bare small number assumed lakhs? keep raw if unclear
      const annualLpa = (val * 12) / 100000;
      if (annualLpa > 0 && annualLpa < 1000) return `${t} (≈ ${annualLpa.toFixed(1)} LPA annual)`;
    }
  }
  return t;
}
// Canonical CTC for recording: rewrite every amount in the text to "N LPA" so "10 lacs", "10 LPA",
// and "10,00,000" all record identically. Preserves labels like fixed/variable/ESOP in a break-up.
function canonicalCTC(text) {
  if (!text) return text;
  return String(text).replace(/(^|\s)(?:₹|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d+)?)\s*(lpa|lakhs?|lacs?|\bl\b|\bk\b|thousand|cr(?:ore)?s?|per\s*annum|\bpa\b|annual|month(?:ly)?|\/mo|\bpm\b)?/gi,
    (mtch, lead, num, unit) => {
      const lpa = parseCTCValue(num + ' ' + (unit || ''));
      if (lpa === null) return mtch;
      const v = Math.round(lpa * 100) / 100;
      return (lead || '') + (Number.isInteger(v) ? v : v.toFixed(2)) + ' LPA';
    }).replace(/\s{2,}/g, ' ').trim();
}
// Parse a loose date string to a future Date (for "last working day").
function parseDateLoose(t) {
  t = (t || '').toLowerCase(); const now = new Date();
  if (/day after/.test(t)) { const d = new Date(now); d.setDate(d.getDate() + 2); return d; }
  if (/tomorrow|tmrw|tmrl/.test(t)) { const d = new Date(now); d.setDate(d.getDate() + 1); return d; }
  if (/\btoday\b|right now|anytime|asap|whenever/.test(t)) return new Date(now);
  // "this/next weekend" → upcoming Saturday (next week's if "next weekend").
  if (/weekend/.test(t)) { const d = new Date(now); let add = (6 - d.getDay() + 7) % 7; if (add === 0) add = 7; if (/next weekend/.test(t)) add += 7; d.setDate(d.getDate() + add); return d; }
  if (/next week/.test(t)) { const d = new Date(now); d.setDate(d.getDate() + 7); return d; }
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  let dd = null, mm = null, m;
  if ((m = t.match(/(\d{1,2})\s*(?:st|nd|rd|th)?\s*(?:of\s*)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/))) { dd = +m[1]; mm = months.indexOf(m[2]); }
  else if ((m = t.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s*(\d{1,2})/))) { mm = months.indexOf(m[1]); dd = +m[2]; }
  else if ((m = t.match(/(\d{1,2})\s*[\/\-]\s*(\d{1,2})/))) { dd = +m[1]; mm = (+m[2]) - 1; }
  if (dd != null && mm != null && mm >= 0) { let d = new Date(now.getFullYear(), mm, dd); if (d < now) d = new Date(now.getFullYear() + 1, mm, dd); return d; }
  const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  for (let i = 0; i < 7; i++) if (t.includes(days[i])) { const d = new Date(now); let add = (i - d.getDay() + 7) % 7; if (add === 0) add = 7; d.setDate(d.getDate() + add); return d; }
  return null;
}
function parseDateToDays(t) { const d = parseDateLoose(t); if (!d) return null; const today = new Date(); today.setHours(0, 0, 0, 0); d.setHours(0, 0, 0, 0); return Math.max(0, Math.round((d - today) / 86400000)); }
function detectDay(t) {
  const tl = t.toLowerCase();
  if (/day after/.test(tl)) return 'Day after tomorrow';
  if (/\btomorrow\b|\btmrw\b/.test(tl)) return 'Tomorrow';
  if (/\btoday\b/.test(tl)) return 'Today';
  const i = parseLetter(t, 3); if (i === 0) return 'Tomorrow'; if (i === 1) return 'Day after tomorrow';
  if (/\b(mon|tue|wed|thu|fri|sat|sun)/.test(tl) || /\d{1,2}\s*(st|nd|rd|th)?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/.test(tl) || /\d{1,2}[\/\-]\d{1,2}/.test(tl)) return t.trim();
  return null;
}

/* ---------------- Message text (clean WhatsApp formatting) ---------------- */
function outreachText(c, j) {
  const hasPdf = !!j.jdFile;
  return `Hi ${c.name}! 👋\n\nI am a UC recruit bot, reaching out from *${db.company}*. We came across your profile and think you could be a great fit for our *${j.title}* role${j.location ? ` based in ${j.location}` : ''}.\n\n` +
    (hasPdf ? `📄 I've attached the full job description below — do take a look.\n\n` : ``) +
    `Are you open to exploring this opportunity? 😊 Feel free to ask me anything about the role.` +
    numberedOptions('outreach', c, j);
}
// A numbered list of the stage's choices, appended to the question text (replaces WhatsApp polls).
function numberedOptions(stage, c, j) {
  const p = pollForStage(stage, c, j);
  if (!p || !p.options || !p.options.length) return '';
  return `\n\n${p.options.map((o, i) => `${i + 1}. ${o}`).join('\n')}\n\n_(reply with the number or your answer)_`;
}
// Plain bulleted options (no numbers) — used for date/time so "1." isn't confused with "1 pm".
function bulletOptions(stage, c, j) {
  const p = pollForStage(stage, c, j);
  if (!p || !p.options || !p.options.length) return '';
  return `\n\n${p.options.map(o => `• ${o}`).join('\n')}\n\n_(just reply with your choice)_`;
}
function stagePrompt(stage, c, j) {
  switch (stage) {
    case 'location': return `Great! 🙌 To help us find the best fit for you, I just have a few quick, easy questions.\n\nFirst — what is your *current location*?`;
    case 'currentctc': return `Thanks! 😊 Could you share your *current CTC*? Please include the break-up — *fixed*, *variable* (if any) and *ESOPs* (if any).`;
    case 'opentocity': return `Got it! And are you *open to ${j.location || 'the job location'}*?` + numberedOptions('opentocity', c, j);
    case 'notice': return `Almost there! What's your *notice period*?` + numberedOptions('notice', c, j);
    case 'resume': return `One last thing — do you have an *updated resume* you'd like to share, in *PDF or Word* format? 📄 You can attach it right here. If not, just say *"skip"* and we'll move on.`;
    case 'availnow': return `Almost done! 🙌 Are you *available for a quick call right now*?` + numberedOptions('availnow', c, j);
    case 'avail':
    case 'availdate': return `Brilliant! 🎉 Let's set up your call. Which *date* works best for you?` + bulletOptions('availdate', c, j);
    case 'availtime': return `Great! And which *time slot* suits you?` + bulletOptions('availtime', c, j);
  }
  return '';
}
function clarify(stage, j) {
  const note = `Hmm, I couldn't quite understand that — there may be a spelling error. Please resend your answer without any typos. 🙏\n\n`;
  switch (stage) {
    case 'outreach': return note + `Are you open to exploring this role? Just let me know.`;
    case 'opentocity': return note + `Are you open to ${j ? j.location : 'the job location'}? A quick yes or no works. 🙂`;
    case 'currentctc': return note + `Could you share your current CTC with the break-up (fixed / variable / ESOPs)?`;
    case 'notice': return note + `What is your notice period? e.g. "30 days", "2 months", or "immediate".`;
    case 'avail': return note + `Please share a day and time that works for a quick call. 🕘`;
  }
  return note;
}
// If a skill question is phrased as "A or B" (e.g. "blue collar or white collar"), extract the two
// options so it can be a proper multi-choice poll instead of a forced Yes/No. Returns null otherwise.
function parseSkillQuestionOptions(q) {
  if (!q) return null;
  const clean = q.trim().replace(/\?+$/, '');
  const parts = clean.split(/\s+or\s+/i);
  if (parts.length !== 2) return null;
  const rightWords = parts[1].trim().split(/\s+/);
  const leftWords = parts[0].trim().split(/\s+/);
  const k = rightWords.length;
  if (k > 3 || leftWords.length < k) return null;
  const a = leftWords.slice(-k).join(' '), b = rightWords.join(' ');
  if (!a || !b || a.toLowerCase() === b.toLowerCase()) return null;
  const titleCase = s => s.replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
  return [titleCase(a), titleCase(b)];
}
// Enter the skill-question stage (or skip straight to resume if the job has none).
function enterSkills(c, ch, out) {
  const j = jobOf(c), qs = (j.skillQuestions || []).filter(q => q && q.trim());
  if (!qs.length) { advance(c, ch, 'resume', out); return; }
  ch.skillIdx = 0; ch.answers.skills = []; ch.stage = 'skills';
  out.push(`You're doing great! 😊 Just a couple more quick questions.`);
  out.push(qs[0]);
}
// Default auto-schedule notice threshold, used when a job hasn't set its own "Maximum notice period".
const DEFAULT_MAX_NOTICE_DAYS = 60;
// EXP bucket labels ("0-1 years", "1-3 years", ...) — the job's required-experience field uses the
// same buckets (minus " years"), so we can compare candidate vs. requirement by bucket index.
function expBucketIndex(label) {
  if (!label) return null;
  const norm = String(label).replace(/\s*years?$/i, '').trim();
  const idx = EXP.findIndex(e => e.replace(/\s*years?$/i, '') === norm);
  return idx === -1 ? null : idx;
}
function effectiveMaxNotice(j) { return (j && j.maxNoticeDays !== null && j.maxNoticeDays !== undefined && j.maxNoticeDays !== '') ? Number(j.maxNoticeDays) : DEFAULT_MAX_NOTICE_DAYS; }
// Decide whether this candidate can be auto-scheduled, or should be parked for manual recruiter review.
// Never a hard rejection — every path here ends warmly, just routes to the right next step.
function meetsAutoScheduleCriteria(ch, j) {
  if (ch.answers.workComfortable === 'No') return false;
  if (ch.answers.noticePeriodDays != null && ch.answers.noticePeriodDays > effectiveMaxNotice(j)) return false;
  const reqExpIdx = expBucketIndex(j && j.experience), candExpIdx = expBucketIndex(ch.answers.experience);
  if (reqExpIdx != null && candExpIdx != null && candExpIdx < reqExpIdx) return false;   // below the role's required experience
  return true;
}
// Add a flag once per kind (idempotent — safe on re-runs). Flags surface in the Responses "Flagged" filter.
function flagOnce(ch, kind, text) {
  ch.flags = ch.flags || [];
  const existing = ch.flags.find(f => f.kind === kind);
  if (existing) { existing.q = text; existing.ts = now(); return; }   // refresh text if answer changed
  ch.flags.push({ q: text, kind, auto: true, ts: now(), resolved: false });
}
// Auto-flag anything a recruiter should eyeball: notice period, and if candidate isn't open to the city.
function addScreeningFlags(c, ch, j) {
  if (ch.answers.openToCity === 'No') flagOnce(ch, 'location', `⚠ Not open to ${j ? j.location : 'the job location'} — recruiter to review.`);
  const d = ch.answers.noticePeriodDays;
  if (d != null) {
    const label = ch.answers.noticePeriod || (d + ' days');
    if (d > effectiveMaxNotice(j)) flagOnce(ch, 'notice', `⚠ Notice period "${label}" is beyond ${effectiveMaxNotice(j)} days — recruiter to follow up.`);
    else flagOnce(ch, 'notice', `ℹ Notice period: ${label}.`);
  }
}
// All 6 details collected → flag anything notable, then offer to book the recruiter call (scheduling kept).
function proceedAfterScreening(c, ch, out) {
  const j = jobOf(c);
  addScreeningFlags(c, ch, j);
  const hr = new Date().getHours();
  // During working hours, first offer an instant call; otherwise go straight to slots.
  if (hr >= 9 && hr < 20) advance(c, ch, 'availnow', out);
  else advance(c, ch, 'availdate', out);
}
// Candidate is available right now → ping the recruiter's WhatsApp to see if they can take it immediately.
function askRecruiterNow(c, out) {
  const ch = c.wa, j = jobOf(c);
  if (db.recruiterPending) { advance(c, ch, 'availdate', out); return; }   // recruiter busy with another prompt → slots instead
  ch.stage = 'awaiting_recruiter_now';
  db.recruiterPending = { type: 'immediate_avail', candId: c.id, askedAt: Date.now() }; save();
  waSendRecruiter(`⚡ *${c.name}* (${j ? j.title : ''}) is available for a call *right now*. Can you take it? Reply *yes* or *no*.\n📱 ${c.phone}`);
  out.push(`Perfect! ⏳ Let me quickly check if our recruiter is free right now — one moment…`);
}
// Candidate asked for a time outside our slots → flag it and ask the recruiter to suggest a time manually.
function escalateSlotToRecruiter(c, ch, request, out) {
  const j = jobOf(c);
  ch.stage = 'await_recruiter_slot';
  flagOnce(ch, 'slot', `📌 ${c.name} asked for a slot outside availability: "${request}". Recruiter to suggest a time manually.`);
  const msg = `📌 *${c.name}* (${j ? j.title : ''}) asked for a time outside the available slots: *"${request}"*.\nPlease suggest a suitable time to them directly.\n📱 ${c.phone}`;
  waSendRecruiter(msg);
  try { if (mailerReady() && db.settings.recruiterEmail) sendEmail(db.settings.recruiterEmail, `📌 ${c.name} asked for a different slot`, stripMd(msg)).catch(() => {}); } catch (e) {}
  if (c.fromSheet) writeCandidateToSheet(c);
  out.push(`Thank you! 🙏 That's outside our standard slots, so I've flagged it to our recruiter — they'll reach out to suggest a suitable time.`);
}
// Called once the candidate's preferred location(s) are collected. If they weren't comfortable with the
// role's office location, we don't screen further — we thank them, keep their profile, and park them in
// "awaiting_role" so a future job with the same title in their preferred city can auto-pick them up.
function afterPreferredLocation(c, ch, out) {
  const j = jobOf(c);
  if (ch.answers.workComfortable === 'No') {
    ch.stage = 'awaiting_role';
    flagOnce(ch, 'location', `📍 Prefers ${ch.answers.preferredLocation} — this role is in ${j ? j.location : 'another city'}. Parked; will auto-match a future "${j ? j.title : ''}" opening there.`);
    out.push(`Thank you so much for your time! 🙏 Since this role is based in *${j ? j.location : 'another city'}*, it may not be the right fit right now — but we'll keep your profile on file and reach out the moment we have a relevant *${j ? j.title : 'opening'}* in *${ch.answers.preferredLocation}*. Wishing you all the best! 😊`);
    return;
  }
  advance(c, ch, 'experience', out);
}

/* ---------------- Flow engine (channel-agnostic: drives WhatsApp & Email) ---------------- */
function advance(c, ch, stage, out) { ch.stage = stage; out.push(stagePrompt(stage, c, jobOf(c))); }
function confirmSchedule(c, ch, out) {
  ch.stage = 'scheduled';
  ch.answers.scheduledRecruiter = recruiterName(c);
  ch.answers.followupAsked = false;   // reset so the post-call "did it happen?" fires once
  onScheduled(c, ch);   // build calendar links + email invites to both parties
  const link = ch.answers.candidateCalendarLink;
  const rec = recruiterName(c);
  out.push(`Wonderful! 🎉 Your call has been scheduled for *${ch.answers.availability}*. You'll receive a calendar invite shortly — please do accept it.` + (link ? `\n\n📅 Add this call to your calendar: ${link}` : ''));
  out.push(`Thank you ${c.name} for your time & for sharing all the required details. I'll now pass on your information to *${rec}* from ${db.company}'s TA team. Should you be shortlisted, team will reach out to you directly. 🙏`);
  notifyRecruiterScheduled(c, ch);   // WhatsApp + email the recruiter
}
// On booking, tell the recruiter (their own WhatsApp + email) who's scheduled and when.
function notifyRecruiterScheduled(c, ch) {
  const j = jobOf(c), when = ch.answers.availability || '';
  const msg = `📅 *Call scheduled* — *${c.name}* (${j ? j.title : ''}${j && j.location ? ', ' + j.location : ''})\n🕘 ${when}\n📱 ${c.phone}\n\nIt's on your calendar; please accept the invite.`;
  waSendRecruiter(msg);
  try { if (mailerReady() && db.settings.recruiterEmail) sendEmail(db.settings.recruiterEmail, `📅 Call scheduled: ${c.name} — ${when}`, stripMd(msg)).catch(() => {}); } catch (e) {}
}
// The recruiter's own WhatsApp chat id — their logged-in number, else the linked device number.
function recruiterWaId() { const p = db.settings.recruiterPhone ? normPhone(db.settings.recruiterPhone) : waInfo; return p ? p + '@c.us' : null; }
// Recruiter name for closings — the recruiter assigned in the sheet for this candidate takes priority,
// then the recruiter logged in on this device, then a safe default.
function recruiterName(c) { const j = jobOf(c); return (c && c.recruiterName) || (j && j.recruiterName) || db.settings.recruiterName || 'our recruiter'; }
// Calendar organizer/attendee = the recruiter's email connected on THIS device (falls back to the mail sender).
function recruiterCalEmail() { return db.settings.recruiterEmail || db.settings.email || ''; }
function askQuestion(c, ch, text, out) { const m = matchTemplate(text, jobOf(c)); out.push(m.resp); if (m.flag) ch.flags.push({ q: text, ts: now(), resolved: false }); return m.flag; }
// Side-question mid-flow. Only the true catch-all (isFallback) jumps to scheduling; known templates just answer + re-ask.
function sideQuestion(c, ch, text, out, jump) {
  const m = matchTemplate(text, jobOf(c));
  out.push(m.resp);
  if (m.flag) ch.flags.push({ q: text, ts: now(), resolved: false });
  if (m.isFallback && jump) { ch.stage = 'avail'; return true; }
  return false;
}

function handleIncoming(c, ch, text, skipPush) {
  const j = jobOf(c), out = [];
  if (!skipPush) ch.transcript.push({ from: 'candidate', text, ts: now() });   // AI path logs the original message itself
  ch.nudgeCount = 0;   // they replied — reset the 1-day follow-up counter

  // ---- Smart intents that can arrive at ANY stage (handled by free keyword rules) ----
  if (!ch.pending) {
    if (detectOptOut(text)) {
      c.dnc = true; if (!isTerminal(ch.stage)) ch.stage = 'declined';
      return finish(ch, ["Understood — I won't message you again. Wishing you all the best! 🙏"]);
    }
    if (detectWrongNumber(text)) {
      c.dnc = true; ch.flags.push({ q: '[Wrong number] ' + text, ts: now(), resolved: false });
      return finish(ch, ["Apologies for the mix-up — I'll remove this number. Have a great day!"]);
    }
    if (detectHandoff(text)) {
      ch.flags.push({ q: '[Wants a human] ' + text, ts: now(), resolved: false });
      const out2 = ["Of course! 🙌 I'll have our recruiter reach out to you personally."];
      if (!isTerminal(ch.stage) && ch.stage !== 'new') { const p = stagePrompt(ch.stage, c, j); if (p) out2.push(p); }
      return finish(ch, out2);
    }
    if (detectScamDoubt(text)) {
      const out2 = [`Great question — this is a genuine outreach from *${db.company}* about our *${j ? j.title : ''}* role. 😊 No spam, I promise! Feel free to look us up. Happy to tell you more.`];
      if (!isTerminal(ch.stage) && ch.stage !== 'new') { const p = stagePrompt(ch.stage, c, j); if (p) out2.push(p); }
      return finish(ch, out2);
    }
    if (detectBusy(text) && !isTerminal(ch.stage)) {
      ch.nudgeCount = 0;   // we'll follow up later
      return finish(ch, ["No problem at all — take your time. 😊 I'll check back later. Just reply here whenever you're free."]);
    }
    // Pure greeting → greet warmly and re-show the current question (don't error out).
    if (detectGreeting(text) && ch.stage !== 'new' && !isTerminal(ch.stage)) {
      const out2 = [`Hello! 😊`];
      const p = stagePrompt(ch.stage, c, j); if (p) out2.push(p);
      return finish(ch, out2);
    }
  }

  if (ch.pending === 'last_working_day') {
    ch.pending = null;
    const days = parseDateToDays(text);
    ch.answers.noticePeriod = 'Serving notice — last working day: ' + text.trim();
    ch.answers.noticePeriodDays = (days == null ? 0 : days);
    advance(c, ch, 'resume', out);   // notice is only ever collected, never a reason to reject
    return finish(ch, out);
  }
  if (ch.pending === 'decline_reason') {
    ch.pending = null; ch.stage = 'declined';
    ch.answers.declineReason = text.trim();
    out.push(`Thank you ${c.name} for your time. Feel free to contact us if you change your mind. Thanks! 🙏`);
    return finish(ch, out);
  }
  if (ch.pending === 'resume_file') {
    if (detectSkip(text)) { ch.pending = null; ch.answers.resume = 'Not shared'; proceedAfterScreening(c, ch, out); return finish(ch, out); }
    // Any other text (e.g. a pasted link) isn't a file — keep asking for the actual attachment.
    out.push(`I'll need the actual file, not a link 🙂 Please attach your resume here as a *PDF or Word* document — or say *"skip"* if you don't have one handy.`);
    return finish(ch, out);
  }
  if (ch.pending === 'preflocation_more') {
    const v = detectComfort(text);
    if (v === 'yes') { ch.pending = 'preflocation_extra'; out.push('Sure! Which other city? 🙂'); return finish(ch, out); }
    if (v === 'no') { ch.pending = null; afterPreferredLocation(c, ch, out); return finish(ch, out); }
    out.push(`Just to confirm — would you like to add another city? (yes/no)`); return finish(ch, out);
  }
  if (ch.pending === 'preflocation_extra') {
    ch.pending = 'preflocation_more';
    ch.answers.preferredLocation += ', ' + text.trim();
    out.push(`Added *${text.trim()}*! 😊 Would you like to add any other city? (yes/no)`);
    return finish(ch, out);
  }
  if (ch.pending === 'avail_none_confirm') {
    ch.pending = null;
    const v = detectComfort(text);
    if (v === 'no') {
      ch.stage = 'pending_review';
      out.push(`No problem at all — thank you so much for your time today! 🙏 Our recruiter will personally follow up with you to find a suitable next step.`);
      return finish(ch, out);
    }
    ch.pending = 'avail_open';
    out.push(`Wonderful! 😊 Since this is a *high-priority role* and we're hoping to close things within the next *3-4 days*, what date and time would work best for you?`);
    return finish(ch, out);
  }
  if (ch.pending === 'avail_open') {
    ch.pending = null;
    ch.answers.availability = text.trim();
    confirmSchedule(c, ch, out);
    return finish(ch, out);
  }

  if (ch.stage === 'new' || isTerminal(ch.stage)) {
    // Candidate is finished (scheduled / declined / dropped). Only respond to messages that are actually
    // relevant to the role or the call — otherwise stay silent (no replies to casual chit-chat).
    if (wantsReschedule(text) && ch.stage === 'scheduled') {
      ch.activePoll = null; ch.activePollMsgId = null; ch.answers.scheduledStartISO = null; ch.answers.scheduledEndISO = null;
      ch.stage = 'availdate';
      out.push(`Sure — let's find a new time. 🙂`);
      out.push(stagePrompt('availdate', c, jobOf(c)));
      return finish(ch, out);
    }
    if (detectAck(text)) {
      if (!ch.terminalAcked) { ch.terminalAcked = true; out.push("You're welcome! 😊 You're all set — our recruiter will be in touch. Have a great day!"); }
      return finish(ch, out);   // don't keep replying to repeated "thanks/ok"
    }
    if (isRecruitmentRelevant(text)) { askQuestion(c, ch, text, out); return finish(ch, out); }
    // Irrelevant chatter → record it but send no reply.
    ch.ignoredCount = (ch.ignoredCount || 0) + 1;
    return finish(ch, out);   // out is empty → nothing sent
  }

  // Numbered-option shortcut: if the current stage offers a numbered list and the candidate replied with
  // just a number (e.g. "2"), translate it to that option's answer before the stage handles it.
  const _opt = (ch.stage === 'availdate' || ch.stage === 'availtime') ? null : pollForStage(ch.stage, c, j);   // avail uses plain lists — a bare number there means a time/date, not an option index
  if (_opt && _opt.options && /^\s*\d{1,2}\s*$/.test(text)) {
    const _i = parseInt(text, 10) - 1;
    if (_i >= 0 && _i < _opt.options.length) text = voteToAnswer(ch.stage, _opt.options[_i]);
  }

  switch (ch.stage) {
    case 'outreach': {
      if (detectWhatIsThis(text)) {
        out.push(`Of course! 😊 We're reaching out from *${db.company}* about a potential *${j ? j.title : ''}* opportunity that we think could be a great fit for you. Would you like to explore it further?`);
        break;
      }
      const v = detectInterest(text);
      if (v === 'yes') { ch.answers.interested = 'Yes'; advance(c, ch, 'location', out); }
      else if (v === 'no' || v === 'maybe') {
        // Not interested → ask the reason, then send the not-interested closing (per the flow doc).
        ch.answers.interested = 'No';
        ch.pending = 'decline_reason';
        out.push(`No problem at all — thank you for letting me know! 🙏 May I ask the main reason you're not keen right now? (a quick line is fine)`);
      }
      else { if (questionLike(text)) sideQuestion(c, ch, text, out, false); out.push(clarify('outreach', j)); }
      break;
    }
    case 'location': {
      if (questionLike(text)) { if (sideQuestion(c, ch, text, out, true)) break; out.push(stagePrompt('location', c, j)); break; }
      ch.answers.currentLocation = text.trim(); advance(c, ch, 'currentctc', out);
      break;
    }
    case 'currentctc': {
      if (questionLike(text) && !/\d/.test(text)) { if (sideQuestion(c, ch, text, out, true)) break; out.push(stagePrompt('currentctc', c, j)); break; }
      // Free-text CTC break-up (fixed / variable / ESOP) — captured as-is, never used to reject.
      ch.answers.currentCTC = canonicalCTC(text.trim());
      advance(c, ch, 'opentocity', out);
      break;
    }
    case 'opentocity': {
      const v = detectComfort(text);
      if (v === 'yes') { ch.answers.openToCity = 'Yes'; advance(c, ch, 'notice', out); }
      else if (v === 'no') { ch.answers.openToCity = 'No'; advance(c, ch, 'notice', out); }   // collected only, never rejects
      else { if (questionLike(text)) { if (sideQuestion(c, ch, text, out, true)) break; } out.push(clarify('opentocity', j)); }
      break;
    }
    case 'notice': {
      // Currently serving notice (without a stated duration) → ask for last working day.
      if (/\bserv(e|ing)?\b|on notice|notice running|notice going on/i.test(text) && detectNoticeDays(text) === null) {
        ch.pending = 'last_working_day';
        out.push(`Got it — since you're serving your notice, what is your *last working day*? (please share the date, e.g. "15 July")`);
        break;
      }
      const d = detectNoticeDays(text);
      if (d === null) { if (questionLike(text)) { if (sideQuestion(c, ch, text, out, true)) break; } out.push(clarify('notice', j)); break; }
      ch.answers.noticePeriod = canonicalNotice(d); ch.answers.noticePeriodDays = d;
      advance(c, ch, 'resume', out);
      break;
    }
    case 'resume': {
      if (detectSkip(text)) { ch.answers.resume = 'Not shared'; proceedAfterScreening(c, ch, out); break; }
      const v = detectComfort(text);
      if (v === 'no') { ch.answers.resume = 'Not shared'; proceedAfterScreening(c, ch, out); break; }
      // Yes, or anything else (e.g. a pasted link) — we still need the actual file, not text.
      ch.pending = 'resume_file';
      out.push(`I'll need the actual file to share with our team 🙂 Could you please attach your resume here as a *PDF or Word* document? Or just say *"skip"* if you don't have one handy.`);
      break;
    }
    case 'availnow': {
      const v = detectComfort(text);
      if (v === 'yes') { askRecruiterNow(c, out); }
      else if (v === 'no') { advance(c, ch, 'availdate', out); }
      else { out.push(`Just a quick yes or no — are you free for a call right now?` + numberedOptions('availnow', c, j)); }
      break;
    }
    case 'awaiting_recruiter_now': {
      // Candidate messaged while we're still checking with the recruiter — acknowledge, keep waiting.
      out.push(`Thanks! ⏳ I'm just confirming with our recruiter — I'll get right back to you.`);
      break;
    }
    case 'avail':         // legacy stage → treat as date selection
    case 'availdate': {
      if (questionLike(text) && !parseDateLoose(text) && !isFlexibleSchedule(text)) { askQuestion(c, ch, text, out); out.push(stagePrompt('availdate', c, j)); break; }
      // "anytime / you decide / flexible" → pick the earliest offered date and move to time.
      let d = parseDateLoose(text);
      if (!d && isFlexibleSchedule(text)) { d = availDateOptions()[0].date; }
      if (!d && detectUnavailable(text)) {
        ch.pending = 'avail_none_confirm';
        out.push(`No worries at all! 🙂 Would you still like to go ahead with a call with the recruiter?`);
        break;
      }
      if (!d) { out.push(`No problem! 🙂 Could you pick one of these *dates* for the call?` + bulletOptions('availdate', c, j)); break; }
      if (d.getDay() === 0) { out.push(`We don't schedule calls on Sundays 🙂 Could you pick another day?` + bulletOptions('availdate', c, j)); break; }
      ch.answers._dateISO = d.toISOString();
      ch.answers._dateLabel = fmtDateOpt(d);
      const slotSame = matchExplicitTimeSlot(text, d.toISOString());   // only if they gave an explicit free time (e.g. "Friday 3 PM")
      if (slotSame) {
        ch.answers.scheduledStartISO = slotSame.start.toISOString();
        ch.answers.scheduledEndISO = new Date(slotSame.start.getTime() + CALL_MIN * 60000).toISOString();
        ch.answers.availability = `${ch.answers._dateLabel}, ${slotSame.label}`;
        ch.stage = 'availtime'; confirmSchedule(c, ch, out);
      } else { advance(c, ch, 'availtime', out); }
      break;
    }
    case 'availtime': {
      const slots = daySlots(new Date(ch.answers._dateISO || Date.now()));
      const slot = matchTimeSlot(text, ch.answers._dateISO) || (isFlexibleSchedule(text) && slots.length ? slots[0] : null);
      if (!slot) {
        if (!slots.length) { out.push(`Hmm, that day has no free slots left. Could you pick another date?` + bulletOptions('availdate', c, j)); ch.stage = 'availdate'; break; }
        const tm = parseTimeHour(text);
        // They asked for a specific time that isn't in our slots → escalate to the recruiter to suggest manually.
        if (tm || detectUnavailable(text)) { escalateSlotToRecruiter(c, ch, `${ch.answers._dateLabel || ''} ${text.trim()}`.trim(), out); break; }
        out.push(`No problem! Please pick a *time slot* for the call:` + bulletOptions('availtime', c, j));
        break;
      }
      ch.answers.scheduledStartISO = slot.start.toISOString();
      ch.answers.scheduledEndISO = new Date(slot.start.getTime() + CALL_MIN * 60000).toISOString();
      ch.answers.availability = `${ch.answers._dateLabel}, ${slot.label}`;
      confirmSchedule(c, ch, out);
      break;
    }
  }
  return finish(ch, out);
}
function finish(ch, out) { out.forEach(t => ch.transcript.push({ from: 'system', text: t, ts: now() })); save(); return out; }

/* ============================================================
   AI interpreter (optional) — uses Claude to understand each
   message in context: language, nuance, "change my answer",
   negotiation, opt-out, reschedule, wrong number, etc.
   Falls back to the rule engine when AI is off or errors.
============================================================ */
function aiClient() { return db.settings.anthropicKey ? new Anthropic({ apiKey: db.settings.anthropicKey }) : null; }
function aiReady() { return !!(db.settings.aiEnabled && db.settings.anthropicKey); }
const aiModel = () => db.settings.aiModel || 'claude-opus-4-8';

// What the bot is currently trying to collect, in plain words (drives the AI's extraction).
function expectationFor(stage, j) {
  switch (stage) {
    case 'outreach': return 'whether the candidate is interested in exploring the role (yes/no)';
    case 'location': return 'their current city';
    case 'preflocation': return 'their preferred work city';
    case 'workpref': return `whether they're comfortable working ${j ? j.workingDays : ''} days/week from office in ${j ? j.location : ''} (yes/no)`;
    case 'experience': return 'their total years of work experience';
    case 'currentctc': return 'their current CTC (annual salary) as a number';
    case 'expectedctc': return 'their expected CTC (annual salary) as a number';
    case 'notice': return 'their notice period (immediate / a number of days / or that they are serving notice)';
    case 'skills': return 'their answer to the recruiter\'s skill question';
    case 'resume': return 'whether they want to share an updated resume (PDF/Word attachment) or skip';
    case 'keepprofile': return 'whether we can keep their profile on file for future opportunities (yes/no)';
    case 'resurface': return 'roughly when they might be open to exploring new opportunities';
    case 'avail': case 'availdate': return 'the date they want the recruiter call';
    case 'availtime': return 'the time slot they want for the call';
    default: return 'nothing further — the conversation has reached an end state';
  }
}
const AI_DECISION_TOOL = {
  name: 'decide',
  description: 'Decide how to handle the candidate\'s latest message and what to reply.',
  input_schema: {
    type: 'object',
    properties: {
      intent: { type: 'string', enum: ['answer', 'question', 'not_interested', 'opt_out', 'reschedule', 'wrong_person', 'human_handoff', 'change_answer', 'busy', 'smalltalk', 'unclear'], description: 'The candidate\'s intent.' },
      field: { type: 'string', enum: ['interest', 'currentLocation', 'preferredLocation', 'workpref', 'experience', 'currentctc', 'expectedctc', 'notice', 'skills', 'resume', 'availability', 'none'], description: 'For answer: the field this answers (usually the one being asked). For change_answer: which earlier field to update.' },
      value: { type: 'string', description: 'For answer/change_answer, the canonical value to record. Formats: interest/workpref → "yes" or "no"; experience → "<n> years"; currentctc/expectedctc → a number like "12" or "12 LPA"; notice → "immediate" / "<n> days" / "serving notice"; location → the city; availability → "<day or date> <time>" e.g. "Friday 3 pm"; resume → the link or "skip". Empty for other intents.' },
      reply: { type: 'string', description: 'The message to send the candidate, in THEIR language. For intent=answer leave EMPTY (the system sends the next question). Required for question/smalltalk/not_interested/opt_out/wrong_person/human_handoff/busy/reschedule/change_answer.' },
      language: { type: 'string', description: 'Language the candidate is writing in, e.g. English, Hindi, Hinglish.' },
      flagForRecruiter: { type: 'boolean', description: 'True if a human recruiter should review this (e.g. an unanswerable question, negotiation, complaint).' },
    },
    required: ['intent', 'value', 'reply', 'language', 'flagForRecruiter'],
  },
};
function aiSystemPrompt(c, ch) {
  const j = jobOf(c), a = ch.answers || {};
  const known = Object.entries(a).filter(([k, v]) => v && typeof v !== 'object').map(([k, v]) => `  - ${k}: ${v}`).join('\n');
  const skillQs = (j && j.skillQuestions || []).filter(Boolean).map((q, i) => `  ${i + 1}. ${q}`).join('\n');
  return `You are a warm, professional recruitment assistant for ${db.company}, screening a candidate over ${ch === c.wa ? 'WhatsApp' : 'email'} for a real job. You are talking to a real human — handle the conversation naturally.

THE ROLE
  Title: ${j ? j.title : '-'}
  Location: ${j ? j.location : '-'} (${j ? j.workingDays : '?'} days/week from office${j && j.remote === 'No' ? ', no remote' : ''})
  Max notice period for auto-scheduling: ${noticeLabel(j && j.maxNoticeDays != null ? j.maxNoticeDays : DEFAULT_MAX_NOTICE_DAYS)} (never reject the candidate over this — just note it)
${skillQs ? '  Skill questions for this role:\n' + skillQs : ''}

WHAT WE'VE COLLECTED SO FAR
${known || '  (nothing yet)'}

RIGHT NOW we are waiting for: ${expectationFor(ch.stage, j)}.

YOUR JOB: read the candidate's latest message (it may be in any language, informal, or off-topic) and call the "decide" tool.
GUIDELINES
  - If they answered what we're waiting for → intent "answer", set field + value in the exact canonical format, leave reply empty.
  - If they asked a question → intent "question"; answer briefly and helpfully in their language. For CTC/budget/salary negotiation say a recruiter will discuss specifics on the call, and set flagForRecruiter true. If you don't know, say a recruiter will help and set flagForRecruiter true.
  - If they want to fix an earlier answer ("actually my CTC is 15") → intent "change_answer" with the field + new value, and a short confirming reply.
  - "stop messaging me / not interested ever / remove me" → intent "opt_out", brief polite reply confirming we'll stop.
  - "not interested right now" → intent "not_interested".
  - Wrong person / "who is this" doubting it's real → intent "wrong_person" (reassure who you are) or handle as question if they just want to confirm legitimacy.
  - "call me later / busy / text me tomorrow" → intent "busy", acknowledge warmly.
  - Wants a human / "let me talk to someone" → intent "human_handoff", say you'll connect them, flagForRecruiter true.
  - Already scheduled and they want a different time → intent "reschedule".
  - Pure greeting/chit-chat with no content → intent "smalltalk".
  - Can't tell → intent "unclear", ask them to clarify in their language.
  - Always reply in the SAME language the candidate used. Keep replies short and friendly. Never invent role details not given above.`;
}
function aiCompactTranscript(ch) {
  const t = (ch.transcript || []).slice(-12);
  return t.map(m => `${m.from === 'candidate' ? 'Candidate' : 'You'}: ${m.text}`).join('\n');
}
// Returns a decision object or null on failure.
async function aiDecide(c, ch, text) {
  const client = aiClient(); if (!client) return null;
  try {
    const resp = await client.messages.create({
      model: aiModel(),
      max_tokens: 700,
      system: [{ type: 'text', text: aiSystemPrompt(c, ch), cache_control: { type: 'ephemeral' } }],
      tools: [AI_DECISION_TOOL],
      tool_choice: { type: 'tool', name: 'decide' },
      messages: [{ role: 'user', content: `Conversation so far:\n${aiCompactTranscript(ch)}\n\nCandidate's latest message:\n"""${text}"""\n\nCall decide.` }],
    });
    const blk = (resp.content || []).find(b => b.type === 'tool_use');
    return blk ? blk.input : null;
  } catch (e) { log('AI error: ' + e.message); return null; }
}
const FIELD_TO_STAGE = { interest: 'outreach', currentLocation: 'location', preferredLocation: 'preflocation', workpref: 'workpref', experience: 'experience', currentctc: 'currentctc', expectedctc: 'expectedctc', notice: 'notice', resume: 'resume', availability: 'avail' };
// RULES FIRST: can the cheap keyword engine handle this message at the current stage?
// If yes → use the free rules. If no → fall back to the (paid) AI interpreter.
function rulesUnderstand(c, ch, text) {
  const t = text || '';
  // Opt-out / "stop messaging" anywhere → let the AI handle it properly (mark do-not-contact).
  if (/\b(stop|unsubscribe|do ?n['o]?t (message|contact|text)|remove me|leave me alone|do not contact|not interested ever)\b/i.test(t)) return false;
  const s = ch.stage;
  if (ch.pending === 'last_working_day') return parseDateToDays(t) !== null;
  if (ch.pending === 'resume_file') return true;
  if (ch.pending === 'decline_reason') return true;   // any text is a valid reason
  if (ch.pending === 'avail_none_confirm') return detectComfort(t) !== null || questionLike(t);
  if (ch.pending === 'avail_open') return true;
  if (detectGreeting(t)) return true;   // pure greetings handled free
  if (s === 'new' || isTerminal(s)) return true;   // ack / relevance filter already handle these (no AI needed)
  const q = questionLike(t);
  switch (s) {
    case 'outreach': return detectInterest(t) !== null || q;
    case 'location': return true;                            // any text is taken as the city
    case 'currentctc': return true;                          // free-text CTC break-up captured as-is
    case 'opentocity': return detectComfort(t) !== null || q;
    case 'availnow': return detectComfort(t) !== null || q;
    case 'awaiting_recruiter_now': return true;
    case 'notice': return /\bserv(e|ing)?\b|on notice|notice running|notice going on/i.test(t) || detectNoticeDays(t) !== null || q;
    case 'resume': return true;                              // any text / "skip" recorded
    case 'avail': case 'availdate': return parseDateLoose(t) !== null || isFlexibleSchedule(t) || q;
    case 'availtime': return matchTimeSlot(t, ch.answers._dateISO) !== null || isFlexibleSchedule(t) || q;
    default: return true;
  }
}
// AI-driven processing. Returns reply strings (engine prompts + AI replies). Falls back to rule engine.
async function aiProcess(c, ch, text) {
  const d = await aiDecide(c, ch, text);
  if (!d) return handleIncoming(c, ch, text);   // fall back to rules
  ch._lastAI = d;                                // expose decision (used by the test lab)
  ch.transcript.push({ from: 'candidate', text, ts: now() });
  ch.nudgeCount = 0;
  if (d.flagForRecruiter) ch.flags.push({ q: text, ts: now(), resolved: false, ai: true });
  log(`🤖 ${c.name}: intent=${d.intent}${d.field && d.field !== 'none' ? ' field=' + d.field : ''} lang=${d.language || '?'}`);
  const reply = (d.reply || '').trim();
  switch (d.intent) {
    case 'answer': {
      // Hand the canonical value to the rule engine so polls / dropouts / CTC checks / calendar all still run.
      // skipPush=true: we already logged the candidate's original message above.
      return handleIncoming(c, ch, d.value || text, true);
    }
    case 'change_answer': {
      if (d.field && d.field !== 'none' && d.value) { ch.answers[d.field === 'availability' ? 'availability' : d.field] = d.value; }
      return finish(ch, [reply || 'Got it — I\'ve updated that. 👍']);
    }
    case 'opt_out': {
      c.dnc = true; ch.stage = isTerminal(ch.stage) ? ch.stage : 'declined';
      return finish(ch, [reply || "Understood — I won't message you again. Wishing you all the best! 🙏"]);
    }
    case 'wrong_person': {
      c.dnc = true; ch.flags.push({ q: '[Wrong person] ' + text, ts: now(), resolved: false });
      return finish(ch, [reply || `Apologies for the confusion! I'll remove this number. Have a great day.`]);
    }
    case 'not_interested': {
      const out2 = [reply || "Thank you so much for letting us know! 🙏"];
      advance(c, ch, 'keepprofile', out2);
      return finish(ch, out2);
    }
    case 'human_handoff': {
      return finish(ch, [reply || "Absolutely — I'll have our recruiter reach out to you personally. 🙌"]);
    }
    case 'busy': {
      return finish(ch, [reply || "No problem at all — take your time. I'll check back later. 😊"]);
    }
    case 'reschedule': {
      ch.answers.scheduledStartISO = null; ch.answers.scheduledEndISO = null; ch.activePoll = null; ch.activePollMsgId = null; ch.calendarDone = false;
      ch.stage = 'availdate';
      return finish(ch, [reply || "Sure — let's find a new time. 🙂", stagePrompt('availdate', c, jobOf(c))]);
    }
    case 'question': case 'smalltalk': case 'unclear': default: {
      const out = [reply || "Could you tell me a bit more?"];
      // If we're mid-flow, gently re-show the current question so we don't stall.
      if (!isTerminal(ch.stage) && ch.stage !== 'new' && d.intent !== 'smalltalk') {
        const p = stagePrompt(ch.stage, c, jobOf(c)); if (p) out.push(p);
      }
      return finish(ch, out);
    }
  }
}

/* ---------------- Logger (shared) ---------------- */
const logs = [];
function log(m) { const line = `[${new Date().toLocaleTimeString()}] ${m}`; logs.push(line); if (logs.length > 200) logs.shift(); console.log(line); }

/* ---------------- Settings + backfill ---------------- */
db.settings = db.settings || {};
if (!db.settings.sheetId) db.settings.sheetId = '1O5V9k5hVzQ_1gUIuFwHIQok-fZsBllWaQZSyOuyUghw';
db.candidates.forEach(c => { if (!c.em) c.em = newChannel(); if (!c.wa) c.wa = newChannel(); });
const stripMd = t => (t || '').replace(/\*/g, '');

/* ---------------- Google Sheet integration (source of candidates + write-back) ---------------- */
const SHEET_TAB = 'Reachouts to be done';
const SHEET_SUMMARY_TAB = 'Conversation Summary';
const SA_KEY_PATH = path.join(__dirname, 'google-service-account.json');
let _sheetsApi = null;
async function sheetsApi() {
  if (_sheetsApi) return _sheetsApi;
  if (!fs.existsSync(SA_KEY_PATH) || !db.settings.sheetId) return null;
  const { google } = require('googleapis');
  const auth = new google.auth.GoogleAuth({ keyFile: SA_KEY_PATH, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  _sheetsApi = google.sheets({ version: 'v4', auth: await auth.getClient() });
  return _sheetsApi;
}
const colLetter = i => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
// Read the tab; return { header:[], rows:[[...]], idx:{colName:index} }.
async function readSheetTab() {
  const api = await sheetsApi(); if (!api) throw new Error('Google Sheet not connected (missing key or sheet id).');
  const r = await api.spreadsheets.values.get({ spreadsheetId: db.settings.sheetId, range: SHEET_TAB });
  const rows = r.data.values || []; const header = rows[0] || [];
  const idx = {}; header.forEach((h, i) => idx[h] = i);
  return { header, rows, idx };
}
// Map a candidate's collected answers onto the sheet's write-back columns.
function sheetWriteMap(c) {
  const a = c.wa.answers || {};
  return {
    interested: a.interested || '',
    not_interested_reason: a.declineReason || '',
    current_location_confirmed: a.currentLocation || '',
    current_ctc_breakup: a.currentCTC || '',
    open_to_city: a.openToCity || '',
    notice_period: a.noticePeriod || '',
    resume_status: a.resume || '',
    whatsapp_status: STAGE_LABEL[c.wa.stage] || c.wa.stage,
    last_message_sent_at: c.wa.lastMsgSentAt || '',
    last_candidate_reply_at: c.wa.lastReplyAt || '',
    follow_up_count: String(c.wa.nudgeCount || 0),
    scheduled_slot: a.availability || '',
    assigned_recruiter: a.scheduledRecruiter || c.recruiterName || '',
    conversation_done: a.conversationDone || '',
  };
}
// Write a candidate's answers back to their row in the sheet (only if it came from the sheet).
async function writeCandidateToSheet(c) {
  try {
    if (!c || !c.sheetRow) return;
    const api = await sheetsApi(); if (!api) return;
    let idx = db.settings._sheetIdx; if (!idx) return;
    const map = sheetWriteMap(c);
    // Auto-create any missing columns (e.g. scheduled_slot / assigned_recruiter / conversation_done).
    let maxCol = Math.max(...Object.values(idx));
    const newHeaders = [];
    for (const col of Object.keys(map)) { if (idx[col] == null) { idx[col] = ++maxCol; newHeaders.push({ range: `${SHEET_TAB}!${colLetter(idx[col])}1`, values: [[col]] }); } }
    if (newHeaders.length) await ensureSheetColumns(api, maxCol + 1);   // grow the grid so new columns don't exceed its limit
    const data = newHeaders.slice();
    for (const [col, val] of Object.entries(map)) data.push({ range: `${SHEET_TAB}!${colLetter(idx[col])}${c.sheetRow}`, values: [[val]] });
    db.settings._sheetIdx = idx;
    if (data.length) await api.spreadsheets.values.batchUpdate({ spreadsheetId: db.settings.sheetId, requestBody: { valueInputOption: 'RAW', data } });
    updateSummaryTab().catch(() => {});
  } catch (e) { log('Sheet write-back failed for ' + (c && c.name) + ': ' + e.message); }
}
// Grow the sheet's column grid if we need more columns than it currently has (avoids "exceeds grid limits").
async function ensureSheetColumns(api, needCols) {
  const meta = await api.spreadsheets.get({ spreadsheetId: db.settings.sheetId });
  const sh = meta.data.sheets.find(s => s.properties.title === SHEET_TAB); if (!sh) return;
  const cur = (sh.properties.gridProperties && sh.properties.gridProperties.columnCount) || 0;
  if (needCols > cur) await api.spreadsheets.batchUpdate({ spreadsheetId: db.settings.sheetId, requestBody: { requests: [{ appendDimension: { sheetId: sh.properties.sheetId, dimension: 'COLUMNS', length: needCols - cur + 2 } }] } });
}
// Ensure a job exists for this role+city (auto-derived from the sheet — no manual job creation).
function jobForRole(title, location, recruiterName) {
  let j = db.jobs.find(x => (x.title || '').trim().toLowerCase() === (title || '').trim().toLowerCase() && (x.location || '').trim().toLowerCase() === (location || '').trim().toLowerCase());
  if (!j) { j = { id: uid(), title: title || 'Role', location: location || '', workingDays: 6, remote: 'No', experience: '', skillQuestions: [], maxNoticeDays: null, recruiterName, fromSheet: true, createdAt: now() }; db.jobs.unshift(j); }
  else if (recruiterName && !j.recruiterName) j.recruiterName = recruiterName;
  return j;
}
// Pull Strong candidates from the sheet, auto-create their role+city, skip anyone contacted in the last 90 days.
async function syncFromSheet() {
  const { header, rows, idx } = await readSheetTab();
  db.settings._sheetIdx = idx; db.settings._sheetHeader = header;
  const need = ['name', 'phone', 'rating', 'level', 'city', 'recruiter_name'];
  for (const k of need) if (idx[k] == null) throw new Error(`Sheet is missing a "${k}" column.`);
  const NINETY = 90 * 24 * 60 * 60 * 1000;
  // Only handle candidates the sheet assigns to THIS logged-in recruiter (matched by email first, then name).
  const myEmail = (db.settings.recruiterEmail || '').trim().toLowerCase();
  const myName = (db.settings.recruiterName || '').trim().toLowerCase();
  if (!myEmail && !myName) throw new Error('Please log in (recruiter name + email) before syncing.');
  const rowIsMine = row => {
    const rn = (row[idx.recruiter_name] || '').trim().toLowerCase();
    const re = (idx.recruiter_email != null ? (row[idx.recruiter_email] || '').trim().toLowerCase() : '');
    if (myEmail && re) return re === myEmail;                       // email is the reliable key
    if (myName && rn) return rn === myName || rn.includes(myName) || myName.includes(rn);
    return false;
  };
  let added = 0, skippedRecent = 0, skippedExisting = 0, notStrong = 0, skippedOther = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]; if (!row || !row.length) continue;
    const rating = (row[idx.rating] || '').trim().toLowerCase();
    if (rating !== 'strong') { notStrong++; continue; }
    if (!rowIsMine(row)) { skippedOther++; continue; }             // assigned to a different recruiter → their copy handles it
    const rawPhone = (row[idx.phone] || '').toString().trim(); if (!rawPhone) continue;
    const phone = fmtPhone(rawPhone);
    const sheetRow = i + 1;
    // 90-day guardrail: skip only if WE actually reached out on WhatsApp within 90 days (tracked in
    // RecruitFlow) — NOT the sheet's sourcing timestamps, which don't mean a WhatsApp message was sent.
    const prior = db.candidates.find(x => last10(x.phone) === last10(phone) && (x.wa.outreachSentAt || x.wa.lastMsgSentAt));
    if (prior) {
      const t = prior.wa.outreachSentAt || Date.parse(prior.wa.lastMsgSentAt || '') || 0;
      if (t && (Date.now() - t) < NINETY) { if (prior.fromSheet) prior.sheetRow = sheetRow; skippedRecent++; continue; }
    }
    const existing = db.candidates.find(x => last10(x.phone) === last10(phone) && x.fromSheet);
    if (existing) { existing.sheetRow = sheetRow; skippedExisting++; continue; }
    const j = jobForRole(row[idx.level], row[idx.city], row[idx.recruiter_name]);
    const c = mkCand(j.id, { name: row[idx.name], email: '', phone, targetLocation: row[idx.city] });
    c.fromSheet = true; c.sheetRow = sheetRow; c.recruiterName = row[idx.recruiter_name] || '';
    db.candidates.push(c); added++;
  }
  save();
  log(`📥 Sheet sync (${db.settings.recruiterName || '?'}): ${added} added, ${skippedRecent} skipped (contacted <90d), ${skippedExisting} already imported, ${skippedOther} for other recruiters.`);
  return { added, skippedRecent, skippedExisting, notStrong, skippedOther };
}
// Rebuild the "Conversation Summary" tab: one row per sheet candidate with every answer + status.
async function updateSummaryTab() {
  const api = await sheetsApi(); if (!api) return;
  const meta = await api.spreadsheets.get({ spreadsheetId: db.settings.sheetId });
  const has = meta.data.sheets.some(s => s.properties.title === SHEET_SUMMARY_TAB);
  if (!has) await api.spreadsheets.batchUpdate({ spreadsheetId: db.settings.sheetId, requestBody: { requests: [{ addSheet: { properties: { title: SHEET_SUMMARY_TAB } } }] } });
  const HED = ['Candidate', 'Phone', 'Recruiter', 'Level', 'City', 'Interested', 'Not-interested reason', 'Current location', 'Current CTC (fixed/var/ESOP)', 'Open to city', 'Notice period', 'Resume', 'Availability', 'Status', 'Follow-ups', 'Last reply'];
  const list = db.candidates.filter(c => c.fromSheet);
  const data = [HED];
  for (const c of list) {
    const a = c.wa.answers || {}, j = jobOf(c) || {};
    data.push([c.name || '', c.phone || '', c.recruiterName || '', j.title || '', j.location || '', a.interested || '', a.declineReason || '', a.currentLocation || '', a.currentCTC || '', a.openToCity || '', a.noticePeriod || '', a.resume || '', a.availability || '', STAGE_LABEL[c.wa.stage] || c.wa.stage, String(c.wa.nudgeCount || 0), c.wa.lastReplyAt || '']);
  }
  await api.spreadsheets.values.update({ spreadsheetId: db.settings.sheetId, range: `${SHEET_SUMMARY_TAB}!A1`, valueInputOption: 'RAW', requestBody: { values: data } });
}

/* ---------------- Google Calendar (OAuth + auto-insert) ---------------- */
const { google } = require('googleapis');
const OAUTH_REDIRECT = `http://localhost:${PORT}/oauth2callback`;
function oauthClient() {
  const s = db.settings;
  if (!s.googleClientId || !s.googleClientSecret) return null;
  const o = new google.auth.OAuth2(s.googleClientId, s.googleClientSecret, OAUTH_REDIRECT);
  if (s.googleToken) o.setCredentials(s.googleToken);
  return o;
}
const calendarConnected = () => !!(db.settings.googleClientId && db.settings.googleClientSecret && db.settings.googleToken);
function googleAuthUrl() { const o = oauthClient(); return o ? o.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: ['https://www.googleapis.com/auth/calendar.events'] }) : null; }

// Best-effort conversion of free-text availability ("monday 11am", "tomorrow evening") to a real datetime.
function parseAvailabilityToDate(text) {
  text = (text || '').toLowerCase(); const base = new Date(); const d = new Date(base); let uncertain = false;
  if (/day after/.test(text)) d.setDate(d.getDate() + 2);
  else if (/tomorrow|tmrw/.test(text)) d.setDate(d.getDate() + 1);
  else if (/today/.test(text)) { }
  else {
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']; let found = -1;
    for (let i = 0; i < 7; i++) if (text.includes(days[i].slice(0, 3))) { found = i; break; }
    if (found >= 0) { let add = (found - d.getDay() + 7) % 7; if (add === 0) add = 7; d.setDate(d.getDate() + add); }
    else { d.setDate(d.getDate() + 1); uncertain = true; }
  }
  let hour = null, min = 0, m;
  if ((m = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/))) { hour = parseInt(m[1]) % 12; if (m[3] === 'pm') hour += 12; if (m[2]) min = parseInt(m[2]); }
  else if (/morning/.test(text)) hour = 10;
  else if (/after\s?noon|afternoon/.test(text)) hour = 14;
  else if (/evening/.test(text)) hour = 16;
  else if ((m = text.match(/\b(\d{1,2})\b/))) { hour = parseInt(m[1]); if (hour < 8) hour += 12; }
  if (hour === null) { hour = 10; uncertain = true; }
  d.setHours(hour, min, 0, 0);
  if (d < base) d.setDate(d.getDate() + 1);
  return { start: d, uncertain };
}
const pad2 = n => String(n).padStart(2, '0');
function eventDetails(c, ch, uncertain) {
  const j = jobOf(c), a = ch.answers;
  return `Candidate: ${c.name}\nPhone: ${c.phone || '-'}\nEmail: ${c.email || '-'}\nRole: ${j ? j.title : ''} (${j ? j.roleType : ''})\n\nStated availability: ${a.availability}\nCurrent location: ${a.currentLocation || '-'}\nPreferred location: ${a.preferredLocation || '-'}\nExperience: ${a.experience || '-'}\nCurrent CTC: ${a.currentCTC || '-'}\nExpected CTC: ${a.expectedCTC || '-'}\nNotice: ${a.noticePeriod || '-'}\nSkill answers: ${(a.skills || []).map(s => s.q + ' → ' + s.a).join(' | ') || '-'}` + (uncertain ? `\n\n(Time was ESTIMATED from the candidate's text — please verify.)` : '');
}
// Candidate-facing event description (clean — no internal CTC / screening notes).
function eventDetailsCandidate(c, ch) {
  const j = jobOf(c);
  return `Your call with the ${db.company} recruiter for the ${j ? j.title : ''} role.\n\nWhen: ${ch.answers.availability}\nPlease keep your phone handy — our recruiter will call you. We look forward to speaking with you!`;
}
// The call slot (30 min) from the candidate's stated availability.
function callSlot(ch) {
  if (ch.answers.scheduledStartISO) { const start = new Date(ch.answers.scheduledStartISO); const end = ch.answers.scheduledEndISO ? new Date(ch.answers.scheduledEndISO) : new Date(start.getTime() + CALL_MIN * 60000); return { start, end, uncertain: false }; }
  const { start, uncertain } = parseAvailabilityToDate(ch.answers.availability); return { start, end: new Date(start.getTime() + CALL_MIN * 60000), uncertain };
}
// Build a Google Calendar "add event" link (pre-filled). No API/OAuth needed — works for anyone.
function gcalLink(title, details, location, start, end) {
  const f = d => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}T${pad2(d.getHours())}${pad2(d.getMinutes())}00`;
  const params = new URLSearchParams({ action: 'TEMPLATE', text: title, dates: `${f(start)}/${f(end)}`, details: details, location: location || '' });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
// Build an .ics calendar INVITE (METHOD:REQUEST) with organizer + attendees, so email clients add it directly.
function buildICS(c, ch, start, end, opts) {
  const u = d => `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}00Z`;
  const esc = s => String(s || '').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//RecruitFlow//EN', 'CALSCALE:GREGORIAN', `METHOD:${opts.method || 'REQUEST'}`, 'BEGIN:VEVENT',
    `UID:${c.id}-${start.getTime()}@recruitflow`, `DTSTAMP:${u(new Date())}`, `DTSTART:${u(start)}`, `DTEND:${u(end)}`,
    `SUMMARY:${esc(opts.summary)}`, `DESCRIPTION:${esc(opts.description)}`, `LOCATION:${esc(opts.location || '')}`, 'STATUS:CONFIRMED', 'SEQUENCE:0'];
  if (opts.organizerEmail) lines.push(`ORGANIZER;CN=${esc(db.company)}:mailto:${opts.organizerEmail}`);
  (opts.attendees || []).forEach(a => { if (a) lines.push(`ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=${esc(a)}:mailto:${a}`); });
  lines.push('BEGIN:VALARM', 'TRIGGER:-PT30M', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n');
}
// Insert the call DIRECTLY into the recruiter's Google Calendar via the API (needs OAuth connected).
// With sendUpdates:'all' + the candidate as an attendee, Google emails the candidate a real invite too.
async function insertGoogleEvent(c, ch, start, end) {
  const o = oauthClient(); if (!o || !db.settings.googleToken) throw new Error('Google Calendar not connected');
  const j = jobOf(c);
  const calendar = google.calendar({ version: 'v3', auth: o });
  const event = {
    summary: `Recruiter call: ${c.name} — ${j ? j.title : ''}`,
    description: eventDetails(c, ch, false),
    location: (j && j.location) || '',
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    attendees: [{ email: recruiterCalEmail() }, c.email ? { email: c.email } : null].filter(Boolean),
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }, { method: 'email', minutes: 60 }] },
  };
  const r = await calendar.events.insert({ calendarId: 'primary', requestBody: event, sendUpdates: 'all' });
  return (r.data && r.data.htmlLink) || true;
}
// Fallback when Google Calendar isn't connected: email proper .ics invites to both parties.
function emailCalendarInvites(c, ch, start, end, uncertain) {
  if (!mailerReady()) return;
  const j = jobOf(c), loc = (j && j.location) || '', org = recruiterCalEmail();
  const recTitle = `Recruiter call: ${c.name} — ${j ? j.title : ''}`;
  const candTitle = `Call with ${db.company} — ${j ? j.title : ''} role`;
  const recDetails = eventDetails(c, ch, uncertain), candDetails = eventDetailsCandidate(c, ch);
  const recIcs = buildICS(c, ch, start, end, { summary: recTitle, description: recDetails, location: loc, organizerEmail: org, attendees: [org, c.email].filter(Boolean) });
  const recBody = `${c.name} has scheduled a recruiter call.\n\nWhen: ${ch.answers.availability}\nRole: ${j ? j.title : ''}\nPhone: ${c.phone || '-'}\nEmail: ${c.email || '-'}\n\nAdd to your calendar: ${ch.answers.calendarLink}\n\n(A calendar invite is attached — open it to add to any calendar app.)`;
  sendEmail(org, `📅 Recruiter call scheduled — ${c.name}`, recBody, [{ filename: 'invite.ics', content: recIcs, contentType: 'text/calendar; method=REQUEST' }])
    .then(() => log(`📧 Calendar invite emailed to recruiter (${org})`)).catch(e => log('Recruiter invite email failed: ' + e.message));
  if (c.email) {
    const candIcs = buildICS(c, ch, start, end, { summary: candTitle, description: candDetails, location: loc, organizerEmail: org, attendees: [c.email] });
    const candBody = `Hi ${c.name},\n\nYour call with the ${db.company} recruiter is confirmed for ${ch.answers.availability}.\n\nAdd it to your calendar: ${ch.answers.candidateCalendarLink}\n\n(A calendar invite is attached too — open it to add the call to any calendar app.)\n\nLooking forward to speaking with you!\n\n${db.company} Talent Team`;
    sendEmail(c.email, `📅 Your call with ${db.company} — ${ch.answers.availability}`, candBody, [{ filename: 'invite.ics', content: candIcs, contentType: 'text/calendar; method=REQUEST' }])
      .then(() => log(`📧 Calendar invite emailed to candidate (${c.email})`)).catch(e => log('Candidate invite email failed: ' + e.message));
  }
}
// On scheduling: add the call to Google Calendar directly if connected; otherwise email .ics invites.
function onScheduled(c, ch) {
  if (ch.calendarDone) return;
  ch.calendarDone = true;
  try {
    const j = jobOf(c), { start, end, uncertain } = callSlot(ch);
    const loc = (j && j.location) || '';
    const recTitle = `Recruiter call: ${c.name} — ${j ? j.title : ''}`;
    const candTitle = `Call with ${db.company} — ${j ? j.title : ''} role`;
    // One-tap add-to-calendar links (always available, shown in dashboard + candidate message)
    ch.answers.calendarLink = gcalLink(recTitle, eventDetails(c, ch, uncertain), loc, start, end);
    ch.answers.candidateCalendarLink = gcalLink(candTitle, eventDetailsCandidate(c, ch), loc, start, end);
    save();
    log(`📅 Calendar links ready for ${c.name} (${ch.answers.availability})${uncertain ? ' [time estimated]' : ''}`);
    if (calendarConnected()) {
      // Preferred: insert straight into the recruiter's Google Calendar (also invites the candidate via Google).
      insertGoogleEvent(c, ch, start, end)
        .then(link => { if (typeof link === 'string') { ch.answers.googleEventLink = link; save(); } log(`📅 Added directly to your Google Calendar${c.email ? ' and invited ' + c.email : ''}.`); })
        .catch(e => { log('Google Calendar insert failed (' + e.message + ') — falling back to email invites.'); emailCalendarInvites(c, ch, start, end, uncertain); });
    } else {
      emailCalendarInvites(c, ch, start, end, uncertain);
    }
  } catch (e) { ch.calendarDone = false; log('Calendar error for ' + c.name + ': ' + e.message); }
}

/* ---------------- Email channel (SMTP send + IMAP read) ---------------- */
const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
let emailStatus = 'off';   // off | ok | error
const mailerReady = () => !!(db.settings.email && db.settings.emailPass);
function transporter() { return nodemailer.createTransport({ service: 'gmail', auth: { user: db.settings.email, pass: db.settings.emailPass } }); }
async function sendEmail(to, subject, text, attachments) { await transporter().sendMail({ from: `"${db.company || 'RecruitFlow'}" <${db.settings.email}>`, to, subject, text, attachments: attachments || [] }); }
function emailSubject(c) { const j = jobOf(c); return c.em.subject || `Exploring a ${j ? j.title : ''} opportunity at ${db.company}`; }
// Strip quoted history from an email reply, keep the candidate's new text.
function topReply(text) {
  if (!text) return '';
  const out = [];
  for (const ln of text.split(/\r?\n/)) {
    if (/^\s*>/.test(ln) || /^On .+wrote:?$/.test(ln.trim()) || /^-----\s*Original/.test(ln) || /^From:\s/.test(ln) || /^_{5,}/.test(ln)) break;
    out.push(ln);
  }
  return (out.join('\n').trim()) || text.trim();
}
async function sendEmailOutreachTo(c) {
  const j = jobOf(c);
  if (c.dnc || !j || !c.email || c.em.stage !== 'new') return false;
  const subject = `Exploring a ${j.title} opportunity at ${db.company}`;
  c.em.subject = subject;
  const attach = j.jdFile ? [{ filename: j.jdFileName || 'Job-Description.pdf', path: path.join(UP_DIR, j.jdFile) }] : [];
  const qs = (j.skillQuestions || []).filter(q => q && q.trim());
  let qNum = 7;
  let skillLines = qs.map((q, i) => `${qNum + i}. ${q}:`).join('\n');
  const resumeNum = qNum + qs.length;
  const body = `Hi ${c.name}!\n\nI'm reaching out from ${db.company}. We came across your profile and think you could be a great fit for our ${j.title} role${j.location ? ` based in ${j.location}` : ''}.\n\n${j.jdFile ? `The full job description is attached — please take a look.\n\n` : ''}If you're interested, please reply to this email with the following details:\n\n──────────────────────\n1. Current city (where you're based now):\n2. Preferred work location:\n3. Total years of experience:\n4. Current CTC (annual, in LPA — required, a number):\n5. Expected CTC (annual, in LPA — required, a number):\n6. Notice period (e.g. "immediate", "30 days", "2 months"):\n${skillLines ? skillLines + '\n' : ''}${resumeNum}. Resume: Please attach your updated resume, or type "no resume" if not available.\n──────────────────────\n\nIf you're not actively looking right now, no worries — feel free to reach out on this email once you are.\n\nWarm regards,\n${db.company} Talent Team`;
  await sendEmail(c.email, subject, body, attach);
  c.em.stage = 'details_form'; c.em.transcript.push({ from: 'system', text: body, ts: now() }); save();
  return true;
}
async function runEmailJob(jid) {
  if (!mailerReady()) throw new Error('Email not set up. Add your Gmail + app password in Settings.');
  const list = candsOf(jid); let sent = 0; const failed = [];
  for (const c of list) {
    if (c.em.stage !== 'new') continue;
    if (!c.email) { failed.push(c.name + ' (no email)'); continue; }
    try { await sendEmailOutreachTo(c); sent++; } catch (e) { failed.push(c.name + ' (' + e.message + ')'); }
  }
  return { sent, failed };
}
// Send the email outreach to a SINGLE candidate.
async function runEmailOne(candId) {
  if (!mailerReady()) throw new Error('Email not set up. Add your Gmail + app password in Settings.');
  const c = db.candidates.find(x => x.id === candId);
  if (!c) throw new Error('Candidate not found.');
  if (!c.email) throw new Error('This candidate has no email address.');
  if (c.em.stage !== 'new') throw new Error('Email outreach already sent to this candidate.');
  await sendEmailOutreachTo(c);
  return { sent: 1, name: c.name };
}
// Parse a candidate's one-shot reply to the details-form email (all fields in one message).
function parseFormReply(text, j) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  const tl = text.toLowerCase();
  const result = {};

  // Not interested? Check the first couple of lines.
  const firstChunk = lines.slice(0, 4).join(' ').toLowerCase();
  if (/(not interested|not looking|not exploring|not open|happy where|not right now|i'?ll pass|not keen)/i.test(firstChunk) && !/\byes\b|\binterested\b|\bsure\b|\bopen\b/i.test(firstChunk)) {
    result.notInterested = true; return result;
  }

  // Extract numbered-answer lines: "1. Mumbai" / "1) Mumbai" / "1: Mumbai"
  const labeled = {};
  for (const line of lines) {
    const m = line.match(/^\s*(\d+)\s*[.):\-]\s*(.+)$/);
    if (m) labeled[+m[1]] = m[2].trim();
  }

  // Helper: extract from labeled map, then fall back to regex on full text.
  const pick = (num, ...regexes) => {
    if (labeled[num]) return labeled[num];
    for (const re of regexes) { const m = text.match(re); if (m) return m[1].trim(); }
    return null;
  };

  result.currentLocation = pick(1,
    /current\s*(?:city|location)\s*[:]\s*(.+)/i,
    /(?:i'?m based in|currently in|i live in|based in)\s*([A-Za-z ]+?)(?:[.,\n]|$)/i);

  result.preferredLocation = pick(2,
    /preferred?\s*(?:work\s*)?location\s*[:]\s*(.+)/i,
    /prefer(?:red)?\s+to\s+work\s+in\s+([A-Za-z ]+?)(?:[.,\n]|$)/i);

  // Experience: try labeled then scan all lines.
  const expRaw = pick(3, /(?:years?\s+of\s+)?experience\s*[:]\s*(.+)/i);
  if (expRaw) result.experience = detectExperience(expRaw) || expRaw;
  if (!result.experience) { for (const l of lines) { const e = detectExperience(l); if (e) { result.experience = e; break; } } }

  const ctcRaw = pick(4, /current\s*ctc\s*[:]\s*(.+)/i);
  result.currentCTC = ctcRaw ? (detectSkip(ctcRaw) ? 'Prefer not to disclose' : ctcRaw) : null;

  const ectcRaw = pick(5, /expected?\s*ctc\s*[:]\s*(.+)/i);
  result.expectedCTC = ectcRaw ? (detectSkip(ectcRaw) ? 'Prefer not to disclose' : ectcRaw) : null;

  const noticeRaw = pick(6, /notice\s*period\s*[:]\s*(.+)/i);
  if (noticeRaw) {
    result.noticePeriodRaw = noticeRaw;
    result.noticePeriodDays = detectNoticeDays(noticeRaw);
    if (result.noticePeriodDays === null && /\bimmediate\b/i.test(noticeRaw)) result.noticePeriodDays = 0;
  }

  // Skill answers (questions 7+)
  const qs = (j && j.skillQuestions || []).filter(q => q && q.trim());
  result.skills = qs.map((q, i) => ({ q, a: labeled[7 + i] || '(not provided)' }));

  // Resume
  const resumeNum = 7 + qs.length;
  const resumeRaw = labeled[resumeNum] || (tl.includes('no resume') || tl.includes('skip') ? 'Not shared' : null);
  result.resume = resumeRaw || null;

  return result;
}

// Handle a candidate's reply to the details-form email — parse everything at once, send Email 2.
async function handleEmailFormReply(c, emailParsed) {
  const j = jobOf(c), body = topReply(emailParsed.text || ''), out = [];
  c.em.transcript.push({ from: 'candidate', text: body.slice(0, 600), ts: now() });
  const parsed = parseFormReply(body, j);

  // Not interested
  if (parsed.notInterested) {
    c.em.stage = 'declined'; c.em.answers.interested = 'No';
    out.push(`No worries at all, ${c.name}! 😊\n\nYou can always reach back on this email once you're actively looking — we'd love to connect when the time is right.\n\nBest of luck!\n\n${db.company} Talent Team`);
    return finish(c.em, out);
  }

  // Store parsed answers
  if (parsed.currentLocation) c.em.answers.currentLocation = parsed.currentLocation;
  if (parsed.preferredLocation) c.em.answers.preferredLocation = parsed.preferredLocation;
  if (parsed.experience) c.em.answers.experience = parsed.experience;
  if (parsed.currentCTC) c.em.answers.currentCTC = parsed.currentCTC;
  if (parsed.expectedCTC) c.em.answers.expectedCTC = parsed.expectedCTC;
  if (parsed.noticePeriodRaw) { c.em.answers.noticePeriod = parsed.noticePeriodRaw; c.em.answers.noticePeriodDays = parsed.noticePeriodDays; }
  if (parsed.skills && parsed.skills.length) c.em.answers.skills = parsed.skills;
  // Check for an attached resume
  const att = emailParsed.attachments || [];
  const resumeFile = att.find(a => /\.(pdf|doc|docx)$/i.test(a.filename || ''));
  c.em.answers.resume = resumeFile ? `Attached: ${resumeFile.filename}` : (parsed.resume || 'Not shared');

  // Notice period / experience are only ever collected, never a reason to reject — same policy as WhatsApp.
  addScreeningFlags(c, c.em, j);
  if (!meetsAutoScheduleCriteria(c.em, j)) {
    c.em.stage = 'pending_review';
    out.push(`Hi ${c.name},\n\nThank you so much for sharing all these details with us! 🙏\n\nOur recruiter will personally review your profile and get in touch if there's a suitable next step.\n\nWe really appreciate your time.\n\n${db.company} Talent Team`);
    return finish(c.em, out);
  }

  // All good → move to avail stage, send Email 2
  c.em.stage = 'avail';
  const summaryParts = [
    parsed.currentLocation && `Current location: ${parsed.currentLocation}`,
    parsed.experience && `Experience: ${parsed.experience}`,
    parsed.noticePeriodRaw && `Notice period: ${parsed.noticePeriodRaw}`,
    c.em.answers.resume && c.em.answers.resume !== 'Not shared' && `Resume: ${c.em.answers.resume}`,
  ].filter(Boolean);
  const summaryBlock = summaryParts.length ? `\nQuick summary of what we've noted:\n${summaryParts.map(s => '  • ' + s).join('\n')}\n` : '';

  out.push(`Hi ${c.name}! 😊\n\nThank you for sharing your details — great to hear you're open to exploring this opportunity!\n${summaryBlock}\nWe'd like to take this forward. Please share your preferred day and time for a quick call with our recruiter.\n\nOur recruiters are available Mon–Fri, between 12 PM and 5 PM. For example: "Friday 3 pm".\n\nLooking forward to connecting!\n\n${db.company} Talent Team`);
  return finish(c.em, out);
}

// WhatsApp-first: if a candidate never replies on WhatsApp within 24h, automatically send the email outreach.
const FOLLOWUP_MS = 24 * 60 * 60 * 1000;
async function checkEmailFollowups() {
  if (!db.settings.emailFollowups) return;   // email channel paused — WhatsApp only (toggle in settings to re-enable)
  if (!mailerReady()) return;
  for (const c of db.candidates) {
    if (c.dnc) continue;
    if (c.wa.stage !== 'outreach' || c.em.stage !== 'new' || !c.email) continue;       // still at initial WA outreach, no email yet
    if (c.wa.transcript.some(m => m.from === 'candidate')) continue;                    // they DID reply on WhatsApp → leave it
    if (Date.now() - (c.wa.outreachSentAt || 0) < FOLLOWUP_MS) continue;                // not 24h yet
    try { if (await sendEmailOutreachTo(c)) log(`⏱️ No WhatsApp reply from ${c.name} in 24h → email follow-up sent.`); }
    catch (e) { log('Email follow-up failed for ' + c.name + ': ' + e.message); }
  }
}
if (!process.env.RF_TEST) { setInterval(() => checkEmailFollowups().catch(() => {}), 30 * 60 * 1000); setTimeout(() => checkEmailFollowups().catch(() => {}), 20000); }

/* ---------------- Follow-up nudges: 1st at 24h of silence, 2nd at 48h after the 1st reminder ---------------- */
const NUDGE_MS = 24 * 60 * 60 * 1000;   // base unit (24h)
const MAX_NUDGES = 2;                    // at most 2 gentle reminders, then leave them be
function nudgeText(c, n) {
  if (n >= 1) return `Hi ${c.name}, just checking in once more 😊 — if now isn't the right time, no problem at all. Whenever you're ready, simply reply here and we'll pick up where we left off.`;
  return `Hi ${c.name}! 👋 Just following up on my previous message — whenever you get a chance, I'd love to hear back from you. 😊`;
}
// Re-ping any candidate who hasn't replied to our last message for 1 day, on whichever channel that message went out.
async function checkNudges() {
  for (const c of db.candidates) {
    if (c.dnc) continue;
    for (const ch of [c.wa, c.em]) {
      if (!ch || ch.stage === 'new' || isTerminal(ch.stage)) continue;
      const t = ch.transcript || []; if (!t.length) continue;
      const last = t[t.length - 1];
      if (last.from !== 'system') continue;                                   // last word was ours; we're waiting on candidate
      if ((ch.nudgeCount || 0) >= MAX_NUDGES) continue;                       // already nudged the max times
      const gap = (ch.nudgeCount || 0) === 0 ? NUDGE_MS : 2 * NUDGE_MS;       // 1st nudge after 24h; 2nd after 48h from the 1st
      if (Date.now() - new Date(last.ts).getTime() < gap) continue;
      const isWA = (ch === c.wa);
      const text = nudgeText(c, ch.nudgeCount || 0);
      try {
        if (isWA) {
          if (waStatus !== 'ready') continue;
          await waSend(c.wa.chatId || (normPhone(c.phone) + '@c.us'), text);
        } else {
          if (!mailerReady() || !c.email) continue;
          await sendEmail(c.email, emailSubject(c), stripMd(text));
        }
        ch.nudgeCount = (ch.nudgeCount || 0) + 1; ch.lastNudgeAt = Date.now();
        ch.transcript.push({ from: 'system', text, ts: now() });
        save();
        log(`🔔 1-day follow-up sent to ${c.name} (${isWA ? 'WhatsApp' : 'Email'}) [reminder #${ch.nudgeCount}]`);
      } catch (e) { log(`Nudge failed for ${c.name}: ${e.message}`); }
    }
  }
}
if (!process.env.RF_TEST) { setInterval(() => checkNudges().catch(() => {}), 60 * 60 * 1000); setTimeout(() => checkNudges().catch(() => {}), 60000); }
// Day-of reminder — fires once, on the morning of the scheduled call, to both the candidate and the recruiter.
async function checkDayOfReminders() {
  if (waStatus !== 'ready') return;
  const today = new Date().toDateString();
  for (const c of db.candidates) {
    const ch = c.wa;
    if (!ch || ch.stage !== 'scheduled' || ch.answers.reminderSent) continue;
    const startISO = ch.answers.scheduledStartISO; if (!startISO) continue;
    if (new Date(startISO).toDateString() !== today) continue;
    const j = jobOf(c);
    const timeLabel = new Date(startISO).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });
    try {
      if (!c.dnc) {
        await waSend(ch.chatId || (normPhone(c.phone) + '@c.us'), `Hi ${c.name}! 👋 Just a friendly reminder — your call with the *${db.company}* recruiter is *today at ${timeLabel}*. Please keep your phone handy, and all the best! 😊📞`);
      }
      await waSendRecruiter(`🔔 Reminder: call with *${c.name}* (${j ? j.title : ''}) today at *${timeLabel}*.\n📱 ${c.phone}`);
      ch.answers.reminderSent = true;
      save();
      log(`🔔 Day-of reminder sent for ${c.name}'s ${timeLabel} call.`);
    } catch (e) { log(`Day-of reminder failed for ${c.name}: ${e.message}`); }
  }
}
if (!process.env.RF_TEST) { setInterval(() => checkDayOfReminders().catch(() => {}), 30 * 60 * 1000); setTimeout(() => checkDayOfReminders().catch(() => {}), 90000); }

/* ---------------- Recruiter-side conversation (bot ↔ recruiter over their own WhatsApp) ---------------- */
const recruiterSentIds = new Set();   // ids of nudges the bot sent to the recruiter's self-chat (so we don't read them back)
async function waSendRecruiter(text) {
  const to = recruiterWaId(); if (!to) return;
  try {
    const pm = await waSend(to, text);
    const id = pm && pm.id && pm.id._serialized; if (id) recruiterSentIds.add(id);
    // Learn the recruiter's ACTUAL chat id from our own sent message (WhatsApp may use an @lid form, not <num>@c.us).
    const remote = pm && pm.id && pm.id.remote; if (remote) db._recruiterChatId = remote;
  }
  catch (e) { log('Recruiter WA send failed: ' + e.message); }
}
// A recruiter reply is a short, single-line message (yes / no / "Tue afternoon") — not one of our long nudges.
function looksLikeRecruiterReply(text) { return text && text.length <= 60 && !/\n/.test(text) && !/📅|🔔|👋 Did your call/.test(text); }
// 1 hour after a scheduled call ends, ask the recruiter (on WhatsApp) whether it actually happened.
async function checkPostCall() {
  if (waStatus !== 'ready' || db.recruiterPending) return;   // one recruiter question at a time
  for (const c of db.candidates) {
    const ch = c.wa; if (!ch || ch.stage !== 'scheduled' || ch.answers.followupAsked) continue;
    const endISO = ch.answers.scheduledEndISO || ch.answers.scheduledStartISO; if (!endISO) continue;
    if (Date.now() < new Date(endISO).getTime() + 60 * 60000) continue;   // wait until 1hr after the call
    ch.answers.followupAsked = true; db.recruiterPending = { type: 'call_done', candId: c.id, askedAt: Date.now() }; save();
    await waSendRecruiter(`👋 Did your call with *${c.name}* (${(jobOf(c) || {}).title || ''}) happen? Reply *yes* or *no*.`);
    break;
  }
}
if (!process.env.RF_TEST) setInterval(() => { checkPostCall().catch(() => {}); }, 10 * 60 * 1000);
// Safety: never let an unanswered recruiter prompt block the queue or strand a candidate.
async function checkRecruiterTimeout() {
  const p = db.recruiterPending; if (!p) return;
  const age = Date.now() - (p.askedAt || 0);
  if (p.type === 'immediate_avail' && age > 10 * 60000) {
    // Recruiter didn't respond to the instant-call ping in 10 min → send the candidate to normal slots.
    const c = db.candidates.find(x => x.id === p.candId); db.recruiterPending = null; save();
    if (c && c.wa.stage === 'awaiting_recruiter_now') { c.wa.stage = 'availdate'; save(); try { await sendRepliesWA(c, [`Thanks for waiting! 🙂 Let's just pick a convenient slot for your call:` + bulletOptions('availdate', c, jobOf(c))]); } catch (e) {} }
  } else if (age > 12 * 3600000) { db.recruiterPending = null; save(); }   // stale >12h → unblock the queue
}
if (!process.env.RF_TEST) setInterval(() => { checkRecruiterTimeout().catch(() => {}); }, 2 * 60 * 1000);
// Recruiter's answer to whatever we last asked — drives the post-call + re-schedule flow.
async function handleRecruiterReply(text) {
  const p = db.recruiterPending; if (!p) return false;
  if (!looksLikeRecruiterReply(text)) return false;
  const c = db.candidates.find(x => x.id === p.candId);
  const yn = detectComfort(text);
  log(`👔 Recruiter replied "${text}" [${p.type}]`);
  if (p.type === 'immediate_avail') {
    db.recruiterPending = null;
    if (!c) { save(); return true; }
    if (yn === 'yes') {
      c.wa.stage = 'scheduled'; c.wa.answers.availability = 'Immediate — recruiter calling within 30 min'; c.wa.answers.scheduledRecruiter = recruiterName(c);
      c.wa.answers.scheduledStartISO = new Date().toISOString(); c.wa.answers.scheduledEndISO = new Date(Date.now() + CALL_MIN * 60000).toISOString(); c.wa.answers.followupAsked = false;
      c.wa.calendarDone = false; onScheduled(c, c.wa);   // block the next 30 min on the recruiter's calendar
      if (c.fromSheet) writeCandidateToSheet(c);
      save();
      await sendRepliesWA(c, [`🎉 Great news! Our recruiter will call you within the next *30 minutes*. Please keep your phone handy. 📞`]);
      await waSendRecruiter(`👍 Told ${c.name} you'll call within 30 min.`);
      return true;
    }
    if (yn === 'no') {
      c.wa.stage = 'availdate'; save();
      await sendRepliesWA(c, [`No worries at all! Our recruiter isn't free this very moment. Could you pick a slot for the call?` + bulletOptions('availdate', c, jobOf(c))]);
      await waSendRecruiter(`👍 No problem — asked ${c.name} to pick a slot instead.`);
      return true;
    }
    db.recruiterPending = { type: 'immediate_avail', candId: p.candId }; save();
    await waSendRecruiter(`Reply *yes* (you'll call now) or *no* (candidate picks a slot).`);
    return true;
  }
  if (p.type === 'call_done') {
    if (yn === 'yes') { if (c) { c.wa.answers.conversationDone = 'Yes'; if (c.fromSheet) writeCandidateToSheet(c); } db.recruiterPending = null; save(); await waSendRecruiter('Great — marked as *done* in the sheet. ✅'); return true; }
    if (yn === 'no') { db.recruiterPending = { type: 'recheck_offer', candId: p.candId }; save(); await waSendRecruiter(`No worries. Want me to check with *${c ? c.name : 'the candidate'}* for a new slot? Reply *yes* or *no*.`); return true; }
    await waSendRecruiter('Please reply *yes* or *no* — did the call happen?'); return true;
  }
  if (p.type === 'recheck_offer') {
    if (yn === 'yes') { db.recruiterPending = { type: 'recruiter_pref', candId: p.candId }; save(); await waSendRecruiter(`Any specific time you'd prefer for the new call? (e.g. "Tue afternoon" — or reply *any*)`); return true; }
    if (yn === 'no') { if (c) { c.wa.answers.conversationDone = 'No — not rescheduled'; if (c.fromSheet) writeCandidateToSheet(c); } db.recruiterPending = null; save(); await waSendRecruiter('Okay, closed for now. 👍'); return true; }
    await waSendRecruiter('Reply *yes* or *no* — should I re-check with the candidate?'); return true;
  }
  if (p.type === 'recruiter_pref') {
    const pref = /^(any|anytime|no ?pref|whenever)/i.test(text) ? '' : text.trim();
    db.recruiterPending = null; save();
    if (c) reopenScheduling(c, pref);
    await waSendRecruiter(`Done — I've asked *${c ? c.name : 'the candidate'}* to share availability${pref ? ` around *${pref}*` : ''}. I'll update you once they pick. 🙌`);
    return true;
  }
  return false;
}
// Re-open scheduling for a candidate (recruiter asked to reschedule); slots still align to the calendar.
function reopenScheduling(c, pref) {
  const ch = c.wa, j = jobOf(c);
  ch.answers.scheduledStartISO = null; ch.answers.scheduledEndISO = null; ch.answers.availability = null; ch.answers.reminderSent = false; ch.answers.followupAsked = false; ch.answers.recruiterPref = pref || '';
  ch.stage = 'availdate';
  const prompt = `Hi ${c.name}! 👋 We'd like to set up your call with our recruiter${pref ? ` — they'd prefer *${pref}*` : ''}. Which *date* works best for you?` + bulletOptions('availdate', c, j);
  ch.transcript.push({ from: 'system', text: prompt, ts: now() });
  sendRepliesWA(c, [prompt]).catch(() => {});
}
// Catch the recruiter's own typed messages in their self-chat (registered after the client is created — see below).
function registerRecruiterSelfChat() {
  client.on('message_create', async msg => {
    try {
      if (!msg.fromMe || waStatus !== 'ready') return;
      if (!db.recruiterPending) return;                 // only when we've asked the recruiter something
      const id = msg.id && msg.id._serialized; if (id && recruiterSentIds.has(id)) return;   // skip the bot's own nudges
      const chat = (msg.id && msg.id.remote) || msg.to || msg.from || '';
      // A fromMe message going to a CANDIDATE chat is the bot talking to them — not a recruiter reply.
      if (db.candidates.some(c => c.wa && c.wa.chatId === chat)) return;
      const text = (msg.body || '').trim(); if (!text || !looksLikeRecruiterReply(text)) return;
      // Otherwise it's the recruiter typing in their own chat while we're waiting on them.
      log(`👔 Recruiter reply (chat ${chat}): "${text}"`);
      await handleRecruiterReply(text);
    } catch (e) { log('recruiter self-chat error: ' + e.message); }
  });
}

let emailPolling = false;
// Automated / calendar / no-reply emails that must NEVER be treated as a candidate reply.
function isAutomatedEmail(parsed, fromAddr) {
  const from = (fromAddr || '').toLowerCase();
  const subj = (parsed.subject || '').toLowerCase();
  const body = (parsed.text || '').toLowerCase();
  if (/no-?reply|do-?not-?reply|notification|calendar-|mailer-daemon|postmaster|automated|googlemail|calendar@|invitations?@|notify@/.test(from)) return true;
  if (/\b(invitation|calendar|has been updated|accepted:|declined:|tentative:|event (updated|invitation|reminder)|google calendar|has invited you|is inviting you|@ \w+ \(|reminder:)\b/.test(subj)) return true;
  // Calendar-notification bodies (day, date, time-range, timezone) that aren't a real reply.
  if (/(mon|tue|wed|thu|fri|sat|sun)\w*\s+\w+\s+\d{1,2},?\s*\d{4}.*(am|pm).*(–|-|to).*(am|pm)/i.test(body) && /(standard time|gmt|utc|calendar|forwarded message|this event)/i.test(body)) return true;
  if (/this event has been (updated|cancelled|changed)|has been (updated|cancelled)|changed:\s*(time|date|location)/i.test(body)) return true;
  return false;
}
async function pollEmail() {
  if (!db.settings.emailFollowups) return;   // email channel paused (WhatsApp only) — don't read email replies either
  if (!mailerReady() || emailPolling) return;
  if (!db.candidates.some(c => c.em && c.em.stage !== 'new' && !isTerminal(c.em.stage))) return;
  emailPolling = true;
  const imap = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: db.settings.email, pass: db.settings.emailPass }, logger: false });
  imap.on('error', () => {});   // prevent unhandled-error crash on network drop
  try {
    await imap.connect(); emailStatus = 'ok';
    const lock = await imap.getMailboxLock('INBOX');
    try {
      const uids = await imap.search({ seen: false }, { uid: true });
      for (const uid of (uids || [])) {
        const m = await imap.fetchOne(uid, { source: true }, { uid: true });
        const parsed = await simpleParser(m.source);
        const from = ((parsed.from && parsed.from.value && parsed.from.value[0] && parsed.from.value[0].address) || '').toLowerCase();
        const c = db.candidates.find(x => x.em.stage !== 'new' && (x.email || '').toLowerCase() === from);
        await imap.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
        if (!c) continue;
        if (isAutomatedEmail(parsed, from)) { log(`📧 Ignored automated/calendar email for ${c.name}.`); continue; }   // never schedule off a calendar notification
        const body = topReply(parsed.text || '');
        if (!body) continue;
        log(`📧 ◀ ${c.name}: ${body.slice(0, 50)}`);
        if (c.dnc) { continue; }
        let replies;
        if (c.em.stage === 'details_form') {
          replies = await handleEmailFormReply(c, parsed);   // batch-parse the form reply
        } else {
          const useAI = aiReady() && !rulesUnderstand(c, c.em, body);
          replies = useAI ? await aiProcess(c, c.em, body) : handleIncoming(c, c.em, body);
        }
        for (const r of replies) await sendEmail(c.email, emailSubject(c), stripMd(r));
        if (replies && replies.length) log(`📧 ▶ Replied to ${c.name} → [${STAGE_LABEL[c.em.stage] || c.em.stage}]`);
        else log(`🤐 ${c.name} (email): not relevant — no reply sent.`);
      }
    } finally { lock.release(); }
  } catch (e) { emailStatus = 'error'; log('IMAP error: ' + e.message); }
  finally { try { await imap.logout(); } catch (e) {} emailPolling = false; }
}
if (!process.env.RF_TEST) setInterval(() => { pollEmail().catch(() => {}); }, 20000);

/* ---------------- WhatsApp client ---------------- */
let waStatus = 'starting', qrDataUrl = null, waInfo = null;

// Reuse a Chrome/Chromium already on the machine so first run doesn't have to download one
// (huge first-run speedup). Falls back to the bundled Chromium if none is found.
function findSystemChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe' : null,
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser', '/usr/bin/chromium',
  ].filter(Boolean);
  for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch (e) {} }
  return null;
}
const CHROME_EXE = findSystemChrome();
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
  // Pin + cache the WhatsApp Web build so startup doesn't re-fetch it every launch (faster + more stable).
  webVersionCache: { type: 'local', path: path.join(__dirname, '.wwebjs_cache') },
  puppeteer: {
    headless: true,
    ...(CHROME_EXE ? { executablePath: CHROME_EXE } : {}),
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      // Trim cold-boot time: skip GPU, extensions, background network chatter, first-run UI.
      '--disable-gpu', '--disable-extensions', '--disable-background-networking',
      '--disable-default-apps', '--disable-sync', '--no-first-run', '--no-default-browser-check',
      '--disable-features=TranslateUI', '--mute-audio'
    ]
  }
});
// These Puppeteer-level errors mean the underlying Chrome page/frame has died — whatsapp-web.js
// doesn't fire 'disconnected' for this, and waStatus stays stuck at "ready" forever, so every send
// silently (or visibly) fails until someone notices and restarts by hand. Catch it ourselves instead.
function isFatalWaError(e) { return /detached Frame|Execution context was destroyed|Session closed|Protocol error|Target closed/i.test((e && e.message) || ''); }
function onFatalWaError(e) { log(`⚠️ Fatal WhatsApp session error (${e.message}) — restarting connection.`); waStatus = 'error'; recoverWhatsApp(); }
async function waSend(...args) { try { return await client.sendMessage(...args); } catch (e) { if (isFatalWaError(e)) onFatalWaError(e); throw e; } }
async function waIsRegistered(jid) { try { return await client.isRegisteredUser(jid); } catch (e) { if (isFatalWaError(e)) onFatalWaError(e); throw e; } }
client.on('qr', async qr => { clearWatchdog(); waStatus = 'qr'; qrDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 1 }); log('QR generated — scan it from the dashboard.'); });
client.on('authenticated', () => { waStatus = 'authenticated'; });
client.on('auth_failure', m => { clearWatchdog(); waStatus = 'auth_failure'; log('Auth failure: ' + m); });
client.on('ready', () => { clearWatchdog(); waStatus = 'ready'; qrDataUrl = null; waInfo = client.info ? client.info.wid.user : null; log('WhatsApp READY. Connected as +' + (waInfo || '?')); setTimeout(() => catchUpWhatsApp(), 4000); });
registerRecruiterSelfChat();
client.on('disconnected', r => {
  waStatus = 'disconnected'; log('Disconnected: ' + r + ' — attempting to reconnect.');
  // A LOGOUT / CONFLICT means the saved session is dead — reusing it just loops QR codes forever.
  // Mark it for a wipe on the next startup (after Chrome locks are released), so the restart links clean.
  if (/logout|conflict|unpaired/i.test(String(r))) { try { fs.writeFileSync(RESET_MARKER, String(r)); } catch (e) {} log('  → session invalid; will reset and show a fresh QR on restart.'); }
  recoverWhatsApp();
});
// Safety net: sweep for any missed messages every 2 minutes, independent of reconnect events —
// closes the gap for brief hiccups that don't trigger a full disconnect/reconnect cycle.
if (!process.env.RF_TEST) setInterval(() => { if (waStatus === 'ready') catchUpWhatsApp().catch(() => {}); }, 2 * 60 * 1000);

// Health check: catches the "zombie" state where waStatus says 'ready' but the underlying page is
// dead so sends silently do nothing (never throwing) — the watchdog misses it because status looks ok.
// Every 60s, if we think we're ready, confirm the client truly reports CONNECTED; if not, recover.
async function healthCheck() {
  if (waStatus !== 'ready' || recovering) return;
  let state = null;
  try { state = await Promise.race([client.getState(), new Promise((_, r) => setTimeout(() => r(new Error('getState timeout')), 15000))]); }
  catch (e) { log(`🩺 Health check failed (${e.message}) — connection looks dead, recovering.`); return recoverWhatsApp(); }
  if (state !== 'CONNECTED') { log(`🩺 Health check: state="${state}" (not CONNECTED) — recovering.`); return recoverWhatsApp(); }
}
if (!process.env.RF_TEST) setInterval(() => { healthCheck().catch(() => {}); }, 60 * 1000);

// Auto-pilot: every 10 min, sync the sheet, then reach out to any freshly-imported candidate — all within
// working hours (9 AM–8 PM per the flow doc). Data lands in both RecruitFlow (data.json) and the sheet.
if (db.settings.autoSync === undefined) db.settings.autoSync = true;
let _autoRunning = false;
async function autoSyncAndRun() {
  if (_autoRunning || !db.settings.autoSync || waStatus !== 'ready') return;
  if (!db.settings.recruiterName && !db.settings.recruiterEmail) return;   // not logged in yet — nothing to attribute
  _autoRunning = true;
  try {
    const res = await syncFromSheet();               // pull Strong (auto role+city, 90-day skip) → data.json + sheet idx — runs anytime
    if (res.added) log(`🤖 Auto-sync: ${res.added} new candidate(s) imported.`);
    const hr = new Date().getHours();
    if (hr < 9 || hr >= 20) { save(); return; }      // outreach only initiates 9 AM–8 PM; candidate replies handled anytime
    for (const c of db.candidates) {
      if (!c.fromSheet || c.dnc || c.wa.stage !== 'new') continue;
      try { await sendWhatsAppOutreachTo(c, jobOf(c), loadJDMedia(jobOf(c))); await new Promise(r => setTimeout(r, 1500)); }
      catch (e) { log(`🤖 Auto-outreach skipped ${c.name}: ${e.message}`); }
    }
    save();
  } catch (e) { log('🤖 Auto-sync error: ' + e.message); }
  finally { _autoRunning = false; }
}
if (!process.env.RF_TEST) { setInterval(() => { autoSyncAndRun().catch(() => {}); }, 60 * 1000); setTimeout(() => { autoSyncAndRun().catch(() => {}); }, 30000); }

/* --- Self-healing: guarantee a clean Chrome on every start, auto-recover if the client hangs --- */
const { execSync } = require('child_process');
// Kill any leftover headless Chrome from a previous run (only this app uses "Chrome for Testing").
function killStaleChrome() { try { execSync('pkill -9 -f "Chrome for Testing"', { stdio: 'ignore' }); } catch (e) {} }
function clearChromeLocks() {
  try {
    const base = path.join(__dirname, '.wwebjs_auth');
    if (!fs.existsSync(base)) return;
    const walk = dir => { for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); let st; try { st = fs.lstatSync(p); } catch (e) { continue; } if (st.isDirectory()) walk(p); else if (/^Singleton/.test(f)) { try { fs.unlinkSync(p); } catch (e) {} } } };
    walk(base);
  } catch (e) {}
}
// Marker file: when present at startup, the saved WhatsApp session is wiped for a clean re-link.
const RESET_MARKER = path.join(__dirname, '.reset_session');
function clearAuthSession() {
  for (const d of ['.wwebjs_auth', '.wwebjs_cache']) { try { fs.rmSync(path.join(__dirname, d), { recursive: true, force: true }); } catch (e) {} }
}
// Run a guaranteed-clean WhatsApp startup: clear any leftover Chrome + locks, then initialize.
function startWhatsApp() {
  killStaleChrome(); clearChromeLocks();
  // If a prior LOGOUT flagged the session for reset, wipe it now (Chrome is dead → files unlocked).
  if (fs.existsSync(RESET_MARKER)) { clearAuthSession(); try { fs.unlinkSync(RESET_MARKER); } catch (e) {} log('🧹 Cleared the logged-out WhatsApp session — scan the fresh QR to reconnect.'); }
  log('Starting WhatsApp client…' + (CHROME_EXE ? ' (using your installed Chrome — fast start)' : ' (using bundled Chromium)')); client.initialize(); armWatchdog();
}
let waWatchdog = null, recovering = false;
function clearWatchdog() { if (waWatchdog) { clearTimeout(waWatchdog); waWatchdog = null; } }
function armWatchdog() {
  clearWatchdog();
  const startedAt = Date.now();
  // Give it room to connect. 'authenticated' means it's syncing chats (can take minutes on a busy personal
  // number) — don't kill it mid-sync or it loops forever. Allow up to 6 min authenticated; only then recover.
  const tick = () => {
    if (waStatus === 'ready' || waStatus === 'qr') return;
    if (waStatus === 'authenticated' && Date.now() - startedAt < 6 * 60000) { waWatchdog = setTimeout(tick, 30000); return; }
    recoverWhatsApp();
  };
  waWatchdog = setTimeout(tick, 4 * 60000);
}
async function recoverWhatsApp() {
  if (recovering) return; recovering = true;
  log(`⚠️ WhatsApp stuck/dropped at "${waStatus}" — auto-recovering…`);
  // Under launchd (auto-start), a full process restart is the most reliable reset — startup then
  // kills stale Chrome and begins clean. KeepAlive brings us back within ~10s.
  if (process.env.RF_MANAGED) { log('  → restarting process for a clean slate.'); try { await client.destroy(); } catch (e) {} killStaleChrome(); process.exit(1); }
  // Manual run (no launchd): recover in-process.
  try { await client.destroy(); } catch (e) {}
  killStaleChrome(); clearChromeLocks();
  try { waStatus = 'starting'; await client.initialize(); armWatchdog(); }
  catch (e) { log('Recovery failed: ' + e.message); }
  finally { recovering = false; }
}

async function resolveNumber(msg) {
  let num = '';
  try {
    const ct = await msg.getContact();
    if (ct && ct.id && ct.id.server === 'c.us' && ct.id.user) num = ct.id.user.replace(/\D/g, '');   // real phone number
    else if (ct && ct.number) num = ct.number.replace(/\D/g, '');
    else if (ct && ct.id && ct.id.user) num = ct.id.user.replace(/\D/g, '');
  } catch (e) {}
  if (!num) num = (msg.from.split('@')[0] || '').replace(/\D/g, '');
  return num;
}
/* ---------------- WhatsApp polls (hybrid: tappable options for choice questions) ---------------- */
// Which stages are sent as a tappable poll (rest stay as open text). Returns {name, options} or null.
function pollForStage(stage, c, j) {
  switch (stage) {
    case 'outreach':   return { name: `Are you open to exploring this ${j ? j.title : ''} opportunity? 😊`, options: ['Yes, tell me more 👍', 'Not right now'] };
    case 'opentocity': return { name: `Are you open to ${j ? j.location : 'the job location'}?`, options: ['Yes', 'No'] };
    case 'availnow':   return { name: `Are you available for a quick call right now?`, options: ['Yes, I\'m free now', 'No, let\'s schedule'] };
    case 'notice':     return { name: 'What is your notice period?', options: ['Immediate', '15 days', '30 days', '60 days', '90+ days', 'Currently serving notice'] };
    case 'avail':
    case 'availdate':  return { name: 'Which date works best for a quick call? 📅', options: availDateOptions().map(o => o.label) };
    case 'availtime':  return { name: 'And which time slot suits you? 🕘', options: daySlots(new Date((c.wa && c.wa.answers && c.wa.answers._dateISO) || Date.now())).map(s => s.label) };
    default: return null;
  }
}
// Translate a chosen poll option back into text the conversation engine understands.
function voteToAnswer(stage, optionName) {
  const o = optionName || '';
  if (stage === 'outreach' || stage === 'opentocity' || stage === 'availnow') return /^yes/i.test(o) ? 'yes' : 'no';
  if (stage === 'notice') {
    if (/serving/i.test(o)) return 'serving notice';
    return ({ 'Immediate': 'immediate', '15 days': '15 days', '30 days': '30 days', '60 days': '60 days', '90+ days': '90 days' })[o] || o;
  }
  return o;
}
// Send the engine's replies to a candidate on WhatsApp — as a poll when the new stage is poll-able, else as text.
async function sendRepliesWA(c, replies) {
  const ch = c.wa, j = jobOf(c), to = ch.chatId || (normPhone(c.phone) + '@c.us');
  // A pending sub-state (e.g. "what's your last working day?") always expects free text, even if the
  // underlying stage itself is normally poll-driven — don't re-fire that stage's poll while one is open.
  // Text-only: questions carry their choices as a numbered list in the prompt text (no WhatsApp polls,
  // which are unreliable on some accounts). Candidate replies with the number or the answer — both work.
  for (const r of (replies || [])) {
    try { await waSend(to, r); } catch (e) { log('WA send failed: ' + e.message); }
    await new Promise(r => setTimeout(r, 600));
  }
}

// Guards against processing the exact same WhatsApp message twice for the same candidate record —
// keyed `${candidateId}|${msgId}` (not just msgId) so legitimate reprocessing under a *different*
// candidate record — e.g. after a routing fix picks the right one — still goes through.
const processedWaMsgKeys = new Set();
// When a message can't be understood, don't fire off "I couldn't understand" right away — a candidate
// often follows up seconds/minutes later with something clearer, and replying to every unclear message
// in between just spams them. Hold it briefly; a clearer message supersedes it, otherwise send the
// clarify reply once the wait elapses with nothing better having arrived.
const CLARIFY_WAIT_MS = 5 * 60 * 1000;
const clarifyHold = new Map();   // candidate id -> { timer }
// Catch up on messages that arrived while this laptop/app was off (runs when WhatsApp becomes ready).
async function catchUpWhatsApp() {
  try {
    for (const c of db.candidates) {
      if (c.wa.stage === 'new' || isTerminal(c.wa.stage) || !c.wa.chatId) continue;
      let chat; try { chat = await client.getChatById(c.wa.chatId); } catch (e) { continue; }
      let msgs; try { msgs = await chat.fetchMessages({ limit: 15 }); } catch (e) { continue; }
      const lastTs = c.wa.lastProcessedTs || 0;
      const pending = msgs.filter(m => !m.fromMe && (m.timestamp * 1000) > lastTs).sort((a, b) => a.timestamp - b.timestamp);
      for (const m of pending) {
        if (!m.body) continue;
        const msgId = m.id && m.id._serialized;
        if (msgId) { const key = c.id + '|' + msgId; if (processedWaMsgKeys.has(key)) { c.wa.lastProcessedTs = m.timestamp * 1000; continue; } processedWaMsgKeys.add(key); }
        log(`⏳ Catch-up — ${c.name}: ${m.body.slice(0, 40)}`);
        if (c.dnc) { c.wa.lastProcessedTs = m.timestamp * 1000; continue; }
        const useAI = aiReady() && !rulesUnderstand(c, c.wa, m.body);
        const replies = useAI ? await aiProcess(c, c.wa, m.body) : handleIncoming(c, c.wa, m.body);
        await sendRepliesWA(c, replies);
        c.wa.lastProcessedTs = m.timestamp * 1000;
      }
      save();
    }
  } catch (e) { log('Catch-up error: ' + e.message); }
}
const tsLast = c => { const t = c.wa.transcript; return t.length ? Date.parse(t[t.length - 1].ts) || 0 : 0; };
// Same phone number can match multiple candidate records (e.g. contacted again for a different job).
// Prefer whichever is most recently active — a freshly-contacted new job should win over an older conversation.
function findCandidateByPhone(num) {
  const active = db.candidates.filter(x => x.wa.stage !== 'new' && !isTerminal(x.wa.stage) && last10(x.phone) === num.slice(-10));
  if (active.length) return active.reduce((best, c) => (tsLast(c) > tsLast(best) ? c : best));
  const any = db.candidates.filter(x => x.wa.stage !== 'new' && last10(x.phone) === num.slice(-10));
  if (any.length) return any.reduce((best, c) => (tsLast(c) > tsLast(best) ? c : best));
  return null;
}
client.on('message', async msg => {
  try {
    if (msg.from.endsWith('@g.us') || msg.from === 'status@broadcast' || msg.isStatus || msg.fromMe) return;
    // A voice/video call (or WhatsApp's own system notices) can surface as a "message" with no real
    // content — don't let those fall through to the conversation engine and trigger a nonsense reply.
    if (['call_log', 'e2e_notification', 'notification_template', 'gp2', 'group_notification', 'broadcast_notification'].includes(msg.type)) return;
    if (!msg.body && !msg.hasMedia) return;
    const num = await resolveNumber(msg);
    // If the recruiter uses a SEPARATE number (not the linked device), route their reply to the recruiter flow.
    if (db.recruiterPending && db.settings.recruiterPhone && last10(db.settings.recruiterPhone) !== last10(waInfo || '') && last10(num) === last10(db.settings.recruiterPhone)) {
      if (await handleRecruiterReply((msg.body || '').trim())) return;
    }
    // Diagnostics: show exactly what WhatsApp exposes about the sender.
    const diag = { from: msg.from };
    try { const ct = await msg.getContact(); diag.id = ct && ct.id && ct.id._serialized; diag.number = ct && ct.number; diag.name = ct && (ct.pushname || ct.name); } catch (e) { diag.err = e.message; }
    log('DIAG ' + JSON.stringify(diag) + ' resolved=' + num);

    // STRICT matching: only reply to a candidate we actually sent outreach to (by their real number,
    // or a chat already pinned to them). Anyone else messaging this number is ignored — no auto-reply.
    // If the same phone number matches multiple candidates (e.g. re-added for a second job), prefer
    // the ACTIVE one over a closed/terminal one — otherwise a live conversation's replies get silently
    // swallowed by an old finished conversation's "not relevant" filter.
    let how = 'number';
    let c = findCandidateByPhone(num);
    if (!c) { c = db.candidates.find(x => x.wa.stage !== 'new' && x.wa.chatId === msg.from); how = 'pinned-chat'; }
    if (!c) { log(`◀ Incoming from +${num} — not a contacted candidate, ignored (no auto-reply).`); return; }
    if (c.dnc) { log(`◀ ${c.name} opted out (do-not-contact) — ignored.`); return; }
    // Guard against processing the exact same WhatsApp message twice for this candidate (e.g. a race
    // with the periodic catch-up sweep) — that's what causes several question prompts to fire in a burst.
    const msgId = msg.id && msg.id._serialized;
    if (msgId) { const key = c.id + '|' + msgId; if (processedWaMsgKeys.has(key)) return; processedWaMsgKeys.add(key); }
    c.wa.chatId = msg.from;                        // pin this chat to the candidate for all future messages
    c.wa.lastProcessedTs = (msg.timestamp ? msg.timestamp * 1000 : Date.now());
    save();
    log(`◀ ${c.name} [match:${how}] +${num}: ${msg.body.slice(0, 60)}`);
    c.wa.activePoll = null;   // they replied with text; any open poll is superseded
    // Resume stage expects an actual PDF/Word file, not a link — handle a real attachment here.
    if (msg.hasMedia && (c.wa.stage === 'resume' || c.wa.pending === 'resume_file')) {
      try {
        const media = await msg.downloadMedia();
        const mt = (media && media.mimetype) || '';
        if (media && /pdf|msword|officedocument\.wordprocessingml/i.test(mt)) {
          const ext = /pdf/i.test(mt) ? '.pdf' : (/officedocument/i.test(mt) ? '.docx' : '.doc');
          const fname = `resume_${c.id}_${Date.now()}${ext}`;
          fs.writeFileSync(path.join(UP_DIR, fname), Buffer.from(media.data, 'base64'));
          c.wa.answers.resume = `Attached: ${media.filename || fname}`;
          c.wa.answers.resumeFile = fname;
          c.wa.pending = null;
          const out = [];
          proceedAfterScreening(c, c.wa, out);
          finish(c.wa, out);
          await sendRepliesWA(c, out);
          log(`▶ ${c.name} shared resume (${fname}) → now [${STAGE_LABEL[c.wa.stage] || c.wa.stage}]`);
        } else {
          await waSend(msg.from, "Hmm, that doesn't look like a PDF or Word file 🙂 Could you please resend your resume as a PDF or DOCX?");
        }
      } catch (e) { log('Resume attachment handling failed for ' + c.name + ': ' + e.message); }
      return;
    }
    // A clear message arrived — if we were holding an earlier unclear one for this candidate, it's
    // superseded; drop it without ever sending its "couldn't understand" reply.
    const held = clarifyHold.get(c.id);
    if (held) { clearTimeout(held.timer); clarifyHold.delete(c.id); }
    const understood = rulesUnderstand(c, c.wa, msg.body);
    if (!understood && !aiReady()) {
      // Without AI, an unclear message would just get a generic "I couldn't understand" — wait a bit
      // first in case a clearer follow-up is coming, instead of firing that off immediately. Still log
      // it to the transcript now so it's visible on the dashboard even while we hold off on replying.
      c.wa.transcript.push({ from: 'candidate', text: msg.body, ts: now() });
      save();
      const timer = setTimeout(async () => {
        clarifyHold.delete(c.id);
        try {
          const replies2 = handleIncoming(c, c.wa, msg.body, true);   // skipPush: already logged above
          await sendRepliesWA(c, replies2);
          if (replies2 && replies2.length) log(`▶ Replied to ${c.name} → now [${STAGE_LABEL[c.wa.stage] || c.wa.stage}]`);
        } catch (e) { log('Delayed clarify error for ' + c.name + ': ' + e.message); }
      }, CLARIFY_WAIT_MS);
      clarifyHold.set(c.id, { timer });
      log(`⏸️ ${c.name}: message unclear — holding ${CLARIFY_WAIT_MS / 60000}min for a clearer follow-up before replying.`);
      return;
    }
    const useAI = aiReady() && !understood;   // rules first; AI only when rules can't parse
    c.wa.lastReplyAt = now();
    const replies = useAI ? await aiProcess(c, c.wa, msg.body) : handleIncoming(c, c.wa, msg.body);
    await sendRepliesWA(c, replies);
    if (replies && replies.length) { c.wa.lastMsgSentAt = now(); log(`▶ Replied to ${c.name} → now [${STAGE_LABEL[c.wa.stage] || c.wa.stage}]`); }
    else log(`🤐 ${c.name}: message not relevant to recruitment — no reply sent.`);
    if (c.fromSheet) writeCandidateToSheet(c);   // push answers back to the Google Sheet
  } catch (e) { log('handler error: ' + e.message); }
});

// Candidate tapped a poll option → translate it to an answer and drive the flow.
client.on('vote_update', async (vote) => {
  try {
    const sel = (vote && vote.selectedOptions) || [];
    if (!sel.length) return;                                  // vote was removed/cleared
    const pm = vote.parentMessage || {};
    const pmId = (pm.id && (pm.id._serialized || pm.id.id)) || null;
    const chatId = (pm.id && pm.id.remote) || pm.to || pm.from || (pm.from);
    const voterNum = ((vote.voter || '').split('@')[0] || '').replace(/\D/g, '');
    // Diagnostics so we can see exactly what WhatsApp sends.
    log(`🗳️ vote_update: opt="${sel.map(s => s.name).join(',')}" voter=${vote.voter || '?'} pmId=${pmId || '?'} chat=${chatId || '?'}`);
    // Primary match: the exact poll message we sent. Fallbacks: pinned chat, then number.
    let c = pmId ? db.candidates.find(x => x.wa.activePollMsgId && x.wa.activePollMsgId === pmId) : null;
    if (!c && chatId) c = db.candidates.find(x => x.wa.stage !== 'new' && x.wa.chatId === chatId);
    if (!c && voterNum) c = findCandidateByPhone(voterNum);
    if (!c) { log(`🗳️ Poll vote unmatched — ignored.`); return; }
    if (!c.wa.activePoll) { log(`🗳️ ${c.name}: no active poll, ignoring stale vote.`); return; }
    const answer = voteToAnswer(c.wa.activePoll, sel[0].name);
    log(`🗳️ ${c.name} voted "${sel[0].name}" → "${answer}" [${c.wa.activePoll}]`);
    c.wa.activePoll = null; c.wa.activePollMsgId = null;
    const replies = handleIncoming(c, c.wa, answer);
    await sendRepliesWA(c, replies);
    log(`▶ Replied to ${c.name} → now [${STAGE_LABEL[c.wa.stage] || c.wa.stage}]`);
  } catch (e) { log('vote handler error: ' + e.message); }
});
if (!process.env.RF_TEST) startWhatsApp();
module.exports = { detectInterest, detectComfort, detectExperience, detectRole, detectSlot, detectDay, handleIncoming, autoMatchAwaitingCandidates, locationMatches, mkCand, syncFromSheet, writeCandidateToSheet, updateSummaryTab, readSheetTab, handleRecruiterReply, reopenScheduling, db };

/* ---------------- Send outreach (RUN) ---------------- */
// Send WhatsApp outreach to ONE candidate. Throws on failure. media is optional (loaded once by the caller).
// Candidate ids with an outreach send in flight — guards against a double-click / double API call
// racing through the stage check before the first send flips the stage (which sent the text twice).
const sendingOutreach = new Set();
async function sendWhatsAppOutreachTo(c, j, media) {
  if (c.dnc) throw new Error('candidate opted out (do-not-contact)');
  if (c.wa.stage !== 'new') throw new Error('already contacted on WhatsApp');
  if (sendingOutreach.has(c.id)) throw new Error('outreach already in progress');
  sendingOutreach.add(c.id);                              // synchronous lock — no await before this
  // Flip the stage immediately too, so any concurrent caller fails the stage check above right away.
  c.wa.stage = 'outreach'; c.wa.outreachSentAt = Date.now();
  try {
    const text = outreachText(c, j), jid2 = normPhone(c.phone) + '@c.us';
    const ok = await waIsRegistered(jid2);
    if (!ok) { c.wa.stage = 'new'; throw new Error('not on WhatsApp'); }   // roll back so it can be retried
    await waSend(jid2, text);
    if (media) { await new Promise(r => setTimeout(r, 600)); await waSend(jid2, media, { caption: `📄 ${j.title} — Job Description`, sendMediaAsDocument: true }); }
    c.wa.transcript.push({ from: 'system', text, ts: now() });
    if (media) c.wa.transcript.push({ from: 'system', text: `📄 [Sent JD attachment: ${j.jdFileName || j.jdFile}]`, ts: now() });
    // No poll — the interest question + numbered options are already in the outreach text. Just pin the
    // chat and mark "now" processed so the catch-up sweep never replays this number's OLDER chat history.
    c.wa.chatId = c.wa.chatId || jid2;
    c.wa.lastProcessedTs = Date.now();
    c.wa.lastMsgSentAt = now();
    if (c.fromSheet) writeCandidateToSheet(c);   // mark "contacted" + status in the sheet
    log(`  ✓ Sent to ${c.name} (+${normPhone(c.phone)})`);
  } finally {
    sendingOutreach.delete(c.id);
  }
}
function loadJDMedia(j) { if (j && j.jdFile) { try { return MessageMedia.fromFilePath(path.join(UP_DIR, j.jdFile)); } catch (e) { log('JD file load failed: ' + e.message); } } return null; }

async function runJob(jid) {
  if (waStatus !== 'ready') throw new Error('WhatsApp is not connected yet. Scan the QR first.');
  const j = db.jobs.find(x => x.id === jid);
  const list = candsOf(jid); let sent = 0; const failed = [];
  const fresh = list.filter(c => c.wa.stage === 'new');
  log(`▶ RUN WhatsApp for "${j ? j.title : jid}": ${fresh.length} new candidate(s) of ${list.length} total.`);
  if (!fresh.length) log('  (Everyone here has already been contacted on WhatsApp — nothing to send.)');
  const media = loadJDMedia(j);
  for (const c of list) {
    if (c.wa.stage !== 'new') continue;
    try { await sendWhatsAppOutreachTo(c, j, media); sent++; await new Promise(r => setTimeout(r, 1200)); }
    catch (e) { failed.push(c.name + ' (' + e.message + ')'); log(`  ✗ ${c.name} — ${e.message}`); }
  }
  save();
  log(`▶ RUN done: ${sent} sent, ${failed.length} skipped.`);
  return { sent, failed };
}
// Run WhatsApp outreach for a SINGLE candidate.
async function runJobOne(candId) {
  if (waStatus !== 'ready') throw new Error('WhatsApp is not connected yet. Scan the QR first.');
  const c = db.candidates.find(x => x.id === candId);
  if (!c) throw new Error('Candidate not found.');
  const j = jobOf(c);
  await sendWhatsAppOutreachTo(c, j, loadJDMedia(j));
  save();
  return { sent: 1, name: c.name };
}

/* ---------------- REST API + dashboard ---------------- */
const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(__dirname));

app.get('/api/status', (req, res) => res.json({ waStatus, qr: qrDataUrl, connectedAs: waInfo, logs: logs.slice(-40), emailStatus, emailReady: mailerReady(), emailUser: db.settings.email || null, calendarMode: calendarConnected() ? 'google' : 'invite', calendarConnected: calendarConnected(), aiOn: aiReady(), recruiter: { name: db.settings.recruiterName || '', phone: db.settings.recruiterPhone || '', email: db.settings.recruiterEmail || '', loggedIn: !!(db.settings.recruiterName && db.settings.recruiterEmail) } }));
app.get('/api/state', (req, res) => res.json(db));

// ----- Settings (email + Google credentials). Secrets are write-only; never returned. -----
app.get('/api/settings', (req, res) => res.json({ email: db.settings.email || '', emailPassSet: !!db.settings.emailPass, googleClientId: db.settings.googleClientId || '', googleClientSecretSet: !!db.settings.googleClientSecret, calendarConnected: calendarConnected(), redirectUri: OAUTH_REDIRECT, anthropicKeySet: !!db.settings.anthropicKey, aiEnabled: !!db.settings.aiEnabled, aiModel: aiModel() }));
app.post('/api/settings', (req, res) => {
  const b = req.body;
  if (b.email !== undefined) db.settings.email = (b.email || '').trim();
  if (b.emailPass) db.settings.emailPass = b.emailPass.replace(/\s+/g, '');   // Gmail app passwords are shown with spaces
  if (b.googleClientId !== undefined) db.settings.googleClientId = (b.googleClientId || '').trim();
  if (b.googleClientSecret) db.settings.googleClientSecret = b.googleClientSecret.trim();
  if (b.clearGoogleToken) db.settings.googleToken = null;
  if (b.clearGoogleCreds) { db.settings.googleClientId = ''; db.settings.googleClientSecret = ''; db.settings.googleToken = null; }
  if (b.anthropicKey) db.settings.anthropicKey = b.anthropicKey.trim();
  if (b.clearAnthropicKey) { db.settings.anthropicKey = ''; db.settings.aiEnabled = false; }
  if (b.aiEnabled !== undefined) db.settings.aiEnabled = !!b.aiEnabled;
  if (b.autoSync !== undefined) db.settings.autoSync = !!b.autoSync;
  if (b.sheetId !== undefined) db.settings.sheetId = (b.sheetId || '').trim();
  if (b.recruiterName !== undefined) db.settings.recruiterName = (b.recruiterName || '').trim();
  if (b.recruiterPhone !== undefined) db.settings.recruiterPhone = fmtPhone(b.recruiterPhone);
  if (b.recruiterEmail !== undefined) db.settings.recruiterEmail = (b.recruiterEmail || '').trim();
  if (b.aiModel !== undefined) db.settings.aiModel = (b.aiModel || '').trim() || 'claude-opus-4-8';
  save(); res.json({ ok: true });
});
app.post('/api/email/test', async (req, res) => { try { if (!mailerReady()) throw new Error('Add email + app password first.'); await sendEmail(db.settings.email, 'RecruitFlow test ✅', 'Your RecruitFlow email is configured correctly.'); emailStatus = 'ok'; res.json({ ok: true }); } catch (e) { emailStatus = 'error'; res.status(400).json({ error: e.message }); } });
// Test lab: run a sample candidate message through the same brain WITHOUT touching real candidates.
app.post('/api/simulate', async (req, res) => {
  try {
    const { jobId, stage, message, answers, pending } = req.body;
    if (!message || !message.trim()) throw new Error('Type a candidate message to test.');
    const j = db.jobs.find(x => x.id === jobId) || db.jobs[0];
    if (!j) throw new Error('Create a job first.');
    // Throwaway candidate — not added to db, calendar/email side effects suppressed.
    const fake = { id: '__sim__', jobId: j.id, name: 'Test Candidate', email: 'test@example.com', phone: '+910000000000', dnc: false, wa: newChannel(), em: newChannel() };
    fake.wa.stage = stage || 'outreach';
    fake.wa.answers = Object.assign({}, answers || {});
    fake.wa.pending = pending || null;
    fake.wa.calendarDone = true;   // prevent real calendar insert / invite emails during a test
    const ch = fake.wa;
    const understood = rulesUnderstand(fake, ch, message);
    const willUseAI = aiReady() && !understood;
    let replies, decision = null;
    if (willUseAI) { replies = await aiProcess(fake, ch, message); decision = ch._lastAI || null; }
    else { replies = handleIncoming(fake, ch, message); }
    res.json({
      engine: willUseAI ? 'ai' : (understood ? 'rules' : 'rules (AI off — add a key to use AI here)'),
      aiReady: aiReady(), understood, decision,
      replies: (replies || []).map(stripMd), newStage: ch.stage,
      answers: ch.answers, pending: ch.pending, dnc: fake.dnc,   // thread these back for a multi-turn trial
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/ai/test', async (req, res) => {
  try {
    const client = aiClient(); if (!client) throw new Error('Add your Anthropic API key first.');
    const r = await client.messages.create({ model: aiModel(), max_tokens: 32, messages: [{ role: 'user', content: 'Reply with exactly: RecruitFlow AI ready' }] });
    const txt = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ');
    res.json({ ok: true, model: r.model, reply: txt.trim() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ----- Google Calendar OAuth -----
app.get('/api/google/connect', (req, res) => { const url = googleAuthUrl(); if (!url) return res.status(400).json({ error: 'Add your Google Client ID & Secret in Settings first.' }); res.json({ url }); });
app.get('/oauth2callback', async (req, res) => {
  try {
    const o = oauthClient(); if (!o) throw new Error('Google credentials missing');
    const { tokens } = await o.getToken(req.query.code);
    db.settings.googleToken = Object.assign({}, db.settings.googleToken, tokens); save();
    log('📅 Google Calendar connected.');
    res.send('<body style="font-family:sans-serif;background:#0f1117;color:#e7e9ee;text-align:center;padding:60px"><h2>✅ Google Calendar connected</h2><p>You can close this tab and return to RecruitFlow.</p></body>');
  } catch (e) { res.send('<body style="font-family:sans-serif;padding:40px">❌ Could not connect: ' + String(e.message || '').replace(/</g, '&lt;') + '</body>'); }
});

// ----- Email outreach run -----
app.post('/api/run-email/:jobId', async (req, res) => { try { res.json(await runEmailJob(req.params.jobId)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/company', (req, res) => { db.company = (req.body.company || '').trim() || db.company; save(); res.json({ ok: true }); });

app.post('/api/jobs', (req, res) => {
  const b = req.body;
  const existing = db.jobs.find(x => x.id === b.id);
  const isNewJob = !existing;
  const j = existing || { id: uid(), createdAt: now() };
  Object.assign(j, { title: b.title, department: b.department, location: b.location, jd: b.jd, experience: b.experience, workingDays: +b.workingDays || 5, remote: b.remote || 'No', skills: b.skills, timeline: b.timeline });
  j.maxNoticeDays = (b.maxNoticeDays === '' || b.maxNoticeDays === null || b.maxNoticeDays === undefined) ? null : Number(b.maxNoticeDays);
  j.skillQuestions = Array.isArray(b.skillQuestions) ? b.skillQuestions.map(s => (s || '').trim()).filter(Boolean) : [];
  j.roleType = classifyRoleType(j.title);
  if (b.jdFileData && b.jdFileName) {
    const fn = j.id + '.pdf';
    try { fs.writeFileSync(path.join(UP_DIR, fn), Buffer.from(b.jdFileData, 'base64')); j.jdFile = fn; j.jdFileName = b.jdFileName; } catch (e) { log('JD save error: ' + e.message); }
  }
  if (b.removeJdFile) { if (j.jdFile) { try { fs.unlinkSync(path.join(UP_DIR, j.jdFile)); } catch (e) {} } j.jdFile = null; j.jdFileName = null; }
  if (!db.jobs.includes(j)) db.jobs.unshift(j);
  save();
  const autoAdded = isNewJob ? autoMatchAwaitingCandidates(j) : [];
  res.json(Object.assign({}, j, { autoAdded: autoAdded.length }));
});
app.delete('/api/jobs/:id', (req, res) => { db.jobs = db.jobs.filter(j => j.id !== req.params.id); db.candidates = db.candidates.filter(c => c.jobId !== req.params.id); save(); res.json({ ok: true }); });

function newChannel() { return { stage: 'new', transcript: [], answers: {}, flags: [], pending: null, chatId: null, skillIdx: 0 }; }
function mkCand(jobId, b) { return { id: uid(), jobId, name: b.name, email: b.email, phone: fmtPhone(b.phone), targetLocation: b.targetLocation, createdAt: now(), wa: newChannel(), em: newChannel() }; }
// Does a candidate's stated preferred location(s) cover this job's city?
function locationMatches(preferred, jobLoc) {
  const l = (jobLoc || '').toLowerCase().trim();
  if (!l) return false;
  const p = (preferred || '').toLowerCase();
  if (/any location|relocat|anywhere/.test(p)) return true;                 // open to relocating → matches anywhere
  return p.split(/[,/]|\band\b|&/).map(s => s.trim()).some(city => city && (city === l || city.includes(l) || l.includes(city)));
}
// When a NEW job is created, auto-pull anyone parked in "awaiting_role" whose desired role (same title)
// and preferred city match it. The pulled-in copy is tagged autoAdded so it's highlighted for the recruiter.
function autoMatchAwaitingCandidates(newJob) {
  if (!newJob || !newJob.title || !newJob.location) return [];
  const norm = s => (s || '').trim().toLowerCase();
  const added = [];
  for (const c of db.candidates.slice()) {
    if (c.wa.stage !== 'awaiting_role') continue;
    const origJob = jobOf(c);
    if (!origJob || norm(origJob.title) !== norm(newJob.title)) continue;
    if (!locationMatches(c.wa.answers.preferredLocation, newJob.location)) continue;
    if (db.candidates.some(x => x.jobId === newJob.id && last10(x.phone) === last10(c.phone))) continue;   // already in this job
    const nc = mkCand(newJob.id, { name: c.name, email: c.email, phone: c.phone, targetLocation: newJob.location });
    nc.autoAdded = true;
    nc.autoAddedFrom = { title: origJob.title, location: origJob.location, preferred: c.wa.answers.preferredLocation };
    db.candidates.push(nc);
    added.push(nc);
  }
  if (added.length) { save(); log(`✨ Auto-added ${added.length} candidate(s) to "${newJob.title}" (${newJob.location}) from the awaiting-role pool.`); }
  return added;
}
app.post('/api/candidates', (req, res) => { if (!req.body.name) return res.status(400).json({ error: 'name required' }); const c = mkCand(req.body.jobId, req.body); db.candidates.push(c); save(); res.json(c); });
// Edit a candidate's details at any stage (name / email / phone / target location).
app.patch('/api/candidates/:id', (req, res) => {
  const c = db.candidates.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Candidate not found.' });
  const b = req.body;
  if (b.name !== undefined) { if (!b.name.trim()) return res.status(400).json({ error: 'Name cannot be empty.' }); c.name = b.name.trim(); }
  if (b.email !== undefined) c.email = (b.email || '').trim();
  if (b.phone !== undefined) c.phone = fmtPhone(b.phone);
  if (b.targetLocation !== undefined) c.targetLocation = (b.targetLocation || '').trim();
  if (b.dnc !== undefined) c.dnc = !!b.dnc;
  save(); res.json(c);
});
// Act on a candidate whose "resurface later" date has arrived.
// Re-engage a candidate RIGHT NOW on WhatsApp — resumes the exact question they were left on,
// or (if their conversation had ended) re-opens with a fresh interest check. One click, immediate send.
async function retriggerCandidate(c) {
  if (waStatus !== 'ready') throw new Error('WhatsApp is not connected yet.');
  if (c.dnc) throw new Error('This candidate opted out — cannot message them.');
  const ch = c.wa, j = jobOf(c);
  if (ch.stage === 'new') throw new Error('Not contacted yet — use the ▶ WhatsApp button instead.');
  if (ch.stage === 'scheduled') throw new Error('Already scheduled — nothing to retrigger.');
  ch.activePoll = null; ch.activePollMsgId = null; ch.pending = null; ch.nudgeCount = 0;
  let text;
  if (isTerminal(ch.stage)) {
    // Conversation had ended (declined / rejected) — re-open with a fresh interest check, keeping prior answers for context.
    ch.stage = 'outreach';
    text = `Hi ${c.name}! 👋 Just checking back in — are you open to exploring the *${j ? j.title : ''}* opportunity now? 😊`;
    ch.transcript.push({ from: 'system', text, ts: now() });
    await sendRepliesWA(c, [text]);
  } else {
    // Mid-conversation — nudge them to reply to whatever we last actually sent, word-for-word (not a regenerated prompt).
    const lastSystemMsg = [...ch.transcript].reverse().find(t => t.from === 'system');
    text = lastSystemMsg ? lastSystemMsg.text : (stagePrompt(ch.stage, c, j) || `Hi ${c.name}! 👋 Just following up — whenever you get a chance, I'd love to hear back from you. 😊`);
    const lead = `Hi ${c.name}! 👋 Just following up on this —`;
    ch.transcript.push({ from: 'system', text: lead, ts: now() });
    await sendRepliesWA(c, [lead]);
    // Resend the exact original question — via its native poll if it was one, or as plain text otherwise.
    ch.transcript.push({ from: 'system', text, ts: now() });
    await sendRepliesWA(c, [text]);
  }
  save();
  return ch.stage;
}
app.post('/api/candidates/:id/retrigger', async (req, res) => {
  try {
    const c = db.candidates.find(x => x.id === req.params.id);
    if (!c) throw new Error('Candidate not found.');
    const stage = await retriggerCandidate(c);
    res.json({ ok: true, stage });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/candidates/:id/resurface', async (req, res) => {
  const c = db.candidates.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Candidate not found.' });
  const action = req.body.action;
  try {
    if (action === 'rerun') { const stage = await retriggerCandidate(c); return res.json({ ok: true, stage }); }
    else if (action === 'dismiss') { delete c.wa.answers.resurfaceDate; save(); return res.json({ ok: true }); }
    else return res.status(400).json({ error: 'Unknown action.' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/candidates/bulk', (req, res) => { const { jobId, rows } = req.body; let added = 0; (rows || []).forEach(r => { if (r.name) { db.candidates.push(mkCand(jobId, r)); added++; } }); save(); res.json({ added }); });
app.delete('/api/candidates/:id', (req, res) => { db.candidates = db.candidates.filter(c => c.id !== req.params.id); save(); res.json({ ok: true }); });

// Pull Strong candidates from the Google Sheet (auto-derives role+city; skips anyone contacted <90 days).
app.post('/api/sheet/sync', async (req, res) => { try { res.json(await syncFromSheet()); } catch (e) { res.status(400).json({ error: e.message }); } });
app.get('/api/sheet/status', (req, res) => res.json({ connected: fs.existsSync(SA_KEY_PATH) && !!db.settings.sheetId, sheetId: db.settings.sheetId || '' }));

app.post('/api/run/:jobId', async (req, res) => { try { res.json(await runJob(req.params.jobId)); } catch (e) { res.status(400).json({ error: e.message }); } });
// Per-candidate outreach
app.post('/api/run-one/:candId', async (req, res) => { try { res.json(await runJobOne(req.params.candId)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/run-email-one/:candId', async (req, res) => { try { res.json(await runEmailOne(req.params.candId)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/flags/resolve', (req, res) => { const c = db.candidates.find(x => x.id === req.body.candId); const ch = c ? c[req.body.channel === 'em' ? 'em' : 'wa'] : null; if (ch && ch.flags[req.body.idx]) ch.flags[req.body.idx].resolved = true; save(); res.json({ ok: true }); });
// Resolve every unresolved flag on a candidate (both channels) in one click.
app.post('/api/flags/resolve-all', (req, res) => { const c = db.candidates.find(x => x.id === req.body.candId); if (!c) return res.status(404).json({ error: 'not found' }); [c.wa, c.em].forEach(ch => { if (ch && ch.flags) ch.flags.forEach(f => f.resolved = true); }); save(); res.json({ ok: true }); });
// Manual recruiter reply into a conversation
app.post('/api/send', async (req, res) => {
  try {
    if (waStatus !== 'ready') throw new Error('WhatsApp not connected');
    const c = db.candidates.find(x => x.id === req.body.candId); if (!c) throw new Error('candidate not found');
    const to = c.wa.chatId || (normPhone(c.phone) + '@c.us');
    await waSend(to, req.body.text);
    c.wa.transcript.push({ from: 'system', text: req.body.text, ts: now(), manual: true }); save();
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

if (!process.env.RF_TEST) app.listen(PORT, () => log(`Dashboard running → http://localhost:${PORT}`));
