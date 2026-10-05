let CONFIG = {};
let lastRows = [];

const $ = id => document.getElementById(id);


/*
 * ---------------------------------------------------------
 * TOAST
 * ---------------------------------------------------------
 */

function toast(message) {
  const el = $("toast");

  el.textContent = message;

  el.classList.add("show");

  setTimeout(
    () => el.classList.remove("show"),
    3200
  );
}


/*
 * ---------------------------------------------------------
 * API
 * ---------------------------------------------------------
 */

async function api(url, options = {}) {

  const r = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });

  const data =
    await r.json().catch(() => ({}));

  if (!r.ok) {
    throw new Error(
      data.error ||
      `HTTP ${r.status}`
    );
  }

  return data;
}


/*
 * ---------------------------------------------------------
 * NAVIGATION
 * ---------------------------------------------------------
 */

function showSection(name) {

  document
    .querySelectorAll(".section")
    .forEach(x =>
      x.classList.remove("active")
    );

  document
    .querySelectorAll(".nav")
    .forEach(x =>
      x.classList.remove("active")
    );

  $(name).classList.add("active");

  document
    .querySelector(
      `.nav[data-section="${name}"]`
    )
    ?.classList.add("active");
}

window.showSection =
  showSection;


document
  .querySelectorAll(".nav")
  .forEach(btn =>
    btn.addEventListener(
      "click",
      () =>
        showSection(
          btn.dataset.section
        )
    )
  );


/*
 * ---------------------------------------------------------
 * CONFIGURATION
 * ---------------------------------------------------------
 */

async function loadConfig() {

  CONFIG =
    await api("/api/config");

  const fields = [
    "serverUrl",
    "organization",
    "organizationId",
    "cabinetId",
    "applicationId",
    "redirectUrl",
    "authorizationUrl",
    "tokenUrl",
    "scope",
    "apiBasePath"
  ];

  fields.forEach(k => {

    if ($(k)) {
      $(k).value =
        CONFIG[k] ?? "";
    }

  });

  /*
   * Never put the client secret
   * into the browser.
   */
  $("clientSecret").value = "";

  renderSnapshot();
}


function renderSnapshot() {

  const items = [

    [
      "Server",
      CONFIG.serverUrl
    ],

    [
      "Organization",
      CONFIG.organization
    ],

    [
      "Cabinet ID",
      CONFIG.cabinetId
    ],

    [
      "Application ID",
      CONFIG.applicationId
    ],

    [
      "Redirect URL",
      CONFIG.redirectUrl
    ],

    [
      "Client secret",
      CONFIG.hasClientSecret
        ? "•••••••• saved"
        : "Not configured"
    ]
  ];

  $("snapshot").innerHTML =
    items
      .map(
        ([a, b]) =>
          `<div>
            <span>${esc(a)}</span>
            <span title="${esc(b)}">
              ${esc(b || "—")}
            </span>
          </div>`
      )
      .join("");

  $("cabinetShort").textContent =
    CONFIG.cabinetId
      ? CONFIG.cabinetId.slice(0, 8) +
        "…"
      : "—";

  $("cabinetHint").textContent =
    CONFIG.organization ||
    "Configured cabinet";
}


async function saveConfig() {

  const payload = {};

  [
    "serverUrl",
    "organization",
    "organizationId",
    "cabinetId",
    "applicationId",
    "clientSecret",
    "redirectUrl",
    "authorizationUrl",
    "tokenUrl",
    "scope",
    "apiBasePath"
  ]
    .forEach(
      k =>
        payload[k] =
          $(k).value
    );

  const r =
    await api(
      "/api/config",
      {
        method: "PUT",
        body:
          JSON.stringify(payload)
      }
    );

  CONFIG = r.config;

  renderSnapshot();

  toast(
    "Configuration saved on the server."
  );
}


/*
 * ---------------------------------------------------------
 * CONNECTION TEST
 * ---------------------------------------------------------
 */

async function testConnection() {

  $("testBtn").disabled = true;

  $("testBtn").textContent =
    "Testing…";

  try {

    const r =
      await api("/api/status");

    renderStatus(r);

    $("lastTest").textContent =
      new Date()
        .toLocaleTimeString();

    $("lastTestHint").textContent =
      r.ok
        ? "Platform reachable"
        : "Check diagnostics";

    toast(
      r.ok
        ? "DocuWare platform test succeeded."
        : "Connection test found an issue."
    );

  } catch (e) {

    toast(e.message);

  } finally {

    $("testBtn").disabled = false;

    $("testBtn").textContent =
      "Test connection";
  }
}


