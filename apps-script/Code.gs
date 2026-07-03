/**
 * Badge Scanner backend — bound to the "Event Leads" Google Sheet.
 *
 * Deploy: Extensions → Apps Script → paste this file → Deploy → New deployment
 *   → Web app → Execute as: Me → Who has access: Anyone → copy the /exec URL.
 * After edits: Deploy → Manage deployments → pencil → Version: New version → Deploy.
 *
 * Script Properties required (Project Settings → Script Properties):
 *   SHARED_SECRET      — must match CONFIG.SHARED_SECRET in the PWA's index.html
 *   ANTHROPIC_API_KEY  — for badge-photo field extraction (Claude Haiku vision)
 */

var HEADERS = [
  "First Name", "Last Name", "Title", "Company", "Email", "Phone",
  "LinkedIn URL", "Event", "Captured By", "Captured At", "Source",
  "Rep Note", "Temperature", "Follow-up", "ICP Fit", "Why Relevant",
  "Push?", "HubSpot Status", "Badge Photo"
];
var PUSH_COL = 17; // "Push?" checkbox column (Q)
var RESERVED_TABS = ["TEMPLATE", "Config", "_sync"];
var HAIKU_MODEL = "claude-haiku-4-5-20251001";
var PHOTO_FOLDER = "Badge Scanner Photos";

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

// ---------- submit: create or update one lead row (upsert by uuid) ----------

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

  var fields = lead.fields || {};
  var photoUrl = "";

  // New photo lead with no typed name: extract in the background (this call IS the
  // background — the rep already saved and moved on). Keep this outside the lock.
  var sync = ss.getSheetByName("_sync");
  var existing = findUuid_(sync, req.uuid);
  if (!existing && req.photoBase64 && !fields.first_name && !fields.last_name) {
    try {
      var extracted = extractFromPhoto_(req.photoBase64);
      fields.first_name = extracted.first_name; fields.last_name = extracted.last_name;
      fields.title = extracted.title; fields.company = extracted.company;
      fields.email = fields.email || extracted.email; fields.phone = fields.phone || extracted.phone;
      if (!extracted.first_name && !extracted.last_name && !extracted.company) {
        photoUrl = savePhotoToDrive_(req.uuid, req.photoBase64); // unreadable — keep the photo
        fields.extractError = "nothing recognizable";
      }
    } catch (err) {
      photoUrl = savePhotoToDrive_(req.uuid, req.photoBase64);
      fields.extractError = String(err);
    }
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    existing = findUuid_(sync, req.uuid); // re-check under the lock
    if (existing) {
      return updateRow_(ss, existing, lead, fields);
    }
    var ws = ensureEventTab_(ss, eventName);
    migrateTab_(ws);
    var row = firstEmptyRow_(ws);
    ws.getRange(row, 1, 1, HEADERS.length).setValues([[
      fields.first_name || "", fields.last_name || "", fields.title || "",
      fields.company || "", fields.email || "", fields.phone || "",
      fields.linkedin || "", ws.getName(), lead.rep || "",
      lead.capturedAt || new Date().toISOString(), "badge",
      composeRepNote_(lead, fields),
      lead.temperature || "", lead.followUp || "",
      "", "", false, "", photoUrl
    ]]);
    sync.appendRow([req.uuid, new Date().toISOString(), ws.getName(), row, lead.repEmail || ""]);
    return json_({ ok: true, row: row, event: ws.getName(), fields: publicFields_(fields) });
  } finally {
    lock.releaseLock();
  }
}

