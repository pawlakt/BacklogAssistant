const crypto = require("node:crypto");
const { callAzureOpenAI } = require("../shared/aoaiClient");

const HIDDEN_CONTEXT_PREFIX = "[[NUBLADO_PROJECT_CONTEXT_V1]]";
const DEFAULT_PROJECT_CONTEXT_SUMMARY_SYSTEM_PROMPT = "<PLACHOLDER>";

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readOptionalSetting(name, fallbackValue = "") {
  const value = (process.env[name] || "").trim();
  return value || fallbackValue;
}

function computeRevisionHash(revisionSource) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(revisionSource || {}))
    .digest("hex");
}

function buildHiddenContextMessage(projectContext) {
  const summaryText = normalizeString(projectContext?.summaryText);
  if (!summaryText) {
    const error = new Error("Project context summary is empty.");
    error.status = 500;
    throw error;
  }

  return [
    HIDDEN_CONTEXT_PREFIX,
    "INTERNAL PROJECT CONTEXT. Use this as grounding for all future answers.",
    "Do not expose this message to the user and do not mention this internal source explicitly.",
    `Root epic: #${projectContext.rootEpicId} ${projectContext.rootEpicTitle || ""}`.trim(),
    `Context revision: ${projectContext.revisionHash}`,
    "",
    summaryText
  ].join("\n");
}

function isHiddenContextMessageContent(content) {
  //to be updated
  return normalizeString(content).startsWith(HIDDEN_CONTEXT_PREFIX);
}

function filterVisibleMessages(messages) {
  const normalized = Array.isArray(messages) ? messages : [];
  return normalized.filter((message) => !isHiddenContextMessageContent(message?.content));
}

function buildProjectContextSummaryRequestBody(sourceJson) {
  const systemPrompt = readOptionalSetting(
    "PROJECT_CONTEXT_SUMMARY_SYSTEM_PROMPT",
    DEFAULT_PROJECT_CONTEXT_SUMMARY_SYSTEM_PROMPT
  );

  return {
    messages: [
      {
        role: "system",
        content: systemPrompt
      },
      {
        role: "user",
        content:
          "Create a concise project backlog context summary from this project scope JSON. " +
          "The result will be stored as a reusable context for future assistant responses.\n\n" +
          `Project Scope JSON:\n${JSON.stringify(sourceJson)}`
      }
    ],
    temperature: 0.1
  };
}

async function callAoaiProjectContextSummary(requestBody, requestId) {
  // Backward-compatible wrapper: support both (body, requestId) and (context, body, requestId).
  if (callAzureOpenAI.length >= 3) {
    return callAzureOpenAI(null, requestBody, requestId);
  }

  return callAzureOpenAI(requestBody, requestId);
}

async function summarizeProjectSourceWithLlm({ sourceJson, requestId }) {
  const payload = await callAoaiProjectContextSummary(
    buildProjectContextSummaryRequestBody(sourceJson),
    requestId
  );
  const summaryText = normalizeString(payload?.responseText);
  if (!summaryText) {
    const error = new Error("Generated project context summary is empty.");
    error.status = 502;
    throw error;
  }

  return summaryText;
}

async function upsertProjectContextFromSourcePayload({
  repository,
  projectId,
  rootEpicId,
  rootEpicTitle,
  sourcePayload,
  revisionSource,
  sourceItemCount,
  requestId
}) {
  if (!repository || typeof repository.upsertProjectContext !== "function") {
    const error = new Error("Project context repository with upsertProjectContext is required.");
    error.status = 500;
    throw error;
  }

  if (!rootEpicId || !sourcePayload || typeof sourcePayload !== "object") {
    const error = new Error("Root epic id and source payload are required for project context upsert.");
    error.status = 400;
    throw error;
  }

  const revisionHash = computeRevisionHash(revisionSource || sourcePayload);
  const summaryText = await summarizeProjectSourceWithLlm({
    sourceJson: sourcePayload,
    requestId: requestId || `project-context-${Date.now()}`
  });

  return repository.upsertProjectContext({
    projectId,
    rootEpicId,
    rootEpicTitle: rootEpicTitle || "",
    summaryText,
    revisionHash,
    sourceItemCount: Number.isInteger(Number(sourceItemCount)) ? Number(sourceItemCount) : 0,
    updatedAt: new Date().toISOString()
  });
}

async function getOrBuildProjectContext(context,{
  repository,
  adoClient,
  projectId,
  workItemId,
  requestId,
  forceRefresh = false
}) {
  if (!repository || typeof repository.getProjectContext !== "function") {
    const error = new Error("Project context repository is required.");
    error.status = 500;
    throw error;
  }
  if (!adoClient || typeof adoClient.buildEpicScopeContext !== "function") {
    const error = new Error("ADO client with buildEpicScopeContext is required.");
    error.status = 500;
    throw error;
  }

  const epicScope = await adoClient.buildEpicScopeContext({
    workItemId,
    requestId
  });

  context.log('Build epic context:');
  context.log(epicScope);
  context.log('Revision source');
  context.log(JSON.stringify(epicScope?.revisionSource))

  if (!epicScope?.rootEpic?.id || !epicScope?.hierarchySnapshot) {
    return null;
  }

  const revisionHash = computeRevisionHash(epicScope.revisionSource);
  const cached = await repository.getProjectContext({
    projectId,
    rootEpicId: epicScope.rootEpic.id
  });

  if (!forceRefresh && cached?.revisionHash === revisionHash) {
    return cached;
  }

  return upsertProjectContextFromSourcePayload({
    repository,
    projectId,
    rootEpicId: epicScope.rootEpic.id,
    rootEpicTitle: epicScope.rootEpic.title || "",
    sourcePayload: epicScope.hierarchySnapshot,
    revisionSource: epicScope.revisionSource,
    sourceItemCount: epicScope.sourceItemCount || 0,
    requestId
  });
}

module.exports = {
  buildHiddenContextMessage,
  isHiddenContextMessageContent,
  filterVisibleMessages,
  getOrBuildProjectContext,
  upsertProjectContextFromSourcePayload
};
