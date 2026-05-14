const fs = require("fs");
const path = require("path");
const { callAzureOpenAI } = require("../shared/aoaiClient");

const DEFAULT_MAX_CONTEXT_CHARS_BEFORE_CHUNKING = 10000000;
const DEFAULT_CONTEXT_CHUNK_CHAR_SIZE = 18000;
const DEFAULT_CHUNKED_RECENT_EXCERPT_CHARS = 12000;
const MIN_CANDIDATES_FOR_COVERAGE_GUARD = 3;
const MAX_COMBINED_SCOPE_SUMMARY_CHARS = 1000000;
const MAX_EXISTING_ITEMS = 180;
const HIDDEN_PROJECT_CONTEXT_PREFIX = "[[NUBLADO_PROJECT_CONTEXT_V1]]";
const MODE_DRAFT_PROMPT_ENV_BY_MODE = Object.freeze({
  epic: "DRAFT_SYSTEM_PROMPT_EPIC",
  feature: "DRAFT_SYSTEM_PROMPT_FEATURE",
  pbi: "DRAFT_SYSTEM_PROMPT_PBI",
  task: "DRAFT_SYSTEM_PROMPT_TASK"
});
const LOCAL_DRAFT_PROMPT_FILE_BY_SETTING = Object.freeze({
  DRAFT_SYSTEM_PROMPT_EPIC: "systemprompts/draft/draft_featureonly.md",
  DRAFT_SYSTEM_PROMPT_FEATURE: "systemprompts/agent_chat/PLACEHOLDER_FEATURE.md",
  DRAFT_SYSTEM_PROMPT_PBI: "systemprompts/agent_chat/PLACEHOLDER_PBI.md",
  DRAFT_SYSTEM_PROMPT_TASK: "systemprompts/agent_chat/PLACEHOLDER_TASK.md"
});
const IS_AZURE_HOSTED = Boolean((process.env.WEBSITE_INSTANCE_ID || "").trim());
const REPO_ROOT_PATH = path.resolve(__dirname, "../../../../");
const DEFAULT_PREPARE_DRAFT_PROMPT = [
 ""]

const CONVERSATION_MEMORY_SCHEMA = {
  name: "work_item_conversation_memory",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      scopeSummary: { type: "string" },
      capabilityAreas: {
        type: "array",
        items: { type: "string" }
      },
      requirements: {
        type: "array",
        items: { type: "string" }
      },
      constraints: {
        type: "array",
        items: { type: "string" }
      },
      decisions: {
        type: "array",
        items: { type: "string" }
      },
      openQuestions: {
        type: "array",
        items: { type: "string" }
      },
      candidateTitles: {
        type: "array",
        items: { type: "string" }
      }
    },
    required: [
      "scopeSummary",
      "capabilityAreas",
      "requirements",
      "constraints",
      "decisions",
      "openQuestions",
      "candidateTitles"
    ]
  }
};

function readOptionalSetting(name, fallbackValue = "") {
  const value = (process.env[name] || "").trim();
  return value || fallbackValue;
}

function readOptionalPositiveInteger(name, fallbackValue) {
  const value = Number((process.env[name] || "").trim());
  if (!Number.isFinite(value) || value <= 0) {
    return fallbackValue;
  }

  return Math.floor(value);
}

function readLocalPromptFile(settingName) {
  if (IS_AZURE_HOSTED) {
    return "";
  }

  const relativeFilePath = LOCAL_DRAFT_PROMPT_FILE_BY_SETTING[settingName];
  if (!relativeFilePath) {
    return "";
  }

  const absoluteFilePath = path.resolve(REPO_ROOT_PATH, relativeFilePath);
  if (!fs.existsSync(absoluteFilePath)) {
    return "";
  }

  return (fs.readFileSync(absoluteFilePath, "utf8") || "").trim();
}

