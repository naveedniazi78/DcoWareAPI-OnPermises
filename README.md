# DocuWare On-Premises Dashboard

A ready-to-run Node.js + HTML dashboard for an on-premises DocuWare Platform API integration.

## Included

- Editable DocuWare server, organization, cabinet, application/client ID and redirect URL
- Editable OAuth authorization/token endpoints
- Server-side client secret storage (never sent back to the browser)
- OAuth Authorization Code callback
- Test connection
- File cabinet test
- Fetch documents
- Search/filter document rows
- Raw API diagnostic request
- Modern responsive dashboard
- **Scanning new documents** page: pick a target File Cabinet, capture pages with a webcam/document camera (combined into one PDF) or upload local files, fill in the File Cabinet's index fields, and store the document(s) — see below

## Scanning new documents

A new "Scanning New Documents" page was added:

1. **Select target File Cabinet** — reuses the same `/api/cabinets` list as the Documents page.
2. **Get the document** — either:
   - **Scan with camera / document scanner**: opens a webcam/USB document-camera feed in the browser, lets you capture one or more pages, then combines them client-side into a single PDF (via jsPDF, loaded from a CDN at runtime). Browsers cannot drive a TWAIN/WIA scanner driver directly, so if you have a real desktop scanner, scan to a file with its own software first and use...
   - **Upload local file**: pick one or more PDF/image files already on disk (e.g. produced by your scanner software).
3. **Manual indexing** — "Load index fields" calls the File Cabinet's Store dialog (`GET /FileCabinets/{id}/Dialogs`, then `GET /FileCabinets/{id}/Dialogs/{dialogId}`) and builds a form from the returned index fields (required fields marked with `*`). Table-type fields are flagged as unsupported here and should be indexed afterwards in DocuWare.
4. **Save to File Cabinet** — uploads the file(s) to the server (in memory, never written to disk) and, for each file:
   - `POST /FileCabinets/{id}/Documents` with the raw file bytes to create the document
   - `PUT /FileCabinets/{id}/Documents/{docId}/Fields` with `{"Field":[{"FieldName":...,"Item":...,"ItemElementName":...}]}` to write the index values

If more than one file is attached (any mix of scanned PDFs and uploaded PDFs/images), they are automatically merged in the browser (via pdf-lib) into a single multi-page PDF before upload, so a multi-file selection is always stored as **one** document. Existing PDF pages are copied as-is; images are rasterized to JPEG pages.

**Note:** DocuWare's Dialog JSON shape can differ slightly between on-premises versions and DocuWare Cloud. If field labels/types don't come through as expected for your tenant, check the raw response via the Diagnostics page (`/api/raw?path=/FileCabinets/{id}/Dialogs/{dialogId}`) and adjust `normalizeDialogFields()` in `server.js` accordingly.

## Your supplied defaults

- Server: `https://presentationvm/DocuWare`
- Organization: `Peters Engineering`
- File Cabinet: `9bd71bc-776f-4385-9517-f541058ebd0d`
- Application/Client ID: `a4f87abc-4248-0cab-b3e0-d9bafa8abfc8`
- Default redirect URL: `http://localhost:3000/oauth/callback`

## Requirements

- Windows Server or another on-premises host
- Node.js 18 or newer
- Network access from the dashboard server to DocuWare
- A DocuWare App Registration configured for your application

## Install

1. Extract the ZIP.
2. Open PowerShell/Command Prompt in the project directory.
3. Run:

   `npm install`

4. Start:

   `npm start`

5. Open:

   `http://localhost:3000`

   You'll land on a login page first — see below.

## Deploy to Vercel

The root-level `vercel.json` builds `server.js` as a Node.js function, routes
all application paths to Express, and includes the `public/` dashboard assets
in the function bundle. Import the repository into Vercel with the project root
as the Root Directory. Do not set an Output Directory or a separate Build
Command; Vercel uses the checked-in deployment configuration.

Before deploying, add these environment variables in the Vercel project
settings:

- `DASHBOARD_USERNAME` and `DASHBOARD_PASSWORD` — set a strong initial login.
- `DOCUWARE_CLIENT_SECRET` — the DocuWare App Registration client secret.
- `DOCUWARE_REDIRECT_URL` — `https://<your-vercel-domain>/oauth/callback`.

