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
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
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
const EXP = ['0-1 years', '1-3 years', '3-5 years', '5-8 years', '8+ years'];
const ROLE = ['Individual Contributor', 'Team Lead / Senior', 'Manager', 'Fresher / Looking for first role', 'Other'];
const TIME = ['Morning (9 AM - 12 PM)', 'Afternoon (12 PM - 3 PM)', 'Evening (3 PM - 6 PM)'];
const STAGE_LABEL = { new: 'Not started', outreach: 'Outreach sent', details_form: 'Details form sent', location: 'Asked location', preflocation: 'Preferred location', workpref: 'Work preference', experience: 'Experience', role: 'Current role', currentctc: 'Current CTC', expectedctc: 'Expected CTC', notice: 'Notice period', skills: 'Skill questions', resume: 'Resume request', avail: 'Scheduling', avail_time: 'Scheduling', avail_day: 'Scheduling', scheduled: 'Call scheduled ✓', declined: 'Not interested', location_dropout: 'Location mismatch', notice_dropout: 'Notice too long' };
const isTerminal = s => ['scheduled', 'declined', 'location_dropout', 'notice_dropout'].includes(s);

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

/* ---------------- Predefined template Q&A ---------------- */
const TEMPLATES = [
  { keys: ['ctc', 'salary', 'pay', 'compensation', 'package', 'lpa', 'stipend', 'hike'], resp: () => "As per company policy, we don't disclose CTC at this stage. However, our recruiter will discuss a compensation package based on your experience during your call. Shall we proceed?" },
  { keys: ['growth', 'career', 'learning', 'upskill', 'progression', 'promot'], resp: () => "Great question! Our recruiter will walk you through career progression and upskilling opportunities during your call. Looking forward to it!" },
  { keys: ['remote', 'work from home', 'wfh', 'hybrid'], resp: (j) => `This role requires ${j.workingDays} days from office in ${j.location}. Our recruiter can discuss flexibility during your call.` },
  { keys: ['benefit', 'perk', 'insurance', 'leave', 'holiday'], resp: () => "Our recruiter will give you a full overview of benefits and perks during your call. Let's get you scheduled!" },
];
const FALLBACK = "That's a great question! Our recruiter is best placed to answer this in detail. Let's get you connected. Please share your availability — your preferred day and time for a call.";
function matchTemplate(text, j) { const t = text.toLowerCase(); for (const tpl of TEMPLATES) if (tpl.keys.some(k => t.includes(k))) return { resp: tpl.resp(j), flagged: false }; return { resp: FALLBACK, flagged: true }; }
const questionLike = t => /\?/.test(t) || TEMPLATES.some(tpl => tpl.keys.some(k => t.toLowerCase().includes(k)));

