/**
 * Badge Scanner backend — bound to the "Event Leads" Google Sheet.
 *
 * Deploy: Extensions → Apps Script → paste this file → Deploy → New deployment
 *   → Web app → Execute as: Me → Who has access: Anyone → copy the /exec URL.
 *
 * Script Properties required (Project Settings → Script Properties):
 *   SHARED_SECRET      — must match CONFIG.SHARED_SECRET in the PWA's index.html
 *   ANTHROPIC_API_KEY  — for badge-photo field extraction (Claude Haiku vision)
 */

var HEADERS = [
  "First Name", "Last Name", "Title", "Company", "Email", "Phone",
  "LinkedIn URL", "Event", "Captured By", "Captured At", "Source",
  "Rep Note", "ICP Fit", "Why Relevant", "Push?", "HubSpot Status"
];
var RESERVED_TABS = ["TEMPLATE", "Config", "_sync"];
var HAIKU_MODEL = "claude-haiku-4-5-20251001";

function doGet(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureInfraTabs_(ss);
  var events = ss.getSheets()
    .map(function (s) { return s.getName(); })
    .filter(function (n) { return RESERVED_TABS.indexOf(n) === -1; });
  var reps = ss.getSheetByName("Config").getRange("A2:A50").getValues()
    .map(function (r) { return String(r[0]).trim(); })
    .filter(function (v) { return v; });
  return json_({ ok: true, events: events, reps: reps });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: "bad JSON" });
  }
  var secret = PropertiesService.getScriptProperties().getProperty("SHARED_SECRET");
  if (!secret || req.secret !== secret) {
    return json_({ ok: false, error: "unauthorized" });
  }
  try {
    if (req.action === "extract") return handleExtract_(req);
    if (req.action === "submit") return handleSubmit_(req);
    return json_({ ok: false, error: "unknown action" });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

// ---------- extract: badge photo → structured fields via Claude Haiku ----------

function handleExtract_(req) {
  if (!req.photoBase64) return json_({ ok: false, error: "no photo" });
  var fields = extractFromPhoto_(req.photoBase64);
  return json_({ ok: true, fields: fields });
}

function extractFromPhoto_(photoBase64) {
  var key = PropertiesService.getScriptProperties().getProperty("ANTHROPIC_API_KEY");
  if (!key) throw new Error("ANTHROPIC_API_KEY script property not set");
  var payload = {
    model: HAIKU_MODEL,
    max_tokens: 300,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: photoBase64 } },
        {
          type: "text",
          text: "This is a photo of a conference attendee badge. Extract the attendee's details " +
            "and the event/conference name printed on the badge. " +
            "Respond with ONLY a JSON object, no other text: " +
            '{"first_name":"","last_name":"","title":"","company":"","email":"","phone":"","event_name":""}. ' +
            "Use empty string for anything not visible. The largest text is usually the attendee name; " +
            "company names and job titles are usually below it. The event name is usually in the badge " +
            "header/footer or lanyard area (e.g. \"Q2B 2026\", \"Quantum.Tech World\"). Ignore sponsor logos."
        }
      ]
    }]
  };
  var resp = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
    method: "post",
    contentType: "application/json",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) {
    throw new Error("Anthropic API " + resp.getResponseCode() + ": " + resp.getContentText().slice(0, 300));
  }
  var text = JSON.parse(resp.getContentText()).content[0].text;
  var match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("no JSON in model response");
  var f = JSON.parse(match[0]);
  return {
    first_name: f.first_name || "", last_name: f.last_name || "",
    title: f.title || "", company: f.company || "",
    email: f.email || "", phone: f.phone || "",
    event_name: f.event_name || ""
  };
}

// ---------- submit: write one lead row ----------

