# SETUP — exact steps, in order

Four blocks. A and B are required. C enables Google sign-in for reps. D is the app hosting.
Blocks A–C are yours (browser logins I can't do); block D we do together in Claude Code.

---

## A. Anthropic API key (2 min)

1. Go to **console.anthropic.com** and sign in (create an account if needed).
2. Left sidebar → **API keys** → **Create key**.
3. Name it `badge-scanner`, click **Create**, and **copy the key now** (starts with `sk-ant-`) — it's shown only once. Keep it for step B5.

Cost: badge-photo reading uses the cheapest model (Haiku) — expect well under $1 per event.

## B. Apps Script backend (5 min)

1. Open the **Event Leads** Google Sheet (the one the booth-leads flow already uses).
2. Menu: **Extensions → Apps Script**. A code editor opens in a new tab with a file called `Code.gs` containing `function myFunction() {}`.
3. **Delete everything** in that editor, then paste the full contents of
   [`apps-script/Code.gs`](apps-script/Code.gs) from this folder. Press **⌘S** to save.
4. Left sidebar → click the **gear icon (Project Settings)**.
5. Scroll to **Script Properties** → **Add script property**, and add these two rows:
   | Property | Value |
   |---|---|
   | `SHARED_SECRET` | `1947e1791e7f84ea245333a424e8e6fb` |
   | `ANTHROPIC_API_KEY` | the `sk-ant-…` key from block A |
   Click **Save script properties**.
6. Top right: **Deploy → New deployment**.
7. Click the **gear next to "Select type"** → choose **Web app**.
8. Fill in:
   - Description: `badge scanner`
   - Execute as: **Me (matanw@classiq.io)**
   - Who has access: **Anyone**  ← must be exactly "Anyone", not "Anyone with a Google account"
9. Click **Deploy**. Google will ask you to authorize: pick your account → if you see
   *"Google hasn't verified this app"* click **Advanced → Go to badge scanner (unsafe)** → **Allow**.
   (It's your own script; this warning is normal.)
10. Copy the **Web app URL** (ends in `/exec`) and **paste it to me in Claude Code**.

> **If "Anyone" is not offered** (Workspace policy): do B1–B10 from a personal Gmail account
> instead — first share the Event Leads sheet with that account as **Editor**, then open the sheet
> from that account and repeat from step 2. Tell me if you hit this.

> **If you later change Code.gs**: paste the new version, then **Deploy → Manage deployments →
> pencil icon → Version: New version → Deploy**. (Just saving is NOT enough.)

## C. Google sign-in for reps (5 min — needs the app URL from block D first)

This is what lets reps log in with their @classiq.io account so leads are stamped with the right owner.
**Do this after block D**, when I've given you the app's `https://….github.io/…` URL.

1. Go to **console.cloud.google.com** signed in as matanw@classiq.io.
2. Top bar → project picker → **New project** → name: `badge-scanner` → **Create**, then make sure it's selected.
3. Left menu: **APIs & Services → OAuth consent screen** (may appear as "Google Auth Platform").
   - App name: `Classiq Badge Scanner`; support email: your email.
   - **User type / Audience: Internal** (this restricts sign-in to classiq.io accounts). Save through the steps — no scopes needed.
4. **APIs & Services → Credentials → + Create credentials → OAuth client ID**:
   - Application type: **Web application**
   - Name: `badge-scanner-web`
   - **Authorized JavaScript origins** → Add URI: `https://<username>.github.io`  ← I'll give you the exact value
   - Click **Create**.
5. Copy the **Client ID** (looks like `1234…apps.googleusercontent.com`) and **paste it to me** —
   I'll put it in the app's CONFIG and redeploy.

Until C is done the app simply shows a name dropdown instead of the Google button — it works either way.

## D. App hosting on GitHub Pages (3 min of yours)

1. In a terminal run: `~/bin/gh auth login`
   - GitHub.com → HTTPS → **Login with a web browser** → follow the browser flow.
   - No GitHub account? Create a free one at github.com first (any username).
2. Tell me when done — I'll create the repo, publish the app, wire in the `/exec` URL from block B,
   smoke-test everything, and hand you the app link + a printable booth poster QR.

## E. Lead Type + enrichment update (one-time — for the v14 schema change)

The app now captures a **Lead Type** and the sheet gained **Country / State / Company URL**
(ZoomInfo-filled at push). Three one-time steps:

1. **Re-deploy Code.gs** — paste the updated [`apps-script/Code.gs`](apps-script/Code.gs) and ship a
   new version (see the "If you later change Code.gs" note in block B). Existing event tabs
   auto-upgrade to the 21-column schema on the next lead; the app is already on `v14`.
2. **Refresh the TEMPLATE tab** — from `event-leads/` run `python setup_sheet.py` once so new event
   tabs start with all 21 columns.
3. **HubSpot `lead_type__c`** — in Settings → Properties → the "Lead Type" (`lead_type__c`) contact
   property, add the options **`Sales`** and **`Other`** (Partnership→`Partner` and
   Academia→`Academic/Research` already exist). Without these, those two values are flagged at push
   instead of set.

---

## After setup — per event checklist (this is all that's left each time)

1. **Pre-create the event tab**: duplicate `TEMPLATE`, rename it to the event. Reps then pick that
   one canonical name (chips/autocomplete) instead of inventing variants; typing a genuinely new
   name now asks for confirmation first. (If you skip this, the tab is still auto-created on the
   first lead.)
2. Optional: print a poster QR for `https://<app-url>/?event=<Event%20Name>` so reps skip typing.
3. New rep? If Google sign-in is on, nothing to do in the app — just make sure their name
   (as it appears in Google) exists in `event-leads/rep_map.json` so the HubSpot push assigns them as owner.