/* ---------------- Natural-language understanding ---------------- */
function detectInterest(t) {
  t = ' ' + t.toLowerCase() + ' ';
  if (/(not interested|no thanks|no thank|not right now|not looking|not keen|already (have|placed|employed|working)|happy where|i'?ll pass|\bno\b|\bnope\b|\bnah\b|decline)/.test(t)) return 'no';
  if (/(\byes\b|yeah|yep|yup|\bsure\b|interested|keen|definitely|absolutely|\bok\b|okay|sounds good|why not|i'?m in|go ahead|tell me more|more details|more info|love to|happy to|let'?s|please)/.test(t)) return 'yes';
  if (/(maybe|perhaps|depends|not sure|possibly|might|could be)/.test(t)) return 'maybe';
  if (/^\s*(1|a)\b/.test(t)) return 'yes';
  if (/^\s*(2|b)\b/.test(t)) return 'no';
  return null;
}
function detectComfort(t) {
  t = ' ' + t.toLowerCase() + ' ';
  if (/(\bno\b|not comfortable|can'?t|cannot|prefer|different location|too far|not possible|won'?t work|unable|not ok)/.test(t)) return 'no';
  if (/(\byes\b|yeah|\bsure\b|comfortable|\bfine\b|\bok\b|okay|no problem|works for me|i can|that'?s fine|happy to|willing)/.test(t)) return 'yes';
  if (/^\s*(1|a)\b/.test(t)) return 'yes';
  if (/^\s*(2|b)\b/.test(t)) return 'no';
  return null;
}
function parseLetter(t, max) { t = t.trim().toLowerCase(); const m = t.match(/^\s*([a-e])\b/) || t.match(/^\s*([a-e])\)/); if (m) { const i = m[1].charCodeAt(0) - 97; if (i < max) return i; } const n = t.match(/\b([1-9])\b/); if (n) { const i = +n[1] - 1; if (i >= 0 && i < max) return i; } return null; }
function bucketExp(y) { if (y <= 1) return EXP[0]; if (y <= 3) return EXP[1]; if (y <= 5) return EXP[2]; if (y <= 8) return EXP[3]; return EXP[4]; }
function detectExperience(t) {
  const tl = t.toLowerCase();
  if (/\b(fresher|fresh|no experience|just graduated|final year|student)\b/.test(tl)) return EXP[0];
  // Explicit "X years / yrs" always means years of experience → bucket it.
  let m = tl.match(/(\d+(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?|yr)\b/);
  if (m) return bucketExp(parseFloat(m[1]));
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
// Parse a loose date string to a future Date (for "last working day").
function parseDateLoose(t) {
  t = (t || '').toLowerCase(); const now = new Date();
  if (/day after/.test(t)) { const d = new Date(now); d.setDate(d.getDate() + 2); return d; }
  if (/tomorrow/.test(t)) { const d = new Date(now); d.setDate(d.getDate() + 1); return d; }
  if (/\btoday\b/.test(t)) return new Date(now);
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
  return `Hi ${c.name}! 👋\n\nI'm reaching out from *${db.company}*. We came across your profile and think you could be a great fit for our *${j.title}* role${j.location ? ` based in ${j.location}` : ''}.\n\n` +
    (hasPdf ? `📄 I've attached the full job description below — do take a look.\n\n` : ``) +
    `Are you open to exploring this opportunity? 😊 Feel free to ask me anything about the role.`;
}
function stagePrompt(stage, c, j) {
  switch (stage) {
    case 'location': return `Great! 🙌 Before we connect you with our recruiter, a few quick questions.\n\nFirst — what is your *current location*? (the city you're based in now)`;
    case 'preflocation': return `Got it! And which location would you *prefer* to work in?`;
    case 'workpref': return `This role is based in *${j.location}* and requires *${j.workingDays} days/week from office*.${j.remote === 'No' ? ' There is no remote option for this role.' : ''}\n\nAre you comfortable with this?`;
    case 'experience': return `How many years of *experience* do you have?`;
    case 'currentctc': return `Could you share your *current CTC* (annual)?\n\nIf you'd rather not disclose, just say "skip" and we'll move on. 😊`;
    case 'expectedctc': return `And your *expected CTC*? (Feel free to skip this too if you're not comfortable.)`;
    case 'notice': return `What is your *notice period*? (for example: "immediate", "30 days", or "2 months")`;
    case 'resume': return `One last thing — do you have an *updated resume* you'd like to share? You can paste a Google Drive link or any public link. If not, just say *"skip"* and we'll move on. 📄`;
    case 'avail': return `Brilliant! 🎉 We'd love to connect you with our recruiter for a quick chat.\n\nPlease share your *availability* — your preferred day and time over the next 2-3 days. Our recruiters call between *12 PM and 5 PM*, so do pick a slot in that window. 🕘`;
  }
  return '';
}
function clarify(stage, j) {
  const note = `Hmm, I couldn't quite understand that — there may be a spelling error. Please resend your answer without any typos. 🙏\n\n`;
  switch (stage) {
    case 'outreach': return note + `Are you open to exploring this role? Just let me know.`;
    case 'workpref': return note + `Are you comfortable with the office location and working days?`;
    case 'experience': return note + `How many years of experience do you have? (for example, "4 years")`;
    case 'currentctc': return note + `What is your current CTC? Or say "skip" to pass.`;
    case 'expectedctc': return note + `What is your expected CTC? You can also say "skip".`;
    case 'notice': return note + `What is your notice period? e.g. "30 days", "2 months", or "immediate".`;
    case 'avail': return note + `Please share a day and time that works for a quick call. 🕘`;
  }
  return note;
}
// Enter the skill-question stage (or skip straight to resume if the job has none).
function enterSkills(c, ch, out) {
  const j = jobOf(c), qs = (j.skillQuestions || []).filter(q => q && q.trim());
  if (!qs.length) { advance(c, ch, 'resume', out); return; }
  ch.skillIdx = 0; ch.answers.skills = []; ch.stage = 'skills';
  out.push(`Almost there! A couple of quick questions about your experience. 📝\n\n${qs[0]}`);
}

/* ---------------- Flow engine (channel-agnostic: drives WhatsApp & Email) ---------------- */
function advance(c, ch, stage, out) { ch.stage = stage; out.push(stagePrompt(stage, c, jobOf(c))); }
function confirmSchedule(c, ch, out) {
  ch.stage = 'scheduled';
  out.push(`Perfect! ✅ I've noted your availability: *${ch.answers.availability}*. Our recruiter will reach out to confirm the call. Please keep your phone handy — looking forward to connecting you! 📞`);
  onScheduled(c, ch);   // fire calendar event (async, non-blocking)
}
function askQuestion(c, ch, text, out) { const m = matchTemplate(text, jobOf(c)); out.push(m.resp); if (m.flagged) ch.flags.push({ q: text, ts: now(), resolved: false }); return m.flagged; }
// Side-question mid-flow. If unknown and `jump` allowed, answer with fallback and route to scheduling.
function sideQuestion(c, ch, text, out, jump) {
  const m = matchTemplate(text, jobOf(c));
  out.push(m.resp);
  if (m.flagged) { ch.flags.push({ q: text, ts: now(), resolved: false }); if (jump) { ch.stage = 'avail'; return true; } }
  return false;
}

function handleIncoming(c, ch, text) {
  const j = jobOf(c), out = [];
  ch.transcript.push({ from: 'candidate', text, ts: now() });
  ch.nudgeCount = 0;   // they replied — reset the 1-day follow-up counter

  if (ch.pending === 'last_working_day') {
    ch.pending = null;
    const days = parseDateToDays(text);
    ch.answers.noticePeriod = 'Serving notice — last working day: ' + text.trim();
    ch.answers.noticePeriodDays = (days == null ? 0 : days);
    const max = j.maxNoticeDays;
    if (max !== null && max !== undefined && max !== '' && days != null && days > Number(max)) {
      ch.stage = 'notice_dropout';
      out.push(`Thanks for sharing. 🙏 Unfortunately this role needs someone who can join within *${noticeLabel(max)}*, and your last working day is beyond that. We'll keep your profile active for future roles that match. Best of luck!`);
    } else { enterSkills(c, ch, out); }
    return finish(ch, out);
  }

  if (ch.stage === 'new' || isTerminal(ch.stage)) {
    if (detectAck(text)) out.push("You're welcome! 😊 You're all set — our recruiter will be in touch. Have a great day!");
    else askQuestion(c, ch, text, out);
    return finish(ch, out);
  }

  switch (ch.stage) {
    case 'outreach': {
      const v = detectInterest(text);
      if (v === 'yes') { ch.answers.interested = 'Yes'; advance(c, ch, 'location', out); }
      else if (v === 'no') { ch.answers.interested = 'No'; ch.stage = 'declined'; out.push("No worries! We'll keep your profile in our database and reach out if a better fit comes up. Best of luck! 🙏"); }
      else if (v === 'maybe') { out.push("Totally understand — take your time! 😊 The role offers strong growth and our recruiter can answer any specifics. Do let me know if you'd like to explore it."); }
      else { if (questionLike(text)) sideQuestion(c, ch, text, out, false); out.push(clarify('outreach', j)); }
      break;
    }
    case 'location': {
      if (questionLike(text)) { if (sideQuestion(c, ch, text, out, true)) break; out.push(stagePrompt('location', c, j)); }
      else { ch.answers.currentLocation = text.trim(); advance(c, ch, 'preflocation', out); }
      break;
    }
    case 'preflocation': {
      if (questionLike(text)) { if (sideQuestion(c, ch, text, out, true)) break; out.push(stagePrompt('preflocation', c, j)); }
      else { ch.answers.preferredLocation = text.trim(); advance(c, ch, 'workpref', out); }
      break;
    }
    case 'workpref': {
      const v = detectComfort(text);
      if (v === 'yes') { ch.answers.workComfortable = 'Yes'; advance(c, ch, 'experience', out); }
      else if (v === 'no') { ch.answers.workComfortable = 'No'; ch.stage = 'location_dropout'; out.push(`I understand. 🙏 Unfortunately this role requires office presence in *${j.location}*. We'll keep your profile active for future opportunities matching your preference. Best of luck!`); }
      else { if (questionLike(text)) { if (sideQuestion(c, ch, text, out, true)) break; } out.push(clarify('workpref', j)); }
      break;
    }
    case 'experience': {
      const v = detectExperience(text);
      if (v) { ch.answers.experience = v; advance(c, ch, 'currentctc', out); }
      else { if (questionLike(text)) { if (sideQuestion(c, ch, text, out, true)) break; } out.push(clarify('experience', j)); }
      break;
    }
    case 'currentctc': {
      if (detectSkip(text)) { ch.answers.currentCTC = 'Prefer not to disclose'; advance(c, ch, 'expectedctc', out); break; }
      if (!/\d/.test(text) && questionLike(text)) { if (sideQuestion(c, ch, text, out, true)) break; out.push(stagePrompt('currentctc', c, j)); break; }
      ch.answers.currentCTC = text.trim(); advance(c, ch, 'expectedctc', out);
      break;
    }
    case 'expectedctc': {
      if (detectSkip(text)) { ch.answers.expectedCTC = 'Prefer not to disclose'; advance(c, ch, 'notice', out); break; }
      if (!/\d/.test(text) && questionLike(text)) { if (sideQuestion(c, ch, text, out, true)) break; out.push(stagePrompt('expectedctc', c, j)); break; }
      ch.answers.expectedCTC = text.trim(); advance(c, ch, 'notice', out);
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
      ch.answers.noticePeriod = text.trim(); ch.answers.noticePeriodDays = d;
      const max = j.maxNoticeDays;
      if (max !== null && max !== undefined && max !== '' && d > Number(max)) {
        ch.stage = 'notice_dropout';
        out.push(`Thanks for sharing. 🙏 Unfortunately this role needs someone who can join within *${noticeLabel(max)}*, and your notice period is longer. We'll keep your profile active for future roles that match. Best of luck!`);
      } else { enterSkills(c, ch, out); }
      break;
    }
    case 'skills': {
      const qs = (j.skillQuestions || []).filter(q => q && q.trim());
      const i = ch.skillIdx || 0;
      ch.answers.skills = ch.answers.skills || [];
      ch.answers.skills.push({ q: qs[i], a: text.trim() });
      if (i + 1 < qs.length) { ch.skillIdx = i + 1; out.push(qs[i + 1]); }
      else { advance(c, ch, 'resume', out); }
      break;
    }
    case 'resume': {
      if (detectSkip(text)) { ch.answers.resume = 'Not shared'; }
      else { ch.answers.resume = text.trim(); }
      advance(c, ch, 'avail', out);
      break;
    }
    case 'avail': {
      const dayTok = extractDay(text), tm = parseTimeHour(text);
      if (questionLike(text) && !dayTok && !tm) { askQuestion(c, ch, text, out); out.push(stagePrompt('avail', c, j)); break; }
      if (dayTok) ch.answers.availDay = dayTok;
      if (tm && (tm.hour < CALL_START || tm.hour > CALL_END)) {   // outside calling hours
        out.push(`Our recruiters call between *12 PM and 5 PM*. Could you share a time within that window? (e.g. "3 pm") 🕘`); break;
      }
      if (tm) { ch.answers._h = tm.hour; ch.answers._m = tm.min || 0; }
      const haveDay = !!ch.answers.availDay, haveTime = (ch.answers._h != null);
      if (haveDay && haveTime) {
        ch.answers.availability = `${ch.answers.availDay} ${fmtHour(ch.answers._h, ch.answers._m)}`;   // schedule ONLY with both day + time
        confirmSchedule(c, ch, out);
      } else if (haveDay) { out.push(`Thanks! And what *time* works best? Our recruiters call between *12 PM and 5 PM* — e.g. "3 pm". 🕘`); }
      else if (haveTime) { out.push(`Got it! And which *day* works for you? (e.g. "tomorrow" or "Friday") 📅`); }
      else { out.push(`I'll need a specific *day and time* to book the call (calling hours are *12 PM–5 PM*). For example: "Friday 3 pm". 📅`); }
      break;
    }
  }
  return finish(ch, out);
}
function finish(ch, out) { out.forEach(t => ch.transcript.push({ from: 'system', text: t, ts: now() })); save(); return out; }

/* ---------------- Logger (shared) ---------------- */
const logs = [];
function log(m) { const line = `[${new Date().toLocaleTimeString()}] ${m}`; logs.push(line); if (logs.length > 200) logs.shift(); console.log(line); }

/* ---------------- Settings + backfill ---------------- */
db.settings = db.settings || {};
db.candidates.forEach(c => { if (!c.em) c.em = newChannel(); if (!c.wa) c.wa = newChannel(); });
const stripMd = t => (t || '').replace(/\*/g, '');

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
// Build a Google Calendar "add event" link (pre-filled, opens ready to Save). No API/OAuth needed.
function buildGcalUrl(c, ch) {
  const j = jobOf(c), { start, uncertain } = parseAvailabilityToDate(ch.answers.availability);
  const end = new Date(start.getTime() + 30 * 60000);
  const f = d => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}T${pad2(d.getHours())}${pad2(d.getMinutes())}00`;
  const params = new URLSearchParams({ action: 'TEMPLATE', text: `Recruiter call: ${c.name} — ${j ? j.title : ''}`, dates: `${f(start)}/${f(end)}`, details: eventDetails(c, ch, uncertain), location: (j && j.location) || '' });
  return { url: `https://calendar.google.com/calendar/render?${params.toString()}`, start, end, uncertain };
}
// Build an .ics calendar invite the recruiter can open/import.
function buildICS(c, ch, start, end, uncertain) {
  const j = jobOf(c);
  const u = d => `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}00Z`;
  const esc = s => String(s || '').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//RecruitFlow//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:${c.id}-${start.getTime()}@recruitflow`, `DTSTAMP:${u(new Date())}`, `DTSTART:${u(start)}`, `DTEND:${u(end)}`,
    `SUMMARY:${esc('Recruiter call: ' + c.name + ' — ' + (j ? j.title : ''))}`, `DESCRIPTION:${esc(eventDetails(c, ch, uncertain))}`,
    `LOCATION:${esc((j && j.location) || '')}`, 'BEGIN:VALARM', 'TRIGGER:-PT30M', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}
// On scheduling: store an Add-to-Calendar link (always works) and email an .ics invite if email is set up.
function onScheduled(c, ch) {
  if (ch.calendarDone) return;
  ch.calendarDone = true;
  try {
    const g = buildGcalUrl(c, ch);
    ch.answers.calendarLink = g.url; save();
    log(`📅 Add-to-Calendar link ready for ${c.name} (${ch.answers.availability})${g.uncertain ? ' [time estimated]' : ''}`);
    if (mailerReady()) {
      const ics = buildICS(c, ch, g.start, g.end, g.uncertain);
      const body = `${c.name} has scheduled a recruiter call.\n\nWhen: ${ch.answers.availability}\nRole: ${(jobOf(c) || {}).title || ''}\nPhone: ${c.phone || '-'}\n\nAdd to Google Calendar: ${g.url}\n\n(A calendar invite is attached — open it to add to any calendar app.)`;
      sendEmail(db.settings.email, `📅 Recruiter call scheduled — ${c.name}`, body, [{ filename: 'invite.ics', content: ics, contentType: 'text/calendar' }])
        .then(() => log(`📧 Calendar invite emailed to ${db.settings.email}`)).catch(e => log('Invite email failed: ' + e.message));
    }
  } catch (e) { ch.calendarDone = false; log('Calendar link error for ' + c.name + ': ' + e.message); }
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
  if (!j || !c.email || c.em.stage !== 'new') return false;
  const subject = `Exploring a ${j.title} opportunity at ${db.company}`;
  c.em.subject = subject;
  const attach = j.jdFile ? [{ filename: j.jdFileName || 'Job-Description.pdf', path: path.join(UP_DIR, j.jdFile) }] : [];
  const qs = (j.skillQuestions || []).filter(q => q && q.trim());
  let qNum = 7;
  let skillLines = qs.map((q, i) => `${qNum + i}. ${q}:`).join('\n');
  const resumeNum = qNum + qs.length;
  const body = `Hi ${c.name}!\n\nI'm reaching out from ${db.company}. We came across your profile and think you could be a great fit for our ${j.title} role${j.location ? ` based in ${j.location}` : ''}.\n\n${j.jdFile ? `The full job description is attached — please take a look.\n\n` : ''}If you're interested, please reply to this email with the following details:\n\n──────────────────────\n1. Current city (where you're based now):\n2. Preferred work location:\n3. Total years of experience:\n4. Current CTC (or type "skip"):\n5. Expected CTC (or type "skip"):\n6. Notice period (e.g. "immediate", "30 days", "2 months"):\n${skillLines ? skillLines + '\n' : ''}${resumeNum}. Resume: Please attach your updated resume, or type "no resume" if not available.\n──────────────────────\n\nIf you're not actively looking right now, no worries — feel free to reach out on this email once you are.\n\nWarm regards,\n${db.company} Talent Team`;
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

  // Notice period eligibility check
  const max = j && j.maxNoticeDays;
  if (max !== null && max !== undefined && max !== '' && parsed.noticePeriodDays != null && parsed.noticePeriodDays > Number(max)) {
    c.em.stage = 'notice_dropout';
    out.push(`Hi ${c.name},\n\nThank you for sharing your details!\n\nUnfortunately, this role requires someone who can join within ${noticeLabel(max)}, and your current notice period is longer than that. We're unable to take this forward at this time.\n\nWe'll keep your profile active for future opportunities — feel free to reach out on this email whenever you're looking again.\n\nBest of luck!\n\n${db.company} Talent Team`);
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
  if (!mailerReady()) return;
  for (const c of db.candidates) {
    if (c.wa.stage !== 'outreach' || c.em.stage !== 'new' || !c.email) continue;       // still at initial WA outreach, no email yet
    if (c.wa.transcript.some(m => m.from === 'candidate')) continue;                    // they DID reply on WhatsApp → leave it
    if (Date.now() - (c.wa.outreachSentAt || 0) < FOLLOWUP_MS) continue;                // not 24h yet
    try { if (await sendEmailOutreachTo(c)) log(`⏱️ No WhatsApp reply from ${c.name} in 24h → email follow-up sent.`); }
    catch (e) { log('Email follow-up failed for ' + c.name + ': ' + e.message); }
  }
}
if (!process.env.RF_TEST) { setInterval(() => checkEmailFollowups().catch(() => {}), 30 * 60 * 1000); setTimeout(() => checkEmailFollowups().catch(() => {}), 20000); }

/* ---------------- 1-day follow-up nudge (any unanswered message: outreach OR a question) ---------------- */
const NUDGE_MS = 24 * 60 * 60 * 1000;   // nudge after 1 day of silence
const MAX_NUDGES = 2;                    // at most 2 gentle reminders, then leave them be
function nudgeText(c, n) {
  if (n >= 1) return `Hi ${c.name}, just checking in once more 😊 — if now isn't the right time, no problem at all. Whenever you're ready, simply reply here and we'll pick up where we left off.`;
  return `Hi ${c.name}! 👋 Just following up on my previous message — whenever you get a chance, I'd love to hear back from you. 😊`;
}
// Re-ping any candidate who hasn't replied to our last message for 1 day, on whichever channel that message went out.
async function checkNudges() {
  for (const c of db.candidates) {
    for (const ch of [c.wa, c.em]) {
      if (!ch || ch.stage === 'new' || isTerminal(ch.stage)) continue;
      const t = ch.transcript || []; if (!t.length) continue;
      const last = t[t.length - 1];
      if (last.from !== 'system') continue;                                   // last word was ours; we're waiting on candidate
      if ((ch.nudgeCount || 0) >= MAX_NUDGES) continue;                       // already nudged the max times
      if (Date.now() - new Date(last.ts).getTime() < NUDGE_MS) continue;      // less than a day of silence
      const isWA = (ch === c.wa);
      const text = nudgeText(c, ch.nudgeCount || 0);
      try {
        if (isWA) {
          if (waStatus !== 'ready') continue;
          await client.sendMessage(c.wa.chatId || (normPhone(c.phone) + '@c.us'), text);
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

let emailPolling = false;
async function pollEmail() {
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
        const body = topReply(parsed.text || '');
        if (!body) continue;
        log(`📧 ◀ ${c.name}: ${body.slice(0, 50)}`);
        let replies;
        if (c.em.stage === 'details_form') {
          replies = await handleEmailFormReply(c, parsed);   // batch-parse the form reply
        } else {
          replies = handleIncoming(c, c.em, body);
        }
        for (const r of replies) await sendEmail(c.email, emailSubject(c), stripMd(r));
        log(`📧 ▶ Replied to ${c.name} → [${STAGE_LABEL[c.em.stage] || c.em.stage}]`);
      }
    } finally { lock.release(); }
  } catch (e) { emailStatus = 'error'; log('IMAP error: ' + e.message); }
  finally { try { await imap.logout(); } catch (e) {} emailPolling = false; }
}
if (!process.env.RF_TEST) setInterval(() => { pollEmail().catch(() => {}); }, 20000);

/* ---------------- WhatsApp client ---------------- */
let waStatus = 'starting', qrDataUrl = null, waInfo = null;

const client = new Client({ authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }), puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] } });
client.on('qr', async qr => { clearWatchdog(); waStatus = 'qr'; qrDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 1 }); log('QR generated — scan it from the dashboard.'); });
client.on('authenticated', () => { waStatus = 'authenticated'; });
client.on('auth_failure', m => { clearWatchdog(); waStatus = 'auth_failure'; log('Auth failure: ' + m); });
client.on('ready', () => { clearWatchdog(); waStatus = 'ready'; qrDataUrl = null; waInfo = client.info ? client.info.wid.user : null; log('WhatsApp READY. Connected as +' + (waInfo || '?')); setTimeout(() => catchUpWhatsApp(), 4000); });
client.on('disconnected', r => { waStatus = 'disconnected'; log('Disconnected: ' + r + ' — attempting to reconnect.'); recoverWhatsApp(); });

/* --- Self-healing: remove stale Chrome locks + auto-recover if the client hangs --- */
function clearChromeLocks() {
  try {
    const base = path.join(__dirname, '.wwebjs_auth');
    if (!fs.existsSync(base)) return;
    const walk = dir => { for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); let st; try { st = fs.lstatSync(p); } catch (e) { continue; } if (st.isDirectory()) walk(p); else if (/^Singleton/.test(f)) { try { fs.unlinkSync(p); } catch (e) {} } } };
    walk(base);
  } catch (e) {}
}
let waWatchdog = null, recovering = false;
function clearWatchdog() { if (waWatchdog) { clearTimeout(waWatchdog); waWatchdog = null; } }
function armWatchdog() {
  clearWatchdog();
  // If WhatsApp doesn't reach 'ready' or show a QR within 2 minutes, it's hung — recover.
  waWatchdog = setTimeout(() => { if (waStatus !== 'ready' && waStatus !== 'qr') recoverWhatsApp(); }, 120000);
}
async function recoverWhatsApp() {
  if (recovering) return; recovering = true;
  log(`⚠️ WhatsApp stuck/dropped at "${waStatus}" — auto-recovering…`);
  try { await client.destroy(); } catch (e) {}
  clearChromeLocks();
  try { waStatus = 'starting'; await client.initialize(); armWatchdog(); }
  catch (e) { log('Recovery failed: ' + e.message + (process.env.RF_MANAGED ? ' — exiting for auto-restart.' : '')); if (process.env.RF_MANAGED) process.exit(1); }
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
        log(`⏳ Catch-up — ${c.name}: ${m.body.slice(0, 40)}`);
        const replies = handleIncoming(c, c.wa, m.body);
        for (const t of replies) { try { await chat.sendMessage(t); } catch (e) {} await new Promise(r => setTimeout(r, 600)); }
        c.wa.lastProcessedTs = m.timestamp * 1000;
      }
      save();
    }
  } catch (e) { log('Catch-up error: ' + e.message); }
}
const ACTIVE = ['outreach', 'location', 'preflocation', 'workpref', 'experience', 'role', 'currentctc', 'expectedctc', 'notice', 'skills', 'avail', 'avail_time', 'avail_day'];
const tsLast = c => { const t = c.wa.transcript; return t.length ? Date.parse(t[t.length - 1].ts) || 0 : 0; };
client.on('message', async msg => {
  try {
    if (msg.from.endsWith('@g.us') || msg.from === 'status@broadcast' || msg.isStatus || msg.fromMe) return;
    const num = await resolveNumber(msg);
    // Diagnostics: show exactly what WhatsApp exposes about the sender.
    const diag = { from: msg.from };
    try { const ct = await msg.getContact(); diag.id = ct && ct.id && ct.id._serialized; diag.number = ct && ct.number; diag.name = ct && (ct.pushname || ct.name); } catch (e) { diag.err = e.message; }
    log('DIAG ' + JSON.stringify(diag) + ' resolved=' + num);

    // STRICT matching: only reply to a candidate we actually sent outreach to (by their real number,
    // or a chat already pinned to them). Anyone else messaging this number is ignored — no auto-reply.
    let how = 'number';
    let c = db.candidates.find(x => x.wa.stage !== 'new' && last10(x.phone) === num.slice(-10));
    if (!c) { c = db.candidates.find(x => x.wa.stage !== 'new' && x.wa.chatId === msg.from); how = 'pinned-chat'; }
    if (!c) { log(`◀ Incoming from +${num} — not a contacted candidate, ignored (no auto-reply).`); return; }
    c.wa.chatId = msg.from;                        // pin this chat to the candidate for all future messages
    c.wa.lastProcessedTs = (msg.timestamp ? msg.timestamp * 1000 : Date.now());
    save();
    log(`◀ ${c.name} [match:${how}] +${num}: ${msg.body.slice(0, 60)}`);
    const replies = handleIncoming(c, c.wa, msg.body);
    for (const text of replies) { await msg.reply(text); await new Promise(r => setTimeout(r, 700)); }
    log(`▶ Replied to ${c.name} → now [${STAGE_LABEL[c.wa.stage]}]`);
  } catch (e) { log('handler error: ' + e.message); }
});
if (!process.env.RF_TEST) { clearChromeLocks(); log('Starting WhatsApp client…'); client.initialize(); armWatchdog(); }
module.exports = { detectInterest, detectComfort, detectExperience, detectRole, detectSlot, detectDay, handleIncoming, db };

