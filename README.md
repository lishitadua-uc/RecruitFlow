# RecruitFlow — WhatsApp Recruitment Automation

Runs entirely on your own laptop. Sends automated outreach from **your own WhatsApp
number**, runs the full screening conversation (interest → location → experience →
CTC → notice → skill questions → resume → schedule a recruiter call), books the call
on your Google Calendar, and gives you a live dashboard of every candidate.

No server, no cloud, no login. Your data stays on your machine.

---

## ▶ How to run it (macOS — the easy way)

1. **Download the project**
   - On this page, click the green **`Code`** button → **`Download ZIP`**.
   - Unzip it (double-click the downloaded file).
2. Open the unzipped folder and start it. **The first time, do NOT just double-click** — macOS
   silently blocks downloaded scripts. Instead:
   - **Right-click** (or Control-click) `start.command` → **Open** → click **Open** again in the
     warning box. That one-time approval unblocks it; after that, double-click works forever.
   - If it opens in a text editor instead, right-click → **Open With → Terminal**.
   - Still stuck? Open **Terminal**, type `bash ` (with a space), drag `start.command` into the
     window, and press **Enter**. This always works.
3. The first run sets everything up (**~30–60s if Google Chrome is installed**; longer only if it
   has to download a browser). You'll see numbered steps `[1/4]…[4/4]`. A browser tab opens at
   **http://localhost:3000**.
4. **Keep the black Terminal window open** while you use it. Closing it stops the app —
   re-open any time by double-clicking `start.command` again.

> ⚠️ **Do not open `index.html` directly.** It's only the dashboard's shell and does nothing
> without the server running — you must start it via `start.command`.

You do **not** need Git or any AI tool to run this. (Chrome installed = fastest first run.)

---

## ▶ Windows (the easy way)

1. Install **Node.js 22+** from https://nodejs.org (download the **LTS** Windows Installer
   `.msi`, run it — takes a minute). *This one-time step is required; Windows can't auto-install it.*
2. Download the ZIP (green **`Code`** button → **Download ZIP**) and unzip it.
3. Open the unzipped folder and **double-click `start.bat`**.
   - First run installs everything automatically (~2–3 min) and opens **http://localhost:3000**.
   - If Windows SmartScreen warns, click **More info → Run anyway** (one time).
4. Keep the black window open while you use it. Re-open any time by double-clicking `start.bat`.

## ▶ Linux / manual (any OS)

1. Install **Node.js 22+** from https://nodejs.org
2. Download the ZIP (green **`Code`** button → **Download ZIP**) and unzip it — or clone:
   ```
   git clone https://github.com/lishitadua-uc/RecruitFlow.git
   cd RecruitFlow
   ```
3. In that folder run:
   ```
   npm install
   npm start
   ```
4. Open **http://localhost:3000**

---

## First-time setup inside the app

- **WhatsApp** — click the WhatsApp status at the top → scan the QR code with your phone
  (WhatsApp → Settings → Linked Devices → Link a Device). Uses **your** number.
  *(Note: automating a personal number is against WhatsApp's terms and can risk a ban —
  keep volumes low.)*
- **Google Calendar** *(optional)* — Settings tab → follow the steps to connect, so booked
  calls are added to your calendar and the candidate is invited automatically.
- **Email** *(optional, currently paused)* — Settings tab → add a Gmail address + Google
  App Password if you ever want manual email outreach.

---

## For the team

Each teammate runs their **own copy** on their **own laptop** and links their **own
WhatsApp**. Data is private to each machine — nothing is shared or uploaded.

The following are intentionally **not** in this repo (they're personal/local): your
`data.json`, WhatsApp session (`.wwebjs_auth/`), logs, and uploaded files. They're created
automatically on first run.

---

## Troubleshooting

- **"An AI tool can't open the GitHub link."** You don't need one. Use the green **Code →
  Download ZIP** button above, or `git clone`. The repo is public.
- **WhatsApp won't connect / shows a QR forever.** Re-scan from your phone. The app
  auto-recovers if the connection drops; if it's stuck, quit the Terminal window and
  double-click `start.command` again.
- **Browser tab didn't open.** Go to http://localhost:3000 manually.
- **Port 3000 already in use.** Another copy is already running — check your other Terminal
  windows / browser tabs before starting again.

See `CONVERSATION-FLOW.md` in this folder for exactly how the screening conversation works.