function resolveDraftSystemPrompt(mode) {
  const modePromptSetting = MODE_DRAFT_PROMPT_ENV_BY_MODE[mode] || "";
  const modePrompt = modePromptSetting ? readOptionalSetting(modePromptSetting, "") : "";
  if (modePrompt) {
    return { prompt: modePrompt, source: modePromptSetting };
  }

  const localPrompt = modePromptSetting ? readLocalPromptFile(modePromptSetting) : "";
  if (localPrompt) {
    return { prompt: localPrompt, source: `local_file:${modePromptSetting}` };
  }

  const legacyPrompt = readOptionalSetting("WORK_ITEM_PREPARE_DRAFT_SYSTEM_PROMPT", "");
  if (legacyPrompt) {
    return { prompt: legacyPrompt, source: "WORK_ITEM_PREPARE_DRAFT_SYSTEM_PROMPT" };
  }

  return { prompt: DEFAULT_PREPARE_DRAFT_PROMPT, source: "DEFAULT_PREPARE_DRAFT_PROMPT" };
}

function parseModelJson(content, message) {
  if (!content) {
    throw Object.assign(new Error(message || "Model response was empty."), { status: 502 });
  }

  try {
    return JSON.parse(content);
  } catch {
    throw Object.assign(new Error("Model response was not valid JSON."), { status: 502 });
  }
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringArray(value, fieldName) {
  if (!Array.isArray(value)) {
    throw Object.assign(new Error(`Field '${fieldName}' must be an array.`), { status: 502 });
  }

  return value
    .map((item) => normalizeString(item))
    .filter(Boolean);
}

function normalizeStoryPoints(value) {
  if (value == null || value === "") {
    return null;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  return Math.round(numeric * 10) / 10;
}

function normalizePbi(pbi, featureIndex, pbiIndex) {
  const title = normalizeString(pbi?.title);
  const description = normalizeString(pbi?.description);
  if (!title || !description) {
    throw Object.assign(new Error("PBIs require non-empty title and description."), { status: 502 });
  }

  return {
    id: `pbi-${featureIndex + 1}-${pbiIndex + 1}`,
    type: "pbi",
    title,
    description,
    storyPoints: normalizeStoryPoints(pbi.storyPoints),
    acceptanceCriteria: normalizeStringArray(
      pbi?.acceptanceCriteria || [],
      "pbi.acceptanceCriteria"
    )
  };
}

function normalizeFeature(feature, featureIndex, { includePbis = true } = {}) {
  const title = normalizeString(feature?.title);
  const description = normalizeString(feature?.description);
  if (!title || !description) {
    throw Object.assign(new Error("Features require non-empty title and description."), {
      status: 502
    });
  }

  const pbis = includePbis
    ? Array.isArray(feature?.pbis)
      ? feature.pbis.map((pbi, pbiIndex) => normalizePbi(pbi, featureIndex, pbiIndex))
      : []
    : [];

  if (includePbis && pbis.length === 0) {
    throw Object.assign(new Error("Each feature requires at least one PBI."), { status: 502 });
  }

  return {
    id: `feature-${featureIndex + 1}`,
    type: "feature",
    title,
    description,
    storyPoints: normalizeStoryPoints(feature.storyPoints),
    acceptanceCriteria: normalizeStringArray(
      feature?.acceptanceCriteria || [],
      "feature.acceptanceCriteria"
    ),
    ...(includePbis ? { pbis } : {})
  };
}

function normalizeConversationRole(rawRole) {
  return normalizeString(rawRole).toLowerCase() === "assistant" ? "assistant" : "user";
}

function isHiddenProjectContextMessage(content) {
  return normalizeString(content).startsWith(HIDDEN_PROJECT_CONTEXT_PREFIX);
}

function normalizeConversationMessages(messages) {
  const normalizedMessages = Array.isArray(messages) ? messages : [];
  return normalizedMessages
    .map((message, index) => ({
      id: normalizeString(message?.id) || `message-${index + 1}`,
      role: normalizeConversationRole(message?.role),
      createdAt: normalizeString(message?.createdAt),
      content: normalizeString(message?.content)
    }))
    .filter((message) => Boolean(message.content) && !isHiddenProjectContextMessage(message.content));
}

function formatConversationLine(message, index) {
  const roleLabel = message.role === "assistant" ? "Assistant" : "User";
  const timestampPart = message.createdAt ? ` @ ${message.createdAt}` : "";
  return `[${index + 1}]${timestampPart} ${roleLabel}: ${message.content}`;
}

function splitTextIntoChunks(text, maxChunkChars) {
  const normalizedText = normalizeString(text);
  if (!normalizedText) {
    return [];
  }

  const chunks = [];
  let cursor = 0;
  while (cursor < normalizedText.length) {
    let nextCursor = Math.min(cursor + maxChunkChars, normalizedText.length);
    if (nextCursor < normalizedText.length) {
      const paragraphBoundary = normalizedText.lastIndexOf("\n\n", nextCursor);
      if (paragraphBoundary > cursor + Math.floor(maxChunkChars * 0.55)) {
        nextCursor = paragraphBoundary + 2;
      }
    }

    const chunk = normalizedText.slice(cursor, nextCursor).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    cursor = nextCursor;
  }

  return chunks;
}

function dedupeStrings(values) {
  const result = [];
  const seen = new Set();

  for (const value of values) {
    const normalized = normalizeString(value);
    if (!normalized) {
      continue;
    }

    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(normalized);
  }

  return result;
}

function isLikelyContextLengthError(error) {
  const status = Number(error?.status);
  if (![400, 413, 422].includes(status)) {
    return false;
  }

  const message = normalizeString(error?.message).toLowerCase();
  return (
    message.includes("maximum context length") ||
    message.includes("context window") ||
    message.includes("context length") ||
    message.includes("too many tokens") ||
    (message.includes("token") && message.includes("maximum"))
  );
}

function sanitizeBacklogContextItems(items) {
  const normalized = Array.isArray(items) ? items : [];
  return normalized.slice(0, MAX_EXISTING_ITEMS).map((item) => ({
    id: Number(item.id),
    type: normalizeString(item.type),
    title: normalizeString(item.title),
    parentId: item.parentId ? Number(item.parentId) : null,
    description: normalizeString(item.description).slice(0, 240),
    webUrl: normalizeString(item.webUrl)
  }));
}

function buildPrepareDraftSchema(mode) {
  if (mode === "epic") {
    return {
      name: "work_item_epic_draft",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          description: { type: "string" },
          features: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                title: { type: "string" },
                description: { type: "string" },
                acceptanceCriteria: { type: "array", items: { type: "string" } }
              },
              required: ["title", "description", "acceptanceCriteria"]
            }
          }
        },
        required: ["description", "features"]
      }
    };
  }

  if (mode === "feature") {
    return {
      name: "work_item_feature_draft",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          pbis: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                title: { type: "string" },
                description: { type: "string" },
                acceptanceCriteria: { type: "array", items: { type: "string" } }
              },
              required: ["title", "description", "acceptanceCriteria"]
            }
          }
        },
        required: ["pbis"]
      }
    };
  }

  if (mode === "task") {
    return buildTaskDraftSchema();
  }

  return {
    name: "work_item_pbi_draft",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        acceptanceCriteria: { type: "array", items: { type: "string" } }
      },
      required: ["title", "description", "acceptanceCriteria"]
    }
  };
}