function renderStatus(r) {

  const ok =
    Boolean(
      r.ok &&
      r.authenticated
    );

  $("statusText").textContent =
    ok
      ? "Connected"
      : (
          r.ok
            ? "Server reachable"
            : "Not connected"
        );

  $("statusDot")
    .classList
    .toggle(
      "ok",
      r.ok
    );

  $("sideDot")
    .classList
    .toggle(
      "ok",
      r.authenticated
    );

  $("sideStatus").textContent =
    r.authenticated
      ? "Connected"
      : "Disconnected";

  $("tokenState").textContent =
    r.authenticated
      ? "Active"
      : "None";

  $("tokenExpiry").textContent =
    r.tokenExpiresAt
      ? `Expires ${new Date(
          r.tokenExpiresAt
        ).toLocaleTimeString()}`
      : "Authentication state";

  $("checks")
    .classList
    .remove("empty");

  $("checks").innerHTML =
    r.checks
      .map(
        c =>
          `
          <div class="check ${
            c.ok ? "" : "bad"
          }">

            <div class="mark">
              ${c.ok ? "✓" : "!"}
            </div>

            <div>
              <b>${esc(c.name)}</b>

              <small>
                ${esc(
                  c.ok
                    ? `HTTP ${c.status} · ${c.ms} ms`
                    : (
                        c.error ||
                        "Failed"
                      )
                )}
              </small>
            </div>

          </div>
          `
      )
      .join("");
}


/*
 * ---------------------------------------------------------
 * FETCH DOCUMENTS
 * ---------------------------------------------------------
 */

async function fetchDocuments() {

  $("fetchBtn").disabled = true;

  $("fetchBtn").textContent =
    "Fetching…";

  try {

    const r =
      await api(
        "/api/documents?limit=10000"
      );

    lastRows =
      normalizeDocuments(
        r.data
      );

    renderTable(
      lastRows
    );

    $("docCount").textContent =
      lastRows.length;

    $("docHint").textContent =
      "Rows returned by API";

    toast(
      `Loaded ${lastRows.length} document rows.`
    );

    showSection(
      "documents"
    );

  } catch (e) {

    toast(e.message);

  } finally {

    $("fetchBtn").disabled =
      false;

    $("fetchBtn").textContent =
      "Fetch data";
  }
}


/*
 * ---------------------------------------------------------
 * NORMALIZE DOCUMENT DATA
 * ---------------------------------------------------------
 */

function normalizeDocuments(data) {

  let rows =
    data?.Items ||
    data?.items ||
    data?.Documents ||
    data?.documents ||
    data?.Data ||
    [];

  if (!Array.isArray(rows)) {

    rows =
      Array.isArray(data)
        ? data
        : [data];
  }

  return rows.map(x => {

    const out = {};

    /*
     * Preserve document ID.
     */
    if (x.Id !== undefined) {
      out.Id = x.Id;
    }

    if (x.Title !== undefined) {
      out.Title = x.Title;
    }

    if (x.FileName !== undefined) {
      out.FileName = x.FileName;
    }

    if (x.CreatedAt !== undefined) {
      out.CreatedAt =
        x.CreatedAt;
    }

    /*
     * Keep Sections if available.
     *
     * This can be useful later for
     * thumbnails/section handling.
     */
    if (
      Array.isArray(x.Sections)
    ) {
      out.Sections =
        x.Sections;
    }

    if (
      x.Fields &&
      Array.isArray(x.Fields)
    ) {

      x.Fields.forEach(f => {

        out[
          f.FieldName ||
          f.name ||
          "Field"
        ] =
          f.Item ??
          f.Value ??
          "";

      });
    }

    Object.keys(x).forEach(k => {

      if (
        typeof x[k] !== "object" &&
        out[k] === undefined
      ) {
        out[k] = x[k];
      }

    });

    return out;
  });
}


/*
 * ---------------------------------------------------------
 * DOCUMENT TABLE
 * ---------------------------------------------------------
 */