/* ---------------- Send outreach (RUN) ---------------- */
// Send WhatsApp outreach to ONE candidate. Throws on failure. media is optional (loaded once by the caller).
async function sendWhatsAppOutreachTo(c, j, media) {
  if (c.wa.stage !== 'new') throw new Error('already contacted on WhatsApp');
  const text = outreachText(c, j), jid2 = normPhone(c.phone) + '@c.us';
  const ok = await client.isRegisteredUser(jid2);
  if (!ok) throw new Error('not on WhatsApp');
  await client.sendMessage(jid2, text);
  if (media) { await new Promise(r => setTimeout(r, 600)); await client.sendMessage(jid2, media, { caption: `📄 ${j.title} — Job Description`, sendMediaAsDocument: true }); }
  c.wa.stage = 'outreach'; c.wa.outreachSentAt = Date.now(); c.wa.transcript.push({ from: 'system', text, ts: now() });
  if (media) c.wa.transcript.push({ from: 'system', text: `📄 [Sent JD attachment: ${j.jdFileName || j.jdFile}]`, ts: now() });
  log(`  ✓ Sent to ${c.name} (+${normPhone(c.phone)})`);
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

app.get('/api/status', (req, res) => res.json({ waStatus, qr: qrDataUrl, connectedAs: waInfo, logs: logs.slice(-40), emailStatus, emailReady: mailerReady(), emailUser: db.settings.email || null, calendarMode: 'invite', calendarConnected: true }));
app.get('/api/state', (req, res) => res.json(db));

// ----- Settings (email + Google credentials). Secrets are write-only; never returned. -----
app.get('/api/settings', (req, res) => res.json({ email: db.settings.email || '', emailPassSet: !!db.settings.emailPass, googleClientId: db.settings.googleClientId || '', googleClientSecretSet: !!db.settings.googleClientSecret, calendarConnected: calendarConnected(), redirectUri: OAUTH_REDIRECT }));
app.post('/api/settings', (req, res) => {
  const b = req.body;
  if (b.email !== undefined) db.settings.email = (b.email || '').trim();
  if (b.emailPass) db.settings.emailPass = b.emailPass.replace(/\s+/g, '');   // Gmail app passwords are shown with spaces
  if (b.googleClientId !== undefined) db.settings.googleClientId = (b.googleClientId || '').trim();
  if (b.googleClientSecret) db.settings.googleClientSecret = b.googleClientSecret.trim();
  if (b.clearGoogleToken) db.settings.googleToken = null;
  save(); res.json({ ok: true });
});
app.post('/api/email/test', async (req, res) => { try { if (!mailerReady()) throw new Error('Add email + app password first.'); await sendEmail(db.settings.email, 'RecruitFlow test ✅', 'Your RecruitFlow email is configured correctly.'); emailStatus = 'ok'; res.json({ ok: true }); } catch (e) { emailStatus = 'error'; res.status(400).json({ error: e.message }); } });

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
  const j = db.jobs.find(x => x.id === b.id) || { id: uid(), createdAt: now() };
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
  save(); res.json(j);
});
app.delete('/api/jobs/:id', (req, res) => { db.jobs = db.jobs.filter(j => j.id !== req.params.id); db.candidates = db.candidates.filter(c => c.jobId !== req.params.id); save(); res.json({ ok: true }); });

