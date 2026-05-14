const DEFAULT_LOCAL_BACKEND_URL = "http://localhost:7071";

const configuredAzureBackendUrl = (import.meta.env.VITE_BACKEND_URL || "").trim();
const configuredLocalBackendUrl = (
  import.meta.env.VITE_LOCAL_BACKEND_URL || DEFAULT_LOCAL_BACKEND_URL
).trim();

// Local Vite runs talk to the local Functions host; packaged extension builds use the deployed API.
const configuredBackendUrl = import.meta.env.DEV
  ? configuredLocalBackendUrl
  : configuredAzureBackendUrl;

const LOCAL_AGENT_USER_ID = "local-user";
const LOCAL_AGENT_PROJECT_ID = "Nublado";
const LOCAL_AGENT_USER_NAME = "Local Developer";

export function isBackendConfigured() {
  return Boolean(configuredBackendUrl);
}

export function backendConfigHint() {
  return import.meta.env.DEV ? "VITE_LOCAL_BACKEND_URL" : "VITE_BACKEND_URL";
}

export function resolveAgentContext(adoContext = {}) {
  return {
    adoUserId:
      adoContext.userId ||
      (import.meta.env.VITE_AGENT_LOCAL_USER_ID || LOCAL_AGENT_USER_ID).trim(),
    projectId:
      adoContext.projectId ||
      adoContext.project ||
      (import.meta.env.VITE_AGENT_LOCAL_PROJECT_ID || LOCAL_AGENT_PROJECT_ID).trim(),
    projectName: adoContext.project || "",
    userName:
      adoContext.user ||
      (import.meta.env.VITE_AGENT_LOCAL_USER_NAME || LOCAL_AGENT_USER_NAME).trim()
  };
}

function joinUrl(baseUrl, path) {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBaseUrl}${normalizedPath}`;
}

function buildAgentHeaders(agentContext) {
  return {
    "x-ado-user-id": agentContext?.adoUserId || "",
    "x-ado-project-id": agentContext?.projectId || "",
    "x-ado-project-name": agentContext?.projectName || "",
    "x-ado-user-name": agentContext?.userName || ""
  };
}

function buildWorkItemHeaders(agentContext, workItemContext) {
  return {
    ...buildAgentHeaders(agentContext),
    "x-ado-work-item-type": workItemContext?.workItemType || ""
  };
}

async function requestJson({ path, method, body, headers }) {
  if (!isBackendConfigured()) {
    const configError = new Error(`${backendConfigHint()} is not configured.`);
    configError.requestId = null;
    throw configError;
  }

  const response = await fetch(joinUrl(configuredBackendUrl, path), {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers
    },
    body: body == null ? undefined : JSON.stringify(body)
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const requestError = new Error(payload?.error || `Request failed with HTTP ${response.status}.`);
    requestError.requestId = payload?.requestId || response.headers.get("x-request-id");
    throw requestError;
  }

  return payload;
}

export async function getWorkItemAssistantMessages({
  workItemId,
  agentContext,
  workItemContext
}) {
  return requestJson({
    path: `/api/workitem-assistant/items/${encodeURIComponent(workItemId)}/messages`,
    method: "GET",
    headers: buildWorkItemHeaders(agentContext, workItemContext)
  });
}

export async function postWorkItemAssistantMessage({
  workItemId,
  message,
  agentContext,
  workItemContext
}) {
  return requestJson({
    path: `/api/workitem-assistant/items/${encodeURIComponent(workItemId)}/messages`,
    method: "POST",
    body: {
      message
    },
    headers: buildWorkItemHeaders(agentContext, workItemContext)
  });
}

export async function getWorkItemAssistantThreads({
  workItemId,
  agentContext,
  workItemContext
}) {
  return requestJson({
    path: `/api/workitem-assistant/items/${encodeURIComponent(workItemId)}/threads`,
    method: "GET",
    headers: buildWorkItemHeaders(agentContext, workItemContext)
  });
}

export async function postWorkItemAssistantNewThread({
  workItemId,
  agentContext,
  workItemContext
}) {
  return requestJson({
    path: `/api/workitem-assistant/items/${encodeURIComponent(workItemId)}/threads`,
    method: "POST",
    headers: buildWorkItemHeaders(agentContext, workItemContext)
  });
}

export async function postWorkItemAssistantActivateThread({
  workItemId,
  conversationId,
  agentContext,
  workItemContext
}) {
  return requestJson({
    path:
      `/api/workitem-assistant/items/${encodeURIComponent(workItemId)}` +
      `/threads/${encodeURIComponent(conversationId)}/activate`,
    method: "POST",
    headers: buildWorkItemHeaders(agentContext, workItemContext)
  });
}

export async function getWorkItemAssistantDraft({
  workItemId,
  agentContext,
  workItemContext
}) {
  return requestJson({
    path: `/api/workitem-assistant/items/${encodeURIComponent(workItemId)}/draft`,
    method: "GET",
    headers: buildWorkItemHeaders(agentContext, workItemContext)
  });
}

export async function postWorkItemAssistantPrepareDraft({
  workItemId,
  agentContext,
  workItemContext
}) {
  return requestJson({
    path: `/api/workitem-assistant/items/${encodeURIComponent(workItemId)}/draft`,
    method: "POST",
    headers: buildWorkItemHeaders(agentContext, workItemContext)
  });
}

export async function postWorkItemAssistantSaveDraft({
  workItemId,
  sketch,
  agentContext,
  workItemContext
}) {
  return requestJson({
    path: `/api/workitem-assistant/items/${encodeURIComponent(workItemId)}/draft`,
    method: "POST",
    body: {
      sketch
    },
    headers: buildWorkItemHeaders(agentContext, workItemContext)
  });
}

export async function postWorkItemAssistantCreateBacklog({
  workItemId,
  sketch,
  agentContext,
  workItemContext
}) {
  return requestJson({
    path: `/api/workitem-assistant/items/${encodeURIComponent(workItemId)}/backlog`,
    method: "POST",
    body: {
      sketch
    },
    headers: buildWorkItemHeaders(agentContext, workItemContext)
  });
}