function renderTable(rows) {

  const cols =
    [
      ...new Set(
        rows.flatMap(
          r =>
            Object.keys(r)
        )
      )
    ]
      .filter(
        c =>
          c !== "Sections"
      )
      .slice(0, 18);

  $("thead").innerHTML =
    `
    <tr>
      ${cols
        .map(
          c =>
            `<th>${esc(c)}</th>`
        )
        .join("")}
    </tr>
    `;

  if (!rows.length) {

    $("tbody").innerHTML =
      `
      <tr>
        <td
          class="empty"
          colspan="10"
        >
          No documents returned.
        </td>
      </tr>
      `;

    $("rowCount").textContent =
      "0 rows";

    return;
  }

  /*
   * IMPORTANT:
   *
   * Each row gets:
   * data-document-id="..."
   *
   * Then clicking the row calls
   * openDocument().
   */
  $("tbody").innerHTML =
    rows
      .map(
        (r, index) => {

          const documentId =
            getDocumentId(r);

          return `
            <tr
              class="document-row ${
                documentId
                  ? "clickable"
                  : ""
              }"
              ${
                documentId
                  ? `data-document-id="${esc(
                      documentId
                    )}"`
                  : ""
              }
              title="${
                documentId
                  ? "Click to open document"
                  : "Document ID not available"
              }"
            >

              ${cols
                .map(
                  c =>
                    `
                    <td
                      title="${esc(
                        format(
                          r[c]
                        )
                      )}"
                    >
                      ${esc(
                        format(
                          r[c]
                        )
                      )}
                    </td>
                    `
                )
                .join("")}

            </tr>
          `;
        }
      )
      .join("");

  /*
   * Attach click events after
   * rendering the table.
   */
  document
    .querySelectorAll(
      "#tbody tr.document-row"
    )
    .forEach(row => {

      row.addEventListener(
        "click",
        () => {

          const id =
            row.dataset.documentId;

          if (!id) {

            toast(
              "This document does not have a DocuWare ID."
            );

            return;
          }

          openDocument(id);
        }
      );

    });

  $("rowCount").textContent =
    `${rows.length} rows`;
}


/*
 * ---------------------------------------------------------
 * GET DOCUMENT ID
 * ---------------------------------------------------------
 */

function getDocumentId(row) {

  return (
    row?.Id ??
    row?.ID ??
    row?.DocId ??
    row?.DocID ??
    row?.DocumentId ??
    row?.DocumentID ??
    ""
  );
}


/*
 * ---------------------------------------------------------
 * OPEN DOCUMENT
 * ---------------------------------------------------------
 *
 * This opens the actual file in a
 * new browser tab.
 */

function openDocument(documentId) {

  if (!documentId) {

    toast(
      "Document ID is missing."
    );

    return;
  }

  /*
   * Use targetFileType=pdf so that
   * DocuWare can return a PDF where
   * supported.
   */
  const url =
    `/api/document/${encodeURIComponent(
      documentId
    )}/file?targetFileType=pdf&keepAnnotations=true`;

  /*
   * Open immediately so browser
   * popup blockers do not prevent it.
   */
  const newWindow =
    window.open(
      url,
      "_blank"
    );

  if (!newWindow) {

    toast(
      "Your browser blocked the document window. Please allow pop-ups for this site."
    );

    return;
  }

  toast(
    "Opening document…"
  );
}


/*
 * Make it available to the browser
 * if you want to call it elsewhere.
 */
window.openDocument =
  openDocument;


/*
 * ---------------------------------------------------------
 * FORMAT
 * ---------------------------------------------------------
 */

function format(v) {

  if (v == null) {
    return "";
  }

  if (
    typeof v === "object"
  ) {
    return JSON.stringify(v);
  }

  return String(v);
}


/*
 * ---------------------------------------------------------
 * HTML ESCAPE
 * ---------------------------------------------------------
 */

function esc(v) {

  return String(
    v ?? ""
  ).replace(
    /[&<>"']/g,
    c =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[c])
  );
}


/*
 * ---------------------------------------------------------
 * CONNECT DOCUWARE
 * ---------------------------------------------------------
 */

function connectDocuWare() {

  if (
    !CONFIG.authorizationUrl ||
    !CONFIG.applicationId ||
    !CONFIG.redirectUrl
  ) {

    showSection(
      "connection"
    );

    toast(
      "Enter the OAuth authorization URL, Application ID and Redirect URL first."
    );

    return;
  }

  window.open(
    "/oauth/start",
    "_blank",
    "width=900,height=800"
  );
}


/*
 * ---------------------------------------------------------
 * RAW API
 * ---------------------------------------------------------
 */

async function rawRequest() {

  try {

    const r =
      await api(
        "/api/raw?path=" +
        encodeURIComponent(
          $("rawPath").value
        )
      );

    $("rawOutput").textContent =
      JSON.stringify(
        r.data,
        null,
        2
      );

  } catch (e) {

    $("rawOutput").textContent =
      e.message;
  }
}


/*
 * ---------------------------------------------------------
 * EVENTS
 * ---------------------------------------------------------
 */

$("saveConfigBtn")
  .addEventListener(
    "click",
    () =>
      saveConfig()
        .catch(
          e =>
            toast(
              e.message
            )
        )
  );


$("loadConfigBtn")
  .addEventListener(
    "click",
    () =>
      loadConfig()
        .catch(
          e =>
            toast(
              e.message
            )
        )
  );


$("testBtn")
  .addEventListener(
    "click",
    testConnection
  );


$("refreshBtn")
  .addEventListener(
    "click",
    () => {

      loadConfig()
        .then(
          testConnection
        )
        .catch(
          e =>
            toast(
              e.message
            )
        );

    }
  );


$("fetchBtn")
  .addEventListener(
    "click",
    fetchDocuments
  );


$("rawBtn")
  .addEventListener(
    "click",
    rawRequest
  );


$("filter")
  .addEventListener(
    "input",
    e => {

      const q =
        e.target.value
          .toLowerCase();

      renderTable(
        lastRows.filter(
          r =>
            JSON.stringify(
              r
            )
              .toLowerCase()
              .includes(q)
        )
      );

    }
  );


$("year").textContent =
  new Date()
    .getFullYear();


/*
 * ---------------------------------------------------------
 * INITIAL LOAD
 * ---------------------------------------------------------
 */

loadConfig()
  .catch(
    e =>
      toast(
        e.message
      )
  );