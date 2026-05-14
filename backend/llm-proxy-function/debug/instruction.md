# Local Debug Guide: Work Item Draft Endpoint

This guide helps you debug `POST /api/workitem-assistant/items/{workItemId}/draft` locally.

## 1) Prerequisites

- Start Function host from `backend/llm-proxy-function`:
  - `npm install`
  - `npm start`
- Ensure `local.settings.json` is filled (AOAI, ADO, Foundry, Tables).  
  Source template: `backend/llm-proxy-function/local.settings.sample.json`.

## 2) Test payload file

- Use `workitem-draft-local-payload.json` in repo root.
- Update:
  - `routeParams.workItemId`
  - `headers.x-ado-work-item-type`
  - `requests[0].body.message`

## 3) Required request elements

The API requires these headers (from `authContext.js`):

- `x-ado-user-id` (required)
- `x-ado-project-id` (required)
- `x-ado-user-name` (optional)
- `x-ado-work-item-type` (important for session creation and mode selection)

And route param:

- `{workItemId}` must be a valid ADO work item ID available in your configured ADO project.

## 4) Where to get values

- `workItemId`: from ADO URL, example `.../_workitems/edit/6529`.
- `x-ado-work-item-type`: from item type in ADO (`Epic`, `Feature`, `Product Backlog Item`, `Task`).
- `x-ado-project-id`:
  - for local debug you can use your project name (for example `Nublado`) because code accepts `x-ado-project-name` fallback.
  - best is actual project id/name used by your extension/frontend.
- `x-ado-user-id`: any non-empty string works locally when `ENABLE_ADO_TOKEN_VALIDATION=false`.

## 5) Call sequence (important)

`draft` requires at least one assistant response in thread. Use this order:

1. `POST /messages` (creates/uses session and asks agent)
2. `POST /draft` (builds sketch)
3. `GET /draft` (verifies persisted result)

## 6) PowerShell examples

```powershell
$base = "http://localhost:7071"
$workItemId = 12345
$headers = @{
  "Content-Type" = "application/json"
  "x-ado-user-id" = "local-debug-user"
  "x-ado-project-id" = "Nublado"
  "x-ado-user-name" = "Local Debugger"
  "x-ado-work-item-type" = "Feature"
}
Invoke-RestMethod -Method POST `
  -Uri "$base/api/workitem-assistant/items/$workItemId/draft" `
  -Headers $headers `
  -Body "{}"

  
# 1) Send message
Invoke-RestMethod -Method POST `
  -Uri "$base/api/workitem-assistant/items/$workItemId/messages" `
  -Headers $headers `
  -Body (@{ message = "Split this feature into PBIs with clear acceptance criteria and implementation details." } | ConvertTo-Json)

# 2) Prepare draft
Invoke-RestMethod -Method POST `
  -Uri "$base/api/workitem-assistant/items/$workItemId/draft" `
  -Headers $headers `
  -Body "{}"

# 3) Read draft
Invoke-RestMethod -Method GET `
  -Uri "$base/api/workitem-assistant/items/$workItemId/draft" `
  -Headers $headers
```

## 7) Debug tips

- Set breakpoints in:
  - `backend/llm-proxy-function/src/functions/workItemAssistant.js`
  - `backend/llm-proxy-function/src/agent/workItemDraftService.js`
  - `backend/llm-proxy-function/src/agent/workItemDetailsEnrichmentService.js`
  - `backend/llm-proxy-function/src/shared/adoClient.js`
- If you get `At least one assistant response is required...`, you skipped step 1 or agent call failed.
- If you get auth context errors, check required headers first.
- If you get ADO errors, verify `ADO_ORG_URL`, `ADO_PAT`, `ADO_PROJECT`, and that `workItemId` exists in that project.