function handleSubmit_(req) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureInfraTabs_(ss);
  var lead = req.lead || {};
  if (!req.uuid) return json_({ ok: false, error: "missing uuid" });
  var eventName = sanitizeEventName_(lead.event);
  if (!eventName) return json_({ ok: false, error: "missing event" });
  if (RESERVED_TABS.some(function (t) { return t.toLowerCase() === eventName.toLowerCase(); })) {
    return json_({ ok: false, error: "reserved tab name: " + eventName });
  }

  // Offline-captured photo lead: extract fields now, before taking the lock.
  var fields = lead.fields || {};
  if (req.photoBase64 && !fields.first_name && !fields.last_name) {
    try {
      fields = extractFromPhoto_(req.photoBase64);
    } catch (err) {
      fields.extractError = String(err); // still write the row; review gate catches it
    }
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sync = ss.getSheetByName("_sync");
    if (isDuplicate_(sync, req.uuid)) {
      return json_({ ok: true, duplicate: true });
    }
    var ws = ensureEventTab_(ss, eventName); // auto-creates the tab on first lead
    var row = firstEmptyRow_(ws);
    var note = composeRepNote_(lead, fields);
    ws.getRange(row, 1, 1, HEADERS.length).setValues([[
      fields.first_name || "", fields.last_name || "", fields.title || "",
      fields.company || "", fields.email || "", fields.phone || "",
      fields.linkedin || "", ws.getName(), lead.rep || "",
      lead.capturedAt || new Date().toISOString(), "badge", note,
      "", "", false, ""
    ]]);
    sync.appendRow([req.uuid, new Date().toISOString(), ws.getName(), row, lead.repEmail || ""]);
    return json_({ ok: true, row: row, event: ws.getName() });
  } finally {
    lock.releaseLock();
  }
}

// Reuse an existing tab (case-insensitive match) or create one by copying
// TEMPLATE so the Push? checkbox validation comes along. Callers must hold the lock.
function ensureEventTab_(ss, name) {
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getName().toLowerCase() === name.toLowerCase()) return sheets[i];
  }
  var tpl = ss.getSheetByName("TEMPLATE");
  if (tpl) {
    var ws = tpl.copyTo(ss);
    ws.setName(name);
    ws.showSheet();
    return ws;
  }
  var fresh = ss.insertSheet(name);
  fresh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight("bold");
  fresh.getRange(2, 15, 199, 1) // Push? checkbox column, rows 2-200 like setup_sheet.py
    .setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
  fresh.setFrozenRows(1);
  return fresh;
}

// Sheets tab names: max 100 chars, no [ ] * / \ ? :
function sanitizeEventName_(name) {
  return String(name || "").replace(/[\[\]\*\/\\\?:]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

function composeRepNote_(lead, fields) {
  var parts = [];
  if (lead.temperature) parts.push("[" + String(lead.temperature).toUpperCase() + "]");
  if (lead.followUp) parts.push("Next: " + lead.followUp);
  var head = parts.join(" ");
  var tail = [];
  if (lead.note) tail.push(lead.note);
  if (lead.badgeId) tail.push("badge-id:" + lead.badgeId);
  if (fields.extractError) tail.push("(photo extraction failed — check photo manually)");
  var body = tail.join(" | ");
  if (head && body) return head + " — " + body;
  return head || body;
}

// Never appendRow on event tabs: checkbox validation on O2:O200 makes appends
// jump past the validated range (the row-2001 bug, see setup_sheet.py).
// Scan all 16 columns for the first fully-empty row instead.
function firstEmptyRow_(ws) {
  var values = ws.getRange(2, 1, Math.max(ws.getLastRow(), 2), HEADERS.length).getValues();
  for (var i = 0; i < values.length; i++) {
    var empty = values[i].every(function (c) { return c === "" || c === false; });
    if (empty) return i + 2;
  }
  return values.length + 2;
}

function isDuplicate_(sync, uuid) {
  var last = sync.getLastRow();
  if (last < 1) return false;
  var uuids = sync.getRange(1, 1, last, 1).getValues();
  for (var i = 0; i < uuids.length; i++) {
    if (uuids[i][0] === uuid) return true;
  }
  return false;
}

function ensureInfraTabs_(ss) {
  if (!ss.getSheetByName("Config")) {
    var cfg = ss.insertSheet("Config");
    cfg.getRange("A1").setValue("Rep Name (must match rep_map.json)");
    cfg.getRange("A2").setValue("Matan Wisebitan");
  }
  if (!ss.getSheetByName("_sync")) {
    ss.insertSheet("_sync").hideSheet();
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