function buildTaskDraftSchema() {
  return {
    name: "work_item_task_draft",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        description: { type: "string" }
      },
      required: ["title", "description"]
    }
  };
}

function buildDraftRequestBody(context,{
  mode,
  workItemContext,
  messagesContext,
  existingItems
}) {
  context.log('Mode is',mode);
  const promptConfig = resolveDraftSystemPrompt(mode);
  const basePrompt = promptConfig.prompt;

  //do wyjebania
  // const summaryLines = [
  //   `Execution mode: ${mode}`,
  //   `Current work item: [${workItemContext.sourceWorkItem.type}] #${workItemContext.sourceWorkItem.id} ${workItemContext.sourceWorkItem.title}`,
  //   `Parent container: [${workItemContext.parentContainer.type}] #${workItemContext.parentContainer.id} ${workItemContext.parentContainer.title}`
  // ];

  const sections = [
    // summaryLines.join("\n"),
    messagesContext ? `Przebieg rozmowy:\n${messagesContext}` : ""
    // existingItems.length > 0
    //   ? `Existing related backlog (condensed JSON):\n${JSON.stringify(existingItems)}`
    //   : "Existing related backlog (condensed JSON): []"
  ]
    .filter(Boolean)
    .join("\n\n");

  context.log("Function: buildDraftRequestBody. Sections:",sections);
  //Czy ja potrzebuje sections? Co wchodzi w ich sklad?
  return {
    messages: [
      {
        role: "system",
        content: basePrompt
      },
      {
        role: "user",
        content: sections
      }
    ],
    temperature: 0.2,
    response_format: {
      type: "json_schema",
      //Obczaj ten schemat
      json_schema: buildPrepareDraftSchema(mode)
    }
  };
}

