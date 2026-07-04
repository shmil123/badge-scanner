# Badge Scanner — booth lead capture on reps' phones

Events give us 2 official scanners; this app puts a scanner on every rep's phone.
Leads land in the existing **Event Leads** Google Sheet (per-event tab), then go
through the normal review → `/event-leads-push` → HubSpot flow. Nothing downstream changes.

**Flow per lead (~20 seconds):** Scan badge QR → if the QR has contact info it prefills;
if not, snap a photo of the badge and the details are extracted automatically →
pick Hot/Warm/Cold + follow-up action + optional note → Save. Works offline; syncs
when the phone gets signal.

## Architecture

```
Rep's phone (PWA on GitHub Pages)     Apps Script Web App (bound to sheet)     Event Leads sheet
 QR scan / badge photo / manual   →    secret check, UUID dedupe (_sync tab),   per-event tab, 16 cols,
 IndexedDB offline queue               Claude Haiku photo extraction,           Rep Note = "[HOT] Next: … — note"
                                       LockService + first-empty-row write      → /event-leads-push (unchanged)
```

- `docs/` — the PWA (static, hosted on GitHub Pages)
- `apps-script/Code.gs` — the backend; **source of truth lives here**, pasted into the
  sheet-bound Apps Script project. If you edit Code.gs, re-paste and create a new deployment.

## One-time setup (Matan)

See **[SETUP.md](SETUP.md)** for exact click-by-click steps: Anthropic API key, Apps Script
deployment + Script Properties, Google OAuth client ID (rep sign-in), GitHub Pages hosting.

**Rep identity**: reps sign in once with their @classiq.io Google account; their Google name
becomes Captured By (→ HubSpot owner at push time via `event-leads/rep_map.json` — keep names
in sync). If `CONFIG.GOOGLE_CLIENT_ID` is empty or sign-in fails, the app falls back to a name
dropdown fed from the sheet's `Config` tab.

## Per event

1. Nothing to pre-create — the event tab is auto-created (copy of `TEMPLATE`, so the Push?
   checkboxes come along) when the first lead arrives. Reps type the event name on first run or
   read it off a badge with the 📷 button; the `?event=` URL param pre-fills it.
2. Print a booth poster QR pointing to `https://<pages-url>/?event=<Event%20Name>` — reps scan it,
   sign in once, done. Tell them to open it **while on WiFi once** so the app caches for offline.
3. New reps: make sure their Google display name exists in `rep_map.json` for owner assignment.

## Rules for reps

- **Sync before leaving the venue each day** (red banner appears if leads sit unsynced >12h —
  iOS can evict site storage after ~7 days of not opening the page).
- Camera blocked? iPhone: aA menu → Website Settings → Camera → Allow. Or use **Type manually**.
- Blurry badge photo? Retake — the thumbnail on the form shows what the extractor sees.

## Security & privacy model

**Where lead data (PII) lives:**
- Reps' phones: IndexedDB, per device; synced leads auto-purge after 30 days; per-lead
  "Remove from this phone" + full "Clear all leads" available in the app.
- Google Sheet + Drive photos folder: under the Classiq Google account; access = sheet sharing.
- Anthropic API: badge photos are processed transiently for text extraction; API data is not
  used for model training by default.
- HubSpot: only rows Matan explicitly ticks Push? on.

**Auth model (and its honest limits):**
- Reps sign in with Google restricted to @classiq.io — this drives lead ownership/attribution.
  The ID token is checked client-side only; the backend trusts the shared secret, not the token.
- The shared secret + Apps Script URL are visible in this public repo. This is friction against
  bots, not real secrecy. Blast radius is bounded by: per-minute rate limits on every action,
  a payload size cap, human review before anything reaches HubSpot, and the API key/credentials
  living only in Script Properties (never in the client).
- Worst realistic abuse: junk rows in a human-reviewed sheet, or wasted Haiku cents up to the
  rate cap. Rotating: change `SHARED_SECRET` in Script Properties + CONFIG in index.html.

**Rep etiquette:** ask the attendee before photographing their badge — same consent norm as
the official event scanners. Badge data is business contact information collected for follow-up
they requested at the booth.

## Known trade-offs

- The repo is public, so the Apps Script URL + shared secret are visible. Worst case is junk rows
  in a human-reviewed sheet — accepted.
- Badge QRs that contain only a registration ID can't be resolved without the organizer's paid
  lead-retrieval API; the raw ID is saved in Rep Note as `badge-id:<…>` so leads can be matched
  against the official scan export after the event.
- Never use `appendRow` on event tabs in Code.gs — the Push? checkbox validation (rows 2-200)
  makes appends jump to row 2001 (same bug documented in `event-leads/setup_sheet.py`).