Add the exact `DOCUWARE_REDIRECT_URL` value to the DocuWare App Registration.
Keep secrets in Vercel environment variables rather than committing them to
the repository.

**Vercel runtime limitations:** Vercel's function filesystem is temporary.
The app uses `/tmp` there so it can start, but login users, dashboard settings,
sessions, OAuth state, and DocuWare tokens are not durable or shared between
function instances. They can be lost after a cold start or differ between
requests. The admin page and DocuWare connection therefore are not reliable
for production on Vercel without moving this state to persistent shared
storage. Also, Vercel Functions have request-body limits; this app's local
75 MB document-upload limit cannot be assumed to work for large uploads on
Vercel. Use the on-premises deployment or redesign document uploads for
Vercel before relying on scanning/uploading there.

## Dashboard login

The whole dashboard (pages and API) is protected by a styled login page, backed by a session cookie — no more browser Basic Auth popup.

- Default: **username** `niazi`, **password** `123`
- These defaults are only used the very first time the server starts (to create `data/users.json`). After that, `data/users.json` is the source of truth.
- The env vars `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` only seed that first-run default — they have no effect once `data/users.json` already exists.
- Sign in and open **Manage login** (link at the bottom of the sidebar, or go to `/admin` directly) to:
  - Change your own username/password (confirmed with your current password)
  - **Add new users** — each with their own username and password
  - **Remove users** — the app always keeps at least one account so nobody gets locked out
- Passwords are stored hashed (scrypt + per-user salt) in `data/users.json`, never in plain text.
- Sessions last 12 hours and are kept in memory, so restarting the server signs everyone out.

## DocuWare App Registration

For DocuWare 7.11+ use the App Registration / OAuth Authorization Code Flow.

In DocuWare Configuration:

`Integrations -> App Registration`

Create a **Web Application** registration.

Use exactly the Redirect URL shown in this dashboard. If you deploy this behind IIS, for example:

`https://your-internal-server/docuware-dashboard/oauth/callback`

The redirect URI must match the registration exactly.

DocuWare provides the authorization and token endpoints as part of the App Registration. Copy those values into the dashboard's editable OAuth fields rather than guessing an on-premises identity-service URL.

## Important HTTPS note

For production, put this Node application behind IIS, Nginx, or another internal reverse proxy and use HTTPS. Then set the redirect URL to the HTTPS callback URL.

## Authentication

The application intentionally does not implement username/password login in the browser. OAuth Authorization Code Flow keeps the client secret on the server.

The server stores the secret in:

`data/config.json`

Protect this file with normal Windows file permissions. Do not commit it to source control.

## API paths used

The dashboard uses the DocuWare Platform API under:

`/DocuWare/Platform`

For example:

- Platform: `/DocuWare/Platform`
- File cabinet: `/DocuWare/Platform/FileCabinets/{FileCabinetId}`
- Documents: `/DocuWare/Platform/FileCabinets/{FileCabinetId}/Documents`

If your installation publishes the Platform API at a different path, edit `API base path` on the Connection page.

## Organization ID

The dashboard accepts both organization name and optional organization ID. If you know the GUID, enter it in `Organization ID / GUID`.

## If Test Connection fails

1. Open `https://presentationvm/DocuWare/Platform` from the same server where this Node application is running.
2. Verify the DocuWare Platform service is reachable.
3. Click Connect to DocuWare and complete the login.
4. Check the authorization and token URLs from your App Registration.
5. Verify the redirect URL is identical in DocuWare App Registration and the dashboard.
6. Verify the App Registration has permission to access the target organization/file cabinet.
7. Check the Diagnostics page for the raw API error.

## Production hardening

This starter project is intentionally simple. Before exposing it to a wider network:

- Put it behind HTTPS.
- Restrict access with IIS Windows Authentication or your corporate reverse proxy.
- Add CSRF protection if you expose state-changing routes.
- Store the client secret in Windows Credential Manager, a secret store, or encrypted configuration.
- Use a persistent server-side session store if multiple users will use the dashboard.
- Do not expose `/api/raw` to untrusted users.
- Add role-based access if document data is sensitive.

## References

DocuWare's official documentation states that DocuWare 7.11+ uses App Registration with OAuth Authorization Code Flow for API integrations, and that the Platform API provides access to file cabinets and documents.
