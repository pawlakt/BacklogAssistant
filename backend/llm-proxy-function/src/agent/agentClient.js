const { DefaultAzureCredential } = require("@azure/identity");

const DEFAULT_FOUNDRY_API_VERSION = "2025-05-01";
const DEFAULT_FOUNDRY_TOKEN_SCOPE = "https://ai.azure.com/.default";
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_POLL_TIMEOUT_MS = 60000;
let cachedCredential = null;

function readRequiredSetting(name) {
  const value = (process.env[name] || "").trim();
  if (!value) {
    const error = new Error(`Missing required configuration: ${name}`);
    error.status = 500;
    throw error;
  }

  return value;
}

function readOptionalSetting(name, fallbackValue = "") {
  const value = (process.env[name] || "").trim();
  return value || fallbackValue;
}

function sleep(delayMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function readFoundryConfiguration() {
  return {
    endpoint: readRequiredSetting("FOUNDRY_PROJECT_ENDPOINT").replace(/\/+$/, ""),
    agentId: readRequiredSetting("FOUNDRY_AGENT_ID"),
    workItemAgentId: readOptionalSetting("FOUNDRY_WORKITEM_AGENT_ID", ""),
    apiVersion: readOptionalSetting("FOUNDRY_API_VERSION", DEFAULT_FOUNDRY_API_VERSION),
    tokenScope: readOptionalSetting("FOUNDRY_TOKEN_SCOPE", DEFAULT_FOUNDRY_TOKEN_SCOPE)
  };
}

function getCredential() {
  if (!cachedCredential) {
    cachedCredential = new DefaultAzureCredential();
  }

  return cachedCredential;
}

function buildUrl(baseEndpoint, path, apiVersion, query = {}) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const searchParams = new URLSearchParams({
    "api-version": apiVersion
  });

  for (const [name, value] of Object.entries(query)) {
    if (value == null) {
      continue;
    }

    searchParams.set(name, String(value));
  }

  return `${baseEndpoint}${normalizedPath}?${searchParams.toString()}`;
}