function newChannel() { return { stage: 'new', transcript: [], answers: {}, flags: [], pending: null, chatId: null, skillIdx: 0 }; }
function mkCand(jobId, b) { return { id: uid(), jobId, name: b.name, email: b.email, phone: b.phone, targetLocation: b.targetLocation, createdAt: now(), wa: newChannel(), em: newChannel() }; }
app.post('/api/candidates', (req, res) => { if (!req.body.name) return res.status(400).json({ error: 'name required' }); const c = mkCand(req.body.jobId, req.body); db.candidates.push(c); save(); res.json(c); });
app.post('/api/candidates/bulk', (req, res) => { const { jobId, rows } = req.body; let added = 0; (rows || []).forEach(r => { if (r.name) { db.candidates.push(mkCand(jobId, r)); added++; } }); save(); res.json({ added }); });
app.delete('/api/candidates/:id', (req, res) => { db.candidates = db.candidates.filter(c => c.id !== req.params.id); save(); res.json({ ok: true }); });

app.post('/api/run/:jobId', async (req, res) => { try { res.json(await runJob(req.params.jobId)); } catch (e) { res.status(400).json({ error: e.message }); } });
// Per-candidate outreach
app.post('/api/run-one/:candId', async (req, res) => { try { res.json(await runJobOne(req.params.candId)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/run-email-one/:candId', async (req, res) => { try { res.json(await runEmailOne(req.params.candId)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/flags/resolve', (req, res) => { const c = db.candidates.find(x => x.id === req.body.candId); const ch = c ? c[req.body.channel === 'em' ? 'em' : 'wa'] : null; if (ch && ch.flags[req.body.idx]) ch.flags[req.body.idx].resolved = true; save(); res.json({ ok: true }); });
// Manual recruiter reply into a conversation
app.post('/api/send', async (req, res) => {
  try {
    if (waStatus !== 'ready') throw new Error('WhatsApp not connected');
    const c = db.candidates.find(x => x.id === req.body.candId); if (!c) throw new Error('candidate not found');
    const to = c.wa.chatId || (normPhone(c.phone) + '@c.us');
    await client.sendMessage(to, req.body.text);
    c.wa.transcript.push({ from: 'system', text: req.body.text, ts: now(), manual: true }); save();
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

if (!process.env.RF_TEST) app.listen(PORT, () => log(`Dashboard running → http://localhost:${PORT}`));