function buildConversationMemoryChunkRequestBody({
  mode,
  chunkText,
  chunkIndex,
  chunkCount
}) {
  const systemPrompt = [
    "You extract requirement signals from one transcript chunk.",
    "Capture requirements exactly from this chunk only.",
    "Do not invent details that are not in this chunk.",
    "Keep bullet-like outputs concise and deduplicated.",
    "candidateTitles should contain possible direct children for mode:",
    mode
  ].join(" ");

  return {
    messages: [
      {
        role: "system",
        content: systemPrompt
      },
      {
        role: "user",
        content:
          `Transcript chunk ${chunkIndex}/${chunkCount}:\n\n${chunkText}\n\n` +
          "Return JSON according to schema."
      }
    ],
    temperature: 0.1,
    response_format: {
      type: "json_schema",
      json_schema: CONVERSATION_MEMORY_SCHEMA
    }
  };
}

function validateConversationMemory(memory) {
  if (!memory || typeof memory !== "object" || Array.isArray(memory)) {
    throw Object.assign(new Error("Conversation memory output was invalid."), { status: 502 });
  }

  return {
    scopeSummary: normalizeString(memory.scopeSummary),
    capabilityAreas: normalizeStringArray(memory.capabilityAreas || [], "memory.capabilityAreas"),
    requirements: normalizeStringArray(memory.requirements || [], "memory.requirements"),
    constraints: normalizeStringArray(memory.constraints || [], "memory.constraints"),
    decisions: normalizeStringArray(memory.decisions || [], "memory.decisions"),
    openQuestions: normalizeStringArray(memory.openQuestions || [], "memory.openQuestions"),
    candidateTitles: normalizeStringArray(memory.candidateTitles || [], "memory.candidateTitles")
  };
}

function mergeConversationMemories(memories) {
  const merged = {
    scopeSummary: "",
    capabilityAreas: [],
    requirements: [],
    constraints: [],
    decisions: [],
    openQuestions: [],
    candidateTitles: []
  };

  const scopeSummaries = [];
  for (const memory of memories) {
    if (memory.scopeSummary) {
      scopeSummaries.push(memory.scopeSummary);
    }
    merged.capabilityAreas.push(...memory.capabilityAreas);
    merged.requirements.push(...memory.requirements);
    merged.constraints.push(...memory.constraints);
    merged.decisions.push(...memory.decisions);
    merged.openQuestions.push(...memory.openQuestions);
    merged.candidateTitles.push(...memory.candidateTitles);
  }

  merged.capabilityAreas = dedupeStrings(merged.capabilityAreas);
  merged.requirements = dedupeStrings(merged.requirements);
  merged.constraints = dedupeStrings(merged.constraints);
  merged.decisions = dedupeStrings(merged.decisions);
  merged.openQuestions = dedupeStrings(merged.openQuestions);
  merged.candidateTitles = dedupeStrings(merged.candidateTitles);
  merged.scopeSummary = dedupeStrings(scopeSummaries)
    .join("\n")
    .slice(0, MAX_COMBINED_SCOPE_SUMMARY_CHARS);

  return merged;
}

