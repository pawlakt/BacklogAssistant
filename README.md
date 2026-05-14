# AI Assistant for Azure DevOps Work Items

This project delivers an Azure DevOps Work Item tab extension (`AI Assistant`) backed by an Azure Function API. It supports threaded conversations, draft backlog generation, preview/edit, and item creation directly in Azure Boards.

## What You Get

- React + Vite frontend rendered as a Work Item tab in Azure DevOps.
- Azure Function backend orchestrating:
  - Azure AI Foundry Agent calls for conversation and item enrichment.
  - Azure OpenAI calls for structured draft generation and project context summarization.
  - Azure Table Storage persistence for sessions, threads, drafts, and project context.
  - Azure DevOps Work Item create/update operations.

## Repository Layout

- `src/` - extension frontend (entry: `src/main.jsx`, UI: `src/components/WorkItemAssistantApp.jsx`)
- `backend/llm-proxy-function/` - Function API (entry: `src/functions/workItemAssistant.js`)
- `vss-extension-ai-assistant.json` - Azure DevOps extension manifest
- `images/` - extension icons
- `scripts/bump-assistant-version.js` - synchronized version bump (`package.json` + manifest)

## Prerequisites

- Node.js 20+
- Azure Functions Core Tools v4
- Azure CLI (`az login`)
- Azure DevOps org with permission to install private extensions

## Run Locally

### 1) Install dependencies

```powershell
npm install
cd backend/llm-proxy-function
npm install
cd ../..
```

### 2) Configure and run backend

```powershell
Copy-Item backend/llm-proxy-function/local.settings.sample.json backend/llm-proxy-function/local.settings.json
cd backend/llm-proxy-function
npm start
```

Fill `local.settings.json` first (AOAI, Foundry, ADO, Storage).  
Tables are created automatically on first run.

### 3) Configure and run frontend

Create `.env.local` in repo root:

```bash
VITE_LOCAL_BACKEND_URL=http://localhost:7071
VITE_WORK_ITEM_ID=<existing-work-item-id>
VITE_WORK_ITEM_TYPE=Epic
VITE_AGENT_LOCAL_USER_ID=local-user
VITE_AGENT_LOCAL_PROJECT_ID=<ado-project-id-or-name>
VITE_AGENT_LOCAL_USER_NAME=Local Developer
```

Then start Vite:

```powershell
npm run dev
```

## Deploy and Install in a New Organization

### 1) Provision Azure dependencies

- Azure Function App (Node 20)
- Azure Storage Account (Table Storage)
- Azure OpenAI deployment (`AOAI_ENDPOINT`, `AOAI_API_KEY`, `AOAI_DEPLOYMENT`)
- Azure AI Foundry project + agent (`FOUNDRY_PROJECT_ENDPOINT`, `FOUNDRY_AGENT_ID`)
- Application Insights (recommended)

### 2) Deploy backend

From `backend/llm-proxy-function`:

```powershell
func azure functionapp publish <your-function-app-name> --javascript
```

Set Function App settings from `local.settings.sample.json` (`Values` section).  
Use either `TABLE_STORAGE_CONNECTION_STRING` or managed identity with `TABLES_ACCOUNT_NAME`.

### 3) Configure CORS

Set `CORS_ALLOWED_ORIGINS` to include:

- your local dev origin (for local frontend testing)
- extension static host, typically `https://*.gallery.vsassets.io`

### 4) Build extension against deployed backend

Set `.env.production` (or CI env):

```bash
VITE_BACKEND_URL=https://<your-function-app>.azurewebsites.net
```

Build and package:

```powershell
npm run build
npm run package:vsix:assistant
```

### 5) Install VSIX in Azure DevOps

In Azure DevOps: `Organization settings -> Extensions -> Manage extensions -> Upload new extension`, then upload the generated `.vsix` file.

Open any Work Item (Epic/Feature/PBI/Task), switch to the `AI Assistant` tab, and verify message flow and draft creation.

### 6) Optional: rebrand extension identity for your org

If you do not want to use the default extension identity, update these fields in `vss-extension-ai-assistant.json` before packaging:

- `publisher`
- `id`
- `name`

Then run `npm run release:assistant` again to produce a VSIX under your naming.

## Release Workflow

```powershell
npm run release:assistant
```

This bumps version, builds `dist/`, and creates a new VSIX in one command.

## Demo (Polish language)

[Click to download▶️](./demo/demo-small.mp4)