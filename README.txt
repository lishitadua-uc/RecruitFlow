============================================================
 RecruitFlow — Recruitment Automation (WhatsApp + Email)
============================================================

WHAT IT DOES
  • Create jobs, add candidates (one-by-one or bulk CSV).
  • Sends automated outreach from YOUR OWN WhatsApp number and YOUR OWN email.
  • Auto-runs the full screening conversation (interest, location, work
    preference, experience, role, CTC, notice period, custom skill questions),
    then asks for availability.
  • When a candidate is scheduled, it can auto-create the call in your Google
    Calendar.
  • Live pipeline, responses dashboard, flagged-question list, Excel export.

------------------------------------------------------------
 HOW TO RUN IT (macOS)
------------------------------------------------------------
  1. Double-click  start.command
       (If macOS blocks it: right-click → Open → Open. Only needed once.)
  2. The first run installs everything automatically (~2-3 min, needs internet).
  3. A browser tab opens at  http://localhost:3000
  4. Keep the black Terminal window OPEN while you use RecruitFlow.
     Closing it stops the app. Re-open any time by double-clicking start.command.

------------------------------------------------------------
 WILL IT KEEP REPLYING WHEN MY SCREEN IS LOCKED?
------------------------------------------------------------
  YES. A locked screen (or a screen that turns off) does NOT stop RecruitFlow —
  candidates keep getting automated replies. RecruitFlow automatically keeps your
  Mac awake while it runs, so it never falls asleep and stops responding.

  Two things to keep in mind:
    • Keep the Terminal window open and the laptop plugged in (recommended).
    • Do NOT close the lid — closing the lid puts the Mac to sleep and pauses
      replies until you open it again. Just let the screen lock/dim; that's fine.
  When you wake the laptop, RecruitFlow catches up on any messages it missed.

------------------------------------------------------------
 FIRST-TIME SETUP INSIDE THE APP
------------------------------------------------------------
  WhatsApp:  Click the "WhatsApp" status at the top → scan the QR code with
             your phone (WhatsApp → Settings → Linked Devices → Link a Device).
             Uses YOUR number. (Note: automating a personal number is against
             WhatsApp's terms and can get it banned — keep volumes low.)

  Email:     Settings tab → enter your Gmail/Workspace address + a Google
             "App Password" (https://myaccount.google.com/apppasswords).
             Click "Send test email" to confirm.

  Calendar:  Settings tab → follow the 5 steps to create Google OAuth
             credentials, paste Client ID + Secret, click "Connect".

------------------------------------------------------------
 FOR THE TEAM
------------------------------------------------------------
  Each teammate runs their OWN copy (this folder) on their OWN laptop and
  links their OWN WhatsApp + email. Data is private to each person's machine.
  Share this folder (zipped) — but do NOT share the files:
      data.json, .wwebjs_auth/, server.log
  ...those contain your personal session and candidate data.

------------------------------------------------------------
 WINDOWS / LINUX
------------------------------------------------------------
  1. Install Node.js 22 from https://nodejs.org
  2. In this folder run:   npm install   then   npm start
  3. Open http://localhost:3000
============================================================