function buildChunkedMessagesContext({ mergedMemory, transcriptText }) {
  const recentExcerptChars = readOptionalPositiveInteger(
    "WORK_ITEM_DRAFT_CHUNKED_RECENT_EXCERPT_CHARS",
    DEFAULT_CHUNKED_RECENT_EXCERPT_CHARS
  );
  const recentExcerpt = transcriptText.slice(-recentExcerptChars);
  const sections = [
    "Conversation memory compiled from all transcript chunks:",
    JSON.stringify(mergedMemory),
    recentExcerpt ? `Recent transcript excerpt:\n${recentExcerpt}` : ""
  ];

  return sections.filter(Boolean).join("\n\n");
}

async function buildChunkedContextMemory({
  mode,
  transcriptText,
  requestId
}) {
  const chunkSize = readOptionalPositiveInteger(
    "WORK_ITEM_DRAFT_CONTEXT_CHUNK_SIZE",
    DEFAULT_CONTEXT_CHUNK_CHAR_SIZE
  );
  const transcriptChunks = splitTextIntoChunks(transcriptText, chunkSize);
  if (transcriptChunks.length === 0) {
    throw Object.assign(new Error("Conversation context is empty after chunking."), { status: 400 });
  }

  const memories = [];
  for (let index = 0; index < transcriptChunks.length; index += 1) {
    const chunkPayload = await callAzureOpenAI(
      buildConversationMemoryChunkRequestBody({
        mode,
        chunkText: transcriptChunks[index],
        chunkIndex: index + 1,
        chunkCount: transcriptChunks.length
      }),
      `${requestId}-ctx-${index + 1}`
    );
    const parsedChunkMemory = parseModelJson(
      chunkPayload.responseText,
      "Conversation chunk memory response was empty."
    );
    memories.push(validateConversationMemory(parsedChunkMemory));
  }

  const mergedMemory = mergeConversationMemories(memories);
  return {
    mode: "chunked",
    chunkCount: transcriptChunks.length,
    mergedMemory,
    messagesContext: buildChunkedMessagesContext({
      mergedMemory,
      transcriptText
    })
  };
}

function countGeneratedChildren(mode, rootNode) {
  if (mode === "epic") {
    return Array.isArray(rootNode?.features) ? rootNode.features.length : 0;
  }
  if (mode === "feature") {
    return Array.isArray(rootNode?.pbis) ? rootNode.pbis.length : 0;
  }
  if (mode === "pbi" || mode === "task") {
    // PBI/Task draft modes update the current item rather than generating a child list.
    return 2;
  }

  return 0;
}

function assertChunkedCoverage({ mode, rootNode, mergedMemory }) {
  const expectedCandidates = Array.isArray(mergedMemory?.candidateTitles)
    ? mergedMemory.candidateTitles.length
    : 0;
  const generatedChildren = countGeneratedChildren(mode, rootNode);
  if (
    expectedCandidates >= MIN_CANDIDATES_FOR_COVERAGE_GUARD &&
    generatedChildren <= 1
  ) {
    throw Object.assign(
      new Error(
        "Draft coverage check failed: conversation indicates multiple candidate items, but generated draft returned only one child item."
      ),
      { status: 502 }
    );
  }
}

