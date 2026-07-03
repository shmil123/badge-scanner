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

- `webapp/` — the PWA (static, hosted on GitHub Pages)
- `apps-script/Code.gs` — the backend; **source of truth lives here**, pasted into the
  sheet-bound Apps Script project. If you edit Code.gs, re-paste and create a new deployment.

## One-time setup (Matan)

1. **Anthropic API key**: console.anthropic.com → API keys → create one (Haiku-only spend, cents per event).
2. **Apps Script**: open the Event Leads sheet → Extensions → Apps Script → paste `apps-script/Code.gs`
   → ⚙ Project Settings → Script Properties → add:
   - `SHARED_SECRET` = the value of `CONFIG.SHARED_SECRET` in `webapp/index.html`
   - `ANTHROPIC_API_KEY` = your key
   → Deploy → New deployment → Web app → *Execute as: Me* / *Who has access: **Anyone*** → authorize → copy the `/exec` URL.
   - If Workspace blocks "Anyone" access: deploy from a personal Gmail account that has edit access to the sheet.
3. Paste the `/exec` URL into `CONFIG.APPS_SCRIPT_URL` in `webapp/index.html`, bump `CACHE_VERSION` in `sw.js`, push.
4. **Config tab** (auto-created on first request): add each rep's display name in column A —
   names must match `event-leads/rep_map.json` keys so HubSpot owner assignment works at push time.

## Per event

1. In the sheet: duplicate the `TEMPLATE` tab → rename to the event name.
2. Print a booth poster QR pointing to `https://<pages-url>/?event=<Event%20Name>` — reps scan it,
   pick their name once, done. Tell them to open it **while on WiFi once** so the app caches for offline.
3. Add any new reps to the `Config` tab and `rep_map.json`.

## Rules for reps

- **Sync before leaving the venue each day** (red banner appears if leads sit unsynced >12h —
  iOS can evict site storage after ~7 days of not opening the page).
- Camera blocked? iPhone: aA menu → Website Settings → Camera → Allow. Or use **Type manually**.
- Blurry badge photo? Retake — the thumbnail on the form shows what the extractor sees.

## Known trade-offs

- The repo is public, so the Apps Script URL + shared secret are visible. Worst case is junk rows
  in a human-reviewed sheet — accepted.
- Badge QRs that contain only a registration ID can't be resolved without the organizer's paid
  lead-retrieval API; the raw ID is saved in Rep Note as `badge-id:<…>` so leads can be matched
  against the official scan export after the event.
- Never use `appendRow` on event tabs in Code.gs — the Push? checkbox validation (rows 2-200)
  makes appends jump to row 2001 (same bug documented in `event-leads/setup_sheet.py`).