async function foundryJsonRequest({ method, path, body, requestId, query }) {
  const config = readFoundryConfiguration();
  let token = null;
  try {
    token = await getCredential().getToken(config.tokenScope);
  } catch {
    const tokenError = new Error(
      "Failed to acquire Azure Entra token for Foundry. Run 'az login' locally or configure managed identity/service principal."
    );
    tokenError.status = 401;
    throw tokenError;
  }

  if (!token?.token) {
    const tokenError = new Error("Azure Entra token for Foundry was empty.");
    tokenError.status = 401;
    throw tokenError;
  }

  const response = await fetch(buildUrl(config.endpoint, path, config.apiVersion, query), {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token.token}`,
      "x-ms-client-request-id": requestId
    },
    body: body ? JSON.stringify(body) : undefined
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message =
      payload?.error?.message ||
      payload?.message ||
      `Foundry request failed with HTTP ${response.status}.`;
    const error = new Error(message);
    error.status = response.status >= 500 ? 502 : response.status;
    throw error;
  }

  return payload;
}

function normalizeMessageContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }

      if (typeof part.text?.value === "string") {
        return part.text.value;
      }

      if (typeof part.text === "string") {
        return part.text;
      }

      if (typeof part.value === "string") {
        return part.value;
      }

      return "";
    })
    .join("")
    .trim();
}

function normalizeMessageMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") {
    return {};
  }

  const normalized = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string" && value.trim()) {
      normalized[key] = value.trim();
    }
  }

  return normalized;
}

function mapThreadMessages(payload) {
  const data = Array.isArray(payload?.data) ? payload.data : [];
  return data
    .map((message) => {
      const metadata = normalizeMessageMetadata(message.metadata);
      return {
        id: message.id,
        role: message.role,
        createdAt: message.created_at || null,
        content: normalizeMessageContent(message.content),
        authorDisplayName: metadata.adoUserName || null,
        authorAdoUserId: metadata.adoUserId || null
      };
    })
    .filter((message) => message.content);
}

function getLatestAssistantMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "assistant") {
      return messages[i];
    }
  }

  return null;
}

async function createThread({ requestId }) {
  const payload = await foundryJsonRequest({
    method: "POST",
    path: "/threads",
    body: {},
    requestId
  });

  if (!payload?.id) {
    throw Object.assign(new Error("Foundry did not return thread id."), { status: 502 });
  }

  return payload.id;
}

async function appendMessage({ threadId, role, content, metadata, requestId }) {
  if (!threadId) {
    throw Object.assign(new Error("threadId is required."), { status: 500 });
  }

  const normalizedMetadata = normalizeMessageMetadata(metadata);

  const messagePayload = await foundryJsonRequest({
    method: "POST",
    path: `/threads/${encodeURIComponent(threadId)}/messages`,
    body: {
      role,
      content,
      ...(Object.keys(normalizedMetadata).length > 0 ? { metadata: normalizedMetadata } : {})
    },
    requestId
  });

  return {
    id: messagePayload?.id || null
  };
}

async function createRun({ threadId, requestId, agentIdOverride }) {
  const { agentId, workItemAgentId } = readFoundryConfiguration();
  const resolvedAgentId = agentIdOverride || workItemAgentId || agentId;
  const runPayload = await foundryJsonRequest({
    method: "POST",
    path: `/threads/${encodeURIComponent(threadId)}/runs`,
    body: {
      assistant_id: resolvedAgentId
    },
    requestId
  });

  if (!runPayload?.id) {
    throw Object.assign(new Error("Foundry did not return run id."), { status: 502 });
  }

  return {
    runId: runPayload.id,
    status: runPayload.status || "queued"
  };
}

async function getRun({ threadId, runId, requestId }) {
  return foundryJsonRequest({
    method: "GET",
    path: `/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}`,
    requestId
  });
}

async function waitForRunCompletion({
  threadId,
  runId,
  requestId,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  timeoutMs = DEFAULT_POLL_TIMEOUT_MS
}) {
  const startedAt = Date.now();

  while (true) {
    const run = await getRun({ threadId, runId, requestId });
    const status = run?.status || "unknown";

    if (status === "completed") {
      return run;
    }

    if (["failed", "cancelled", "expired"].includes(status)) {
      throw Object.assign(new Error(`Foundry run ended with status '${status}'.`), {
        status: 502
      });
    }

    if (Date.now() - startedAt > timeoutMs) {
      throw Object.assign(new Error("Foundry run timed out."), { status: 504 });
    }

    await sleep(pollIntervalMs);
  }
}

async function listMessagesPage({
  threadId,
  requestId,
  order = "asc",
  limit = 100,
  after = null
}) {
  const payload = await foundryJsonRequest({
    method: "GET",
    path: `/threads/${encodeURIComponent(threadId)}/messages`,
    requestId,
    query: {
      order,
      limit,
      after
    }
  });

  return {
    messages: mapThreadMessages(payload),
    hasMore: Boolean(payload?.has_more),
    nextCursor: payload?.last_id || null
  };
}

async function listAllMessages({ threadId, requestId, order = "asc", pageLimit = 100 }) {
  const messages = [];
  let after = null;

  while (true) {
    const page = await listMessagesPage({
      threadId,
      requestId,
      order,
      limit: pageLimit,
      after
    });

    messages.push(...page.messages);

    if (!page.hasMore || !page.nextCursor || page.nextCursor === after) {
      break;
    }

    after = page.nextCursor;
  }

  return messages;
}

async function runAgentTurn({
  threadId,
  userMessage,
  userMetadata,
  requestId,
  agentIdOverride
}) {
  await appendMessage({
    threadId,
    role: "user",
    content: userMessage,
    metadata: userMetadata,
    requestId
  });

  const run = await createRun({ threadId, requestId, agentIdOverride });
  await waitForRunCompletion({
    threadId,
    runId: run.runId,
    requestId
  });

  const messages = await listAllMessages({
    threadId,
    requestId,
    order: "asc"
  });

  const latestAssistantMessage = getLatestAssistantMessage(messages);
  if (!latestAssistantMessage) {
    throw Object.assign(new Error("No assistant response found in thread."), { status: 502 });
  }

  return {
    assistantMessage: latestAssistantMessage,
    messages
  };
}

module.exports = {
  createThread,
  appendMessage,
  createRun,
  waitForRunCompletion,
  listMessages: listAllMessages,
  runAgentTurn
};