function normalizeRootFromMode({ mode, parentContainer, rawModelOutput }) {
  if (mode === "epic") {
    const description =
      normalizeString(rawModelOutput?.description) || parentContainer.description || "";
    const features = Array.isArray(rawModelOutput?.features)
      ? rawModelOutput.features.map((feature, featureIndex) =>
          normalizeFeature(feature, featureIndex, { includePbis: false })
        )
      : [];
    if (features.length === 0) {
      throw Object.assign(new Error("Prepared draft requires at least one feature."), { status: 502 });
    }

    return {
      id: `workitem-${parentContainer.id}`,
      type: "epic",
      title: parentContainer.title,
      description,
      storyPoints: null,
      features
    };
  }

  if (mode === "feature") {
    const pbis = Array.isArray(rawModelOutput?.pbis)
      ? rawModelOutput.pbis.map((pbi, pbiIndex) => normalizePbi(pbi, 0, pbiIndex))
      : [];
    if (pbis.length === 0) {
      throw Object.assign(new Error("Prepared draft requires at least one PBI."), { status: 502 });
    }

    return {
      id: `workitem-${parentContainer.id}`,
      type: "feature",
      title: parentContainer.title,
      description: parentContainer.description || "",
      storyPoints: null,
      acceptanceCriteria: [],
      pbis
    };
  }

  if (mode === "task") {
    const title = normalizeString(rawModelOutput?.title) || parentContainer.title || "";
    const description = normalizeString(rawModelOutput?.description) || parentContainer.description || "";
    if (!title || !description) {
      throw Object.assign(new Error("Prepared draft requires task title and description."), { status: 502 });
    }

    return {
      id: `workitem-${parentContainer.id}`,
      type: "task",
      title,
      description
    };
  }

  const title = normalizeString(rawModelOutput?.title) || parentContainer.title || "";
  const description = normalizeString(rawModelOutput?.description) || parentContainer.description || "";
  if (!title || !description) {
    throw Object.assign(
      new Error("Prepared draft requires Product Backlog Item title and description."),
      { status: 502 }
    );
  }

  return {
    id: `workitem-${parentContainer.id}`,
    type: "pbi",
    title,
    description,
    storyPoints: null,
    acceptanceCriteria: normalizeStringArray(
      rawModelOutput?.acceptanceCriteria || [],
      "pbi.acceptanceCriteria"
    )
  };
}

async function prepareWorkItemDraft({
  workItemContext,
  messages,
  requestId,
  context
}) {
  const normalizedMessages = normalizeConversationMessages(messages);
  if (normalizedMessages.length === 0) {
    throw Object.assign(new Error("Conversation does not contain messages for draft preparation."), {
      status: 400
    });
  }

  const fullMessagesContext = normalizedMessages
    .map((message, index) => formatConversationLine(message, index))
    .join("\n\n");
  const maxContextCharsBeforeChunking = readOptionalPositiveInteger(
    "WORK_ITEM_DRAFT_MAX_CONTEXT_CHARS",
    DEFAULT_MAX_CONTEXT_CHARS_BEFORE_CHUNKING
  );
  const existingItems = sanitizeBacklogContextItems(workItemContext.existingItems || []);
  let contextBuild = {
    mode: "full",
    chunkCount: 1,
    mergedMemory: null,
    messagesContext: fullMessagesContext
  };

  context.log("Class: workItemDraftService");
  context.log("Function: prepareWorkItemDraft");
  context.log(
    `Input: ${JSON.stringify(
      {
        mode: workItemContext.generationMode,
        fullMessagesCount: normalizedMessages.length,
        fullMessagesContextLength: fullMessagesContext.length
      },
      null,
      2
    )}`
  );

  async function requestDraftPayload(messagesContextValue) {
    return callAzureOpenAI(
      buildDraftRequestBody(context, {
        mode: workItemContext.generationMode,
        workItemContext,
        messagesContext: messagesContextValue,
        existingItems
      }),
      requestId
    );
  }
  
  let payload = null;
  if (fullMessagesContext.length > maxContextCharsBeforeChunking) {
    contextBuild = await buildChunkedContextMemory({
      mode: workItemContext.generationMode,
      transcriptText: fullMessagesContext,
      requestId
    });
    payload = await requestDraftPayload(contextBuild.messagesContext);
  } else {
    try {
      payload = await requestDraftPayload(fullMessagesContext);
    } catch (error) {
      if (!isLikelyContextLengthError(error)) {
        throw error;
      }
      contextBuild = await buildChunkedContextMemory({
        mode: workItemContext.generationMode,
        transcriptText: fullMessagesContext,
        requestId
      });
      payload = await requestDraftPayload(contextBuild.messagesContext);
    }
  }

  const rawModelOutput = parseModelJson(payload.responseText, "Draft generation returned an empty response.");
 context.log(
    `Output rawModel: ${JSON.stringify(rawModelOutput)}`)

  const rootNode = normalizeRootFromMode({
    mode: workItemContext.generationMode,
    parentContainer: workItemContext.parentContainer,
    rawModelOutput
  });
   context.log(
    `Output rootNode: ${JSON.stringify(rootNode)}`)

  // if (contextBuild.mode === "chunked") {
  //   assertChunkedCoverage({
  //     mode: workItemContext.generationMode,
  //     rootNode,
  //     mergedMemory: contextBuild.mergedMemory
  //   });
  // }
  // context.log("Class: workItemDraftService");
  // context.log("Function: prepareWorkItemDraft");
  // context.log(
  //   `Output: ${JSON.stringify(
  //     {
  //       mode: workItemContext.generationMode,
  //       rootType: rootNode?.type || null,
  //       rootId: rootNode?.id || null
  //     },
  //     null,
  //     2
  //   )}`
  // );

  return {
    sketch: {
      root: rootNode,
      context: {
        sourceWorkItemId: workItemContext.sourceWorkItem.id,
        sourceWorkItemType: workItemContext.sourceWorkItem.type,
        parentContainerId: workItemContext.parentContainer.id,
        parentContainerType: workItemContext.parentContainer.type,
        generationMode: workItemContext.generationMode,
        conversationContextMode: contextBuild.mode,
        conversationMessageCount: normalizedMessages.length,
        conversationChunkCount: contextBuild.chunkCount
      },
      warnings: []
    },
    model: payload.model,
    requestId: payload.requestId,
    usage: payload.usage
  };
}

