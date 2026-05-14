# AI Assistant Function Backend

Azure Function API for the Azure DevOps Work Item AI Assistant tab.

## Endpoints

- `GET /api/workitem-assistant/items/{workItemId}/threads`
- `POST /api/workitem-assistant/items/{workItemId}/threads`
- `POST /api/workitem-assistant/items/{workItemId}/threads/{conversationId}/activate`
- `GET /api/workitem-assistant/items/{workItemId}/messages`
- `POST /api/workitem-assistant/items/{workItemId}/messages`
- `GET /api/workitem-assistant/items/{workItemId}/draft`
- `POST /api/workitem-assistant/items/{workItemId}/draft`
- `POST /api/workitem-assistant/items/{workItemId}/backlog`

## Required configuration

- `AOAI_ENDPOINT`
- `AOAI_API_KEY`
- `AOAI_DEPLOYMENT`
- `FOUNDRY_PROJECT_ENDPOINT`
- `FOUNDRY_AGENT_ID`
- `ADO_ORG_URL`
- `ADO_PAT`
- `TABLE_STORAGE_CONNECTION_STRING` or `TABLES_ACCOUNT_NAME`

Common optional settings:

- `AOAI_API_VERSION` (default `2024-10-21`)
- `FOUNDRY_WORKITEM_AGENT_ID`
- `FOUNDRY_WORKITEM_DETAILS_AGENT_ID`
- `FOUNDRY_API_VERSION` (default `2025-05-01`)
- `FOUNDRY_TOKEN_SCOPE` (default `https://ai.azure.com/.default`)
- `CORS_ALLOWED_ORIGINS`
- `ADO_PROJECT`, `ADO_API_VERSION`
- `ADO_EPIC_WORK_ITEM_TYPE`, `ADO_FEATURE_WORK_ITEM_TYPE`, `ADO_BACKLOG_WORK_ITEM_TYPE`, `ADO_TASK_WORK_ITEM_TYPE`
- `ADO_STORY_POINTS_FIELD`, `ADO_TASK_ORIGINAL_ESTIMATE_FIELD`, `ADO_TASK_ORIGINAL_ESTIMATE_DEFAULT`
- `DRAFT_SYSTEM_PROMPT_EPIC`, `DRAFT_SYSTEM_PROMPT_FEATURE`, `DRAFT_SYSTEM_PROMPT_PBI`, `DRAFT_SYSTEM_PROMPT_TASK`
- `WORK_ITEM_PREPARE_DRAFT_SYSTEM_PROMPT`
- `PROJECT_CONTEXT_SUMMARY_SYSTEM_PROMPT`
- `TABLE_WORK_ITEM_SESSIONS_NAME`, `TABLE_WORK_ITEM_THREADS_NAME`, `TABLE_CONVERSATION_SKETCHES_NAME`, `TABLE_PROJECT_CONTEXTS_NAME`

## Local run

```powershell
cd backend/llm-proxy-function
npm install
npm start
```

If you use Entra auth for Foundry agent calls, run `az login` first.