// Later edits from the app update the same row. Non-empty incoming values win;
// empty incoming values never blank out data already in the sheet. Review-owned
// columns (ICP Fit, Why Relevant, Push?, HubSpot Status, Badge Photo) are untouched.
function updateRow_(ss, existing, lead, fields) {
  var ws = ss.getSheetByName(existing.tab);
  if (!ws) return json_({ ok: false, error: "tab gone: " + existing.tab });
  migrateTab_(ws);
  var row = existing.row;
  var cur = ws.getRange(row, 1, 1, HEADERS.length).getValues()[0];
  var merged = {
    first_name: fields.first_name || cur[0], last_name: fields.last_name || cur[1],
    title: fields.title || cur[2], company: fields.company || cur[3],
    email: fields.email || cur[4], phone: fields.phone || cur[5],
    linkedin: fields.linkedin || cur[6]
  };
  ws.getRange(row, 1, 1, 7).setValues([[
    merged.first_name, merged.last_name, merged.title,
    merged.company, merged.email, merged.phone, merged.linkedin
  ]]);
  ws.getRange(row, 12, 1, 3).setValues([[
    composeRepNote_(lead, fields), lead.temperature || cur[12], lead.followUp || cur[13]
  ]]);
  return json_({ ok: true, row: row, event: existing.tab, updated: true, fields: merged });
}

function composeRepNote_(lead, fields) {
  var parts = [];
  if (lead.note) parts.push(lead.note);
  if (lead.badgeId) parts.push("badge-id:" + lead.badgeId);
  if (fields.extractError) parts.push("(photo not readable — see Badge Photo column)");
  return parts.join(" | ");
}

function publicFields_(fields) {
  return {
    first_name: fields.first_name || "", last_name: fields.last_name || "",
    title: fields.title || "", company: fields.company || "",
    email: fields.email || "", phone: fields.phone || "",
    linkedin: fields.linkedin || ""
  };
}

function savePhotoToDrive_(uuid, photoBase64) {
  var it = DriveApp.getFoldersByName(PHOTO_FOLDER);
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder(PHOTO_FOLDER);
  var blob = Utilities.newBlob(Utilities.base64Decode(photoBase64), "image/jpeg", uuid + ".jpg");
  return folder.createFile(blob).getUrl();
}

// ---------- sheet plumbing ----------

// Reuse an existing tab (case-insensitive match) or create one by copying
// TEMPLATE if present. Callers must hold the lock.
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
  fresh.getRange(2, PUSH_COL, 199, 1) // Push? checkboxes, rows 2-200 like setup_sheet.py
    .setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
  fresh.setFrozenRows(1);
  return fresh;
}

// Upgrade tabs from the original 16-column layout: insert Temperature/Follow-up
// after Rep Note (existing checkbox validation shifts along automatically) and
// add the Badge Photo column at the end. Safe to call repeatedly.
function migrateTab_(ws) {
  var head = ws.getRange(1, 1, 1, Math.max(ws.getLastColumn(), 1)).getValues()[0];
  if (head[12] !== "Temperature") {
    ws.insertColumnsAfter(12, 2);
    ws.getRange(1, 13, 1, 2).setValues([["Temperature", "Follow-up"]]).setFontWeight("bold");
    head = ws.getRange(1, 1, 1, ws.getLastColumn()).getValues()[0];
  }
  if (head[HEADERS.length - 1] !== "Badge Photo") {
    ws.getRange(1, HEADERS.length).setValue("Badge Photo").setFontWeight("bold");
  }
}

// Never appendRow on event tabs: checkbox validation makes appends jump past
// the validated range (the row-2001 bug, see setup_sheet.py).
function firstEmptyRow_(ws) {
  var values = ws.getRange(2, 1, Math.max(ws.getLastRow(), 2), HEADERS.length).getValues();
  for (var i = 0; i < values.length; i++) {
    var empty = values[i].every(function (c) { return c === "" || c === false; });
    if (empty) return i + 2;
  }
  return values.length + 2;
}

// _sync ledger: uuid | timestamp | event tab | row | rep email
function findUuid_(sync, uuid) {
  var last = sync.getLastRow();
  if (last < 1) return null;
  var rows = sync.getRange(1, 1, last, 4).getValues();
  for (var i = 0; i < rows.length; i++) {
    if (rows[i][0] === uuid) return { tab: String(rows[i][2]), row: Number(rows[i][3]) };
  }
  return null;
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

function sanitizeEventName_(name) {
  return String(name || "").replace(/[\[\]\*\/\\\?:]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

// Run this once from the editor (▶) to trigger the Drive permission prompt —
// underscore-suffixed functions are hidden from the Run menu, this one isn't.
function authorizeDrive() { DriveApp.getRootFolder(); }