function validateEditableRootNode(node) {
  const title = normalizeString(node?.title);
  const description = normalizeString(node?.description);
  const type = normalizeString(node?.type).toLowerCase();
  if (!title) {
    throw Object.assign(new Error(`Node '${type || "item"}' requires a title.`), { status: 400 });
  }
  if (!description && type !== "pbi" && type !== "epic" && type !== "feature") {
    throw Object.assign(new Error(`Node '${type || "item"}' requires a description.`), {
      status: 400
    });
  }

  const normalizedNode = {
    ...node,
    title,
    description,
    storyPoints: normalizeStoryPoints(node?.storyPoints),
    acceptanceCriteria: Array.isArray(node?.acceptanceCriteria)
      ? node.acceptanceCriteria.map((item) => normalizeString(item)).filter(Boolean)
      : []
  };

  if (Array.isArray(node?.features)) {
    normalizedNode.features = node.features.map((feature) => validateEditableRootNode(feature));
  }
  if (Array.isArray(node?.pbis)) {
    normalizedNode.pbis = node.pbis.map((pbi) => validateEditableRootNode(pbi));
  }
  if (Array.isArray(node?.tasks)) {
    normalizedNode.tasks = node.tasks.map((task) => validateEditableRootNode(task));
  }

  return normalizedNode;
}

function validateEditableWorkItemSketch(sketch) {
  if (!sketch || typeof sketch !== "object" || Array.isArray(sketch)) {
    const error = new Error("Field 'sketch' must be an object.");
    error.status = 400;
    throw error;
  }

  if (!sketch.root || typeof sketch.root !== "object" || Array.isArray(sketch.root)) {
    const error = new Error("Field 'sketch.root' is required.");
    error.status = 400;
    throw error;
  }

  return {
    ...sketch,
    root: validateEditableRootNode(sketch.root)
  };
}

module.exports = {
  prepareWorkItemDraft,
  validateEditableWorkItemSketch
};
