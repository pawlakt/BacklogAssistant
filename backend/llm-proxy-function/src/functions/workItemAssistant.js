const { app } = require("@azure/functions");
const { jsonResponse, tryReadJson, withCors } = require("../shared/http");

const WORK_ITEM_HTTP_OPTIONS = {
  allowedMethods: "GET,POST,OPTIONS",
  allowedHeaders:
    "Content-Type, x-correlation-id, x-ado-user-id, x-ado-project-id, x-ado-project-name, x-ado-user-name, x-ado-work-item-type",
  logPrefix: "work-item assistant request"
};
const HIDDEN_CONTEXT_PREFIX = "[[NUBLADO_PROJECT_CONTEXT_V1]]";

const activeWorkItemRuns = new Set();
let workItemRepoInitPromise = null;
let workItemRepoInstance = null;
let workItemThreadsRepoInitPromise = null;
let workItemThreadsRepoInstance = null;
let sketchRepoInitPromise = null;
let sketchRepoInstance = null;
let projectContextRepoInitPromise = null;
let projectContextRepoInstance = null;

function createConversationId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  return `wi-conv-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function toWorkItemRunKey(projectId, workItemId) {
  return `${projectId}:${workItemId}`;
}

function isMissingOrEmpty(value) {
  return typeof value !== "string" || !value.trim();
}

function parseWorkItemId(rawWorkItemId) {
  const parsed = Number(rawWorkItemId);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    const error = new Error("workItemId route parameter must be a positive integer.");
    error.status = 400;
    throw error;
  }

  return parsed;
}

function getAuthResolver() {
  return require("../agent/authContext").resolveRequestAuthContext;
}

function getAgentClient() {
  return require("../agent/agentClient");
}

function getAdoClient() {
  return require("../shared/adoClient");
}

function getDraftService() {
  return require("../agent/workItemDraftService");
}

function getWorkItemDetailsEnrichmentService() {
  return require("../agent/workItemDetailsEnrichmentService");
}

async function getWorkItemRepository() {
  if (!workItemRepoInitPromise) {
    workItemRepoInitPromise = (async () => {
      const { createWorkItemRepository } = require("../agent/workItemRepo");
      const repository = createWorkItemRepository();
      await repository.ensureTable();
      workItemRepoInstance = repository;
      return repository;
    })();
  }

  return workItemRepoInstance || workItemRepoInitPromise;
}

async function getWorkItemThreadsRepository() {
  if (!workItemThreadsRepoInitPromise) {
    workItemThreadsRepoInitPromise = (async () => {
      const { createWorkItemThreadsRepository } = require("../agent/workItemThreadsRepo");
      const repository = createWorkItemThreadsRepository();
      await repository.ensureTable();
      workItemThreadsRepoInstance = repository;
      return repository;
    })();
  }

  return workItemThreadsRepoInstance || workItemThreadsRepoInitPromise;
}

async function getSketchRepository() {
  if (!sketchRepoInitPromise) {
    sketchRepoInitPromise = (async () => {
      const { createSketchRepository } = require("../agent/sketchRepo");
      const repository = createSketchRepository();
      await repository.ensureTable();
      sketchRepoInstance = repository;
      return repository;
    })();
  }

  return sketchRepoInstance || sketchRepoInitPromise;
}

async function getProjectContextRepository() {
  if (!projectContextRepoInitPromise) {
    projectContextRepoInitPromise = (async () => {
      const { createProjectContextRepository } = require("../agent/projectContextRepo");
      const repository = createProjectContextRepository();
      await repository.ensureTable();
      projectContextRepoInstance = repository;
      return repository;
    })();
  }

  return projectContextRepoInstance || projectContextRepoInitPromise;
}

function getProjectContextService() {
  return require("../agent/projectContextService");
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseConversationId(rawConversationId) {
  const conversationId = normalizeText(rawConversationId);
  if (!conversationId) {
    const error = new Error("conversationId route parameter is required.");
    error.status = 400;
    throw error;
  }
  return conversationId;
}

async function registerThreadFromSession({
  threadRepository,
  session,
  authContext,
  forceCreatedAt
}) {
  if (!session?.conversationId || !session?.threadId) {
    return null;
  }

  const resolvedCreatedAt = forceCreatedAt || session.createdAt || new Date().toISOString();
  return threadRepository.upsertThread({
    projectId: session.projectId,
    workItemId: session.workItemId,
    conversationId: session.conversationId,
    threadId: session.threadId,
    workItemType: session.workItemType || "",
    createdBy: authContext?.userDisplayName || "",
    createdById: authContext?.adoUserId || "",
    createdAt: resolvedCreatedAt,
    lastActiveAt: session.lastActiveAt || resolvedCreatedAt
  });
}

function buildHiddenContextMessage(title, sections) {
  const lines = Array.isArray(sections) ? sections.map((line) => normalizeText(line)).filter(Boolean) : [];
  if (lines.length === 0) {
    return "";
  }

  return [HIDDEN_CONTEXT_PREFIX, title, ...lines].join("\n");
}

function buildFeatureItemContextMessage(workItemContext) {
  const feature = workItemContext?.sourceWorkItem;
  if (!feature) {
    return "";
  }

  return buildHiddenContextMessage("INTERNAL FEATURE CONTEXT", [
    `Feature: #${feature.id} ${feature.title || ""}`.trim(),
    `Feature Description: ${feature.description || "(empty)"}`,
    `Feature Acceptance Criteria: ${feature.acceptanceCriteria || "(empty)"}`
  ]);
}

function buildPbiTaskItemContextMessage(workItemContext) {
  const feature = workItemContext?.parentFeature;
  const pbi = workItemContext?.sourcePbi;
  if (!feature && !pbi) {
    return "";
  }

  return buildHiddenContextMessage("INTERNAL FEATURE/PBI CONTEXT", [
    feature
      ? `Feature: #${feature.id} ${feature.title || ""}`.trim()
      : "",
    feature ? `Feature Description: ${feature.description || "(empty)"}` : "",
    pbi
      ? `PBI: #${pbi.id} ${pbi.title || ""}`.trim()
      : "",
    pbi ? `PBI Description: ${pbi.description || "(empty)"}` : "",
    pbi ? `PBI Acceptance Criteria: ${pbi.acceptanceCriteria || "(empty)"}` : ""
  ]);
}

async function getOrCreateSession({
  repository,
  agentClient,
  projectId,
  workItemId,
  workItemType,
  createIfMissing,
  requestId
}) {
  const existing = await repository.getSession({
    projectId,
    workItemId
  });
  if (existing || !createIfMissing) {
    return {
      session: existing || null,
      isNewSession: false
    };
  }

  const threadId = await agentClient.createThread({ requestId });
  const now = new Date().toISOString();
  const createdSession = await repository.upsertSession({
    projectId,
    workItemId,
    workItemType: workItemType || "",
    parentContainerId: null,
    parentContainerType: "",
    conversationId: createConversationId(),
    threadId,
    rootEpicId: null,
    projectContextRevision: "",
    projectContextUpdatedAt: null,
    createdAt: now,
    lastActiveAt: now,
    title: `Work Item #${workItemId}`
  });
  return {
    session: createdSession,
    isNewSession: true
  };
}

async function ensureProjectContextInjection(context,{
  session,
  repository,
  projectContextRepository,
  projectContextService,
  adoClient,
  agentClient,
  projectId,
  workItemId,
  requestId,
  workItemContext
}) {
  const mode = workItemContext?.generationMode;
  const hiddenMessages = [];
  let projectContextRevision = "";
  let projectContextUpdatedAt = null;
  let rootEpicId = null;

  let resolvedProjectContext = null;
  if (mode === "epic" || mode === "feature") {
    try {
      resolvedProjectContext = await projectContextService.getOrBuildProjectContext(context, {
        repository: projectContextRepository,
        adoClient,
        projectId,
        workItemId,
        requestId
      });
    } catch (error) {
      if (![400, 404].includes(Number(error?.status))) {
        throw error;
      }
    }

    if (resolvedProjectContext?.summaryText && resolvedProjectContext?.revisionHash) {
      hiddenMessages.push(projectContextService.buildHiddenContextMessage(resolvedProjectContext));
      projectContextRevision = resolvedProjectContext.revisionHash;
      projectContextUpdatedAt = resolvedProjectContext.updatedAt || null;
      rootEpicId = resolvedProjectContext.rootEpicId || null;
    }
  }

  if (mode === "feature") {
    const featureMessage = buildFeatureItemContextMessage(workItemContext);
    if (featureMessage) {
      hiddenMessages.push(featureMessage);
    }
  }

  if (mode === "pbi" || mode === "task") {
    const pbiTaskMessage = buildPbiTaskItemContextMessage(workItemContext);
    if (pbiTaskMessage) {
      hiddenMessages.push(pbiTaskMessage);
    }
  }

  if (hiddenMessages.length === 0) {
    return session;
  }

  for (const hiddenMessage of hiddenMessages) {
    await agentClient.appendMessage({
      threadId: session.threadId,
      role: "user",
      content: hiddenMessage,
      requestId
    });
  }

  await repository.updateSessionProjectContext({
    projectId,
    workItemId,
    rootEpicId,
    projectContextRevision: projectContextRevision || session.projectContextRevision || "injected",
    projectContextUpdatedAt: projectContextUpdatedAt || new Date().toISOString()
  });

  const refreshedSession = await repository.getSession({
    projectId,
    workItemId
  });
  return refreshedSession || session;
}

function countHierarchyNodes(node) {
  if (!node || typeof node !== "object") {
    return 0;
  }

  let total = 1;
  for (const childCollectionName of ["features", "pbis", "tasks"]) {
    const children = Array.isArray(node[childCollectionName]) ? node[childCollectionName] : [];
    for (const childNode of children) {
      total += countHierarchyNodes(childNode);
    }
  }

  return total;
}

function countSketchSourceItems(sketchPayload) {
  if (!sketchPayload || typeof sketchPayload !== "object") {
    return 0;
  }

  if (sketchPayload.root && typeof sketchPayload.root === "object") {
    return countHierarchyNodes(sketchPayload.root);
  }

  if (sketchPayload.epic && typeof sketchPayload.epic === "object") {
    return countHierarchyNodes(sketchPayload.epic);
  }

  return 0;
}

async function upsertProjectContextFromSketchPayload({
  workItemRepository,
  projectContextRepository,
  projectContextService,
  adoClient,
  projectId,
  workItemId,
  sourceSketch,
  requestId,
}) {
  if (!sourceSketch || typeof sourceSketch !== "object") {
    return null;
  }

  let epicScope = null;
  try {
    epicScope = await adoClient.buildEpicScopeContext({
      workItemId,
      requestId
    });
  } catch (error) {
    if ([400, 404].includes(Number(error?.status))) {
      return null;
    }
    throw error;
  }

  const projectContext = await projectContextService.upsertProjectContextFromSourcePayload({
    repository: projectContextRepository,
    projectId,
    rootEpicId: epicScope.rootEpic.id,
    rootEpicTitle: epicScope.rootEpic.title || "",
    sourcePayload: sourceSketch,
    revisionSource: epicScope.revisionSource,
    sourceItemCount: countSketchSourceItems(sourceSketch),
    requestId
  });

  if (projectContext?.revisionHash) {
    await workItemRepository.updateSessionProjectContext({
      projectId,
      workItemId,
      rootEpicId: projectContext.rootEpicId,
      projectContextRevision: projectContext.revisionHash,
      projectContextUpdatedAt: projectContext.updatedAt
    });
  }

  return projectContext;
}

app.http("workItemAssistantThreads", {
  route: "workitem-assistant/items/{workItemId}/threads",
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: withCors(async (request, context, requestId, corsHeaders) => {
    const rawWorkItemId = request.params?.workItemId;
    if (isMissingOrEmpty(rawWorkItemId)) {
      return jsonResponse(400, { error: "workItemId route parameter is required.", requestId }, corsHeaders);
    }

    const workItemId = parseWorkItemId(rawWorkItemId);
    const resolveRequestAuthContext = getAuthResolver();
    const authContext = await resolveRequestAuthContext(request);
    const workItemTypeHeader = (request.headers.get("x-ado-work-item-type") || "").trim();
    const repository = await getWorkItemRepository();
    const threadRepository = await getWorkItemThreadsRepository();

    if (request.method === "GET") {
      const session = await repository.getSession({
        projectId: authContext.projectId,
        workItemId
      });

      if (session) {
        await registerThreadFromSession({
          threadRepository,
          session,
          authContext
        });
      }

      const threads = await threadRepository.listThreads({
        projectId: authContext.projectId,
        workItemId
      });

      return jsonResponse(
        200,
        {
          session: session || null,
          activeConversationId: session?.conversationId || null,
          threads,
          requestId
        },
        {
          ...corsHeaders,
          "x-request-id": requestId
        }
      );
    }

    const runKey = toWorkItemRunKey(authContext.projectId, workItemId);
    if (activeWorkItemRuns.has(runKey)) {
      return jsonResponse(
        409,
        {
          error: "This work item conversation is busy. Wait for the running operation to finish.",
          requestId
        },
        corsHeaders
      );
    }

    activeWorkItemRuns.add(runKey);
    try {
      const existingSession = await repository.getSession({
        projectId: authContext.projectId,
        workItemId
      });

      if (existingSession) {
        await registerThreadFromSession({
          threadRepository,
          session: existingSession,
          authContext
        });
      }

      const agentClient = getAgentClient();
      const now = new Date().toISOString();
      const threadId = await agentClient.createThread({ requestId });
      const conversationId = createConversationId();
      const updatedSession = await repository.upsertSession({
        projectId: authContext.projectId,
        workItemId,
        workItemType: workItemTypeHeader || existingSession?.workItemType || "",
        parentContainerId: existingSession?.parentContainerId || null,
        parentContainerType: existingSession?.parentContainerType || "",
        conversationId,
        threadId,
        rootEpicId: existingSession?.rootEpicId || null,
        projectContextRevision: existingSession?.projectContextRevision || "",
        projectContextUpdatedAt: existingSession?.projectContextUpdatedAt || null,
        createdAt: now,
        lastActiveAt: now,
        title: existingSession?.title || `Work Item #${workItemId}`
      });

      const createdThread = await threadRepository.upsertThread({
        projectId: authContext.projectId,
        workItemId,
        conversationId,
        threadId,
        workItemType: updatedSession.workItemType || "",
        createdBy: authContext.userDisplayName || "",
        createdById: authContext.adoUserId || "",
        createdAt: now,
        lastActiveAt: now
      });

      const threads = await threadRepository.listThreads({
        projectId: authContext.projectId,
        workItemId
      });

      return jsonResponse(
        200,
        {
          session: updatedSession,
          activeConversationId: updatedSession.conversationId,
          thread: createdThread,
          threads,
          requestId
        },
        {
          ...corsHeaders,
          "x-request-id": requestId
        }
      );
    } finally {
      activeWorkItemRuns.delete(runKey);
    }
  }, WORK_ITEM_HTTP_OPTIONS)
});

app.http("workItemAssistantThreadActivate", {
  route: "workitem-assistant/items/{workItemId}/threads/{conversationId}/activate",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: withCors(async (request, context, requestId, corsHeaders) => {
    const rawWorkItemId = request.params?.workItemId;
    if (isMissingOrEmpty(rawWorkItemId)) {
      return jsonResponse(400, { error: "workItemId route parameter is required.", requestId }, corsHeaders);
    }

    const workItemId = parseWorkItemId(rawWorkItemId);
    const conversationId = parseConversationId(request.params?.conversationId);
    const resolveRequestAuthContext = getAuthResolver();
    const authContext = await resolveRequestAuthContext(request);
    const repository = await getWorkItemRepository();
    const threadRepository = await getWorkItemThreadsRepository();

    const runKey = toWorkItemRunKey(authContext.projectId, workItemId);
    if (activeWorkItemRuns.has(runKey)) {
      return jsonResponse(
        409,
        {
          error: "This work item conversation is busy. Wait for the running operation to finish.",
          requestId
        },
        corsHeaders
      );
    }

    activeWorkItemRuns.add(runKey);
    try {
      const targetThread = await threadRepository.getThread({
        projectId: authContext.projectId,
        workItemId,
        conversationId
      });

      if (!targetThread) {
        return jsonResponse(
          404,
          {
            error: "Requested thread does not exist for this work item.",
            requestId
          },
          corsHeaders
        );
      }

      const existingSession = await repository.getSession({
        projectId: authContext.projectId,
        workItemId
      });
      const updatedSession = await repository.upsertSession({
        projectId: authContext.projectId,
        workItemId,
        workItemType: existingSession?.workItemType || targetThread.workItemType || "",
        parentContainerId: existingSession?.parentContainerId || null,
        parentContainerType: existingSession?.parentContainerType || "",
        conversationId: targetThread.conversationId,
        threadId: targetThread.threadId,
        rootEpicId: existingSession?.rootEpicId || null,
        projectContextRevision: existingSession?.projectContextRevision || "",
        projectContextUpdatedAt: existingSession?.projectContextUpdatedAt || null,
        createdAt: existingSession?.createdAt || targetThread.createdAt || new Date().toISOString(),
        lastActiveAt: targetThread.lastActiveAt || targetThread.createdAt || new Date().toISOString(),
        title: existingSession?.title || `Work Item #${workItemId}`
      });

      const threads = await threadRepository.listThreads({
        projectId: authContext.projectId,
        workItemId
      });

      return jsonResponse(
        200,
        {
          session: updatedSession,
          activeConversationId: updatedSession.conversationId,
          threads,
          requestId
        },
        {
          ...corsHeaders,
          "x-request-id": requestId
        }
      );
    } finally {
      activeWorkItemRuns.delete(runKey);
    }
  }, WORK_ITEM_HTTP_OPTIONS)
});

app.http("workItemAssistantMessages", {
  route: "workitem-assistant/items/{workItemId}/messages",
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: withCors(async (request, context, requestId, corsHeaders) => {
    const rawWorkItemId = request.params?.workItemId;
    if (isMissingOrEmpty(rawWorkItemId)) {
      return jsonResponse(400, { error: "workItemId route parameter is required.", requestId }, corsHeaders);
    }

    const workItemId = parseWorkItemId(rawWorkItemId);
    const resolveRequestAuthContext = getAuthResolver();
    const authContext = await resolveRequestAuthContext(request);
    const workItemTypeHeader = (request.headers.get("x-ado-work-item-type") || "").trim();
    const repository = await getWorkItemRepository();
    const threadRepository = await getWorkItemThreadsRepository();
    const agentClient = getAgentClient();

    const projectContextService = getProjectContextService();

    if (request.method === "GET") {
      const { session } = await getOrCreateSession({
        repository,
        agentClient,
        projectId: authContext.projectId,
        workItemId,
        workItemType: workItemTypeHeader,
        createIfMissing: false,
        requestId
      });

      if (!session) {
        return jsonResponse(
          200,
          {
            session: null,
            messages: [],
            requestId
          },
          {
            ...corsHeaders,
            "x-request-id": requestId
          }
        );
      }

      await registerThreadFromSession({
        threadRepository,
        session,
        authContext
      });

      const messages = await agentClient.listMessages({
        threadId: session.threadId,
        requestId,
        order: "asc"
      });
      const visibleMessages = projectContextService.filterVisibleMessages(messages);
      context.log("Class: workItemAssistant");
      context.log("Function: workItemAssistantMessages.GET");
      context.log(
        `Output: ${JSON.stringify(
          {
            requestId,
            workItemId,
            threadId: session.threadId,
            totalMessages: messages.length,
            visibleMessages: visibleMessages.length,
            messages
          },
          null,
          2
        )}`
      );

      return jsonResponse(
        200,
        {
          session,
          messages: visibleMessages,
          requestId
        },
        {
          ...corsHeaders,
          "x-request-id": requestId
        }
      );
    }

    const body = await tryReadJson(request);
    const message = typeof body?.message === "string" ? body.message.trim() : "";
    if (!message) {
      return jsonResponse(400, { error: "Field 'message' is required.", requestId }, corsHeaders);
    }

    const runKey = toWorkItemRunKey(authContext.projectId, workItemId);
    if (activeWorkItemRuns.has(runKey)) {
      return jsonResponse(
        409,
        {
          error: "This work item conversation is already processing a message.",
          requestId
        },
        corsHeaders
      );
    }
    activeWorkItemRuns.add(runKey);
    try {
      const adoClient = getAdoClient();
      const projectContextRepository = await getProjectContextRepository();

      const { session: resolvedSession, isNewSession } = await getOrCreateSession({
        repository,
        agentClient,
        projectId: authContext.projectId,
        workItemId,
        workItemType: workItemTypeHeader,
        createIfMissing: true,
        requestId
      });
      let session = resolvedSession;
      const shouldInjectContext = isNewSession || !normalizeText(session?.projectContextRevision);
      if (shouldInjectContext) {
        const workItemContext = await adoClient.buildWorkItemDraftContext({
          workItemId,
          requestId
        });
        session = await ensureProjectContextInjection(context, {
          session,
          repository,
          projectContextRepository,
          projectContextService,
          adoClient,
          agentClient,
          projectId: authContext.projectId,
          workItemId,
          requestId,
          workItemContext
        });
      }

      const runResult = await agentClient.runAgentTurn({
        threadId: session.threadId,
        userMessage: message,
        userMetadata: {
          adoUserId: authContext.adoUserId,
          adoUserName: authContext.userDisplayName
        },
        requestId,
        agentIdOverride: (process.env.FOUNDRY_WORKITEM_AGENT_ID || "").trim() || null
      });

      await repository.updateSessionLastActiveAt({
        projectId: authContext.projectId,
        workItemId,
        lastActiveAt: new Date().toISOString()
      });

      const refreshedSession = await repository.getSession({
        projectId: authContext.projectId,
        workItemId
      });
      await registerThreadFromSession({
        threadRepository,
        session: refreshedSession || session,
        authContext
      });

      const visibleMessages = projectContextService.filterVisibleMessages(runResult.messages);

      return jsonResponse(
        200,
        {
          session: refreshedSession,
          assistantMessage: runResult.assistantMessage,
          messages: visibleMessages,
          requestId
        },
        {
          ...corsHeaders,
          "x-request-id": requestId
        }
      );
    } finally {
      activeWorkItemRuns.delete(runKey);
    }
  }, WORK_ITEM_HTTP_OPTIONS)
});

app.http("workItemAssistantDraft", {
  route: "workitem-assistant/items/{workItemId}/draft",
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: withCors(async (request, context, requestId, corsHeaders) => {
    const rawWorkItemId = request.params?.workItemId;
    if (isMissingOrEmpty(rawWorkItemId)) {
      return jsonResponse(400, { error: "workItemId route parameter is required.", requestId }, corsHeaders);
    }

    const workItemId = parseWorkItemId(rawWorkItemId);
    const resolveRequestAuthContext = getAuthResolver();
    const authContext = await resolveRequestAuthContext(request);
    const repository = await getWorkItemRepository();
    const threadRepository = await getWorkItemThreadsRepository();
    const sketchRepository = await getSketchRepository();
    const session = await repository.getSession({
      projectId: authContext.projectId,
      workItemId
    });

    if (request.method === "GET") {
      if (!session) {
        return jsonResponse(
          200,
          {
            session: null,
            sketch: null,
            backlogItemsCreatedAt: null,
            requestId
          },
          {
            ...corsHeaders,
            "x-request-id": requestId
          }
        );
      }

      await registerThreadFromSession({
        threadRepository,
        session,
        authContext
      });

      const storedSketch = await sketchRepository.getCurrentSketch(session.conversationId);
      return jsonResponse(
        200,
        {
          session,
          sketch: storedSketch?.payload || null,
          backlogItemsCreatedAt: storedSketch?.backlogItemsCreatedAt || null,
          updatedAt: storedSketch?.updatedAt || null,
          requestId
        },
        {
          ...corsHeaders,
          "x-request-id": requestId
        }
      );
    }

    if (!session) {
      return jsonResponse(
        400,
        {
          error: "Start the conversation before preparing draft items.",
          requestId
        },
        corsHeaders
      );
    }

    //redundant
    const runKey = toWorkItemRunKey(authContext.projectId, workItemId);
    if (activeWorkItemRuns.has(runKey)) {
      return jsonResponse(
        409,
        {
          error: "This work item conversation is busy. Wait for the running operation to finish.",
          requestId
        },
        corsHeaders
      );
    }

    activeWorkItemRuns.add(runKey);
    try {
      const draftService = getDraftService();
      const body = await tryReadJson(request);

      if (body?.sketch) {
        const persistedSketch = await sketchRepository.getCurrentSketch(session.conversationId);
        const normalizedSketch = draftService.validateEditableWorkItemSketch(body.sketch);
        const nowIso = new Date().toISOString();
        const storedSketch = await sketchRepository.upsertCurrentSketch({
          conversationId: session.conversationId,
          payload: normalizedSketch,
          sourceSummaryUpdatedAt: persistedSketch?.sourceSummaryUpdatedAt || null,
          backlogItemsCreatedAt: persistedSketch?.backlogItemsCreatedAt || null,
          updatedAt: nowIso
        });

        await repository.updateSessionLastActiveAt({
          projectId: authContext.projectId,
          workItemId,
          lastActiveAt: nowIso
        });
        await registerThreadFromSession({
          threadRepository,
          session: {
            ...session,
            projectId: authContext.projectId,
            workItemId,
            lastActiveAt: nowIso
          },
          authContext
        });

        return jsonResponse(
          200,
          {
            session,
            sketch: storedSketch.payload,
            backlogItemsCreatedAt: storedSketch.backlogItemsCreatedAt || null,
            updatedAt: storedSketch.updatedAt,
            saved: true,
            requestId
          },
          {
            ...corsHeaders,
            "x-request-id": requestId
          }
        );
      }

      const agentClient = getAgentClient();
      const adoClient = getAdoClient();
      const workItemDetailsEnrichmentService = getWorkItemDetailsEnrichmentService();
      const projectContextService = getProjectContextService();
      const projectContextRepository = await getProjectContextRepository();

      const threadMessages = await agentClient.listMessages({
        threadId: session.threadId,
        requestId,
        order: "asc"
      });

      const messages = projectContextService.filterVisibleMessages(threadMessages);

      if (!messages.some((message) => message.role === "assistant")) {
        return jsonResponse(
          400,
          {
            error: "At least one assistant response is required before preparing draft items.",
            requestId
          },
          corsHeaders
        );
      }

      //Do I need this?
      const workItemContext = await adoClient.buildWorkItemDraftContext({
        workItemId,
        requestId
      });

      const draftResult = await draftService.prepareWorkItemDraft({
        workItemContext,
        messages,
        // threadMessages,
        requestId,
        context
      });
      let preparedSketch = draftResult.sketch;

      if (["epic","feature", "pbi", "task"].includes(workItemContext.generationMode)) {
        const detailsAgentId = (process.env.FOUNDRY_WORKITEM_DETAILS_AGENT_ID || "").trim();
        const enrichmentResult = await workItemDetailsEnrichmentService.enrichWorkItemSketchWithAgent({
          sketch: preparedSketch,
          conversationMessages: messages,
          agentClient,
          requestId: draftResult.requestId,
          agentIdOverride: detailsAgentId || null,
          includeRoot: workItemContext.generationMode !== "epic",
          requireTasksForPbi: workItemContext.generationMode === "feature",
          context
        });
        preparedSketch = enrichmentResult.sketch || preparedSketch;
      }

      const storedSketch = await sketchRepository.upsertCurrentSketch({
        conversationId: session.conversationId,
        payload: preparedSketch,
        sourceSummaryUpdatedAt: null,
        backlogItemsCreatedAt: null,
        updatedAt: new Date().toISOString()
      });

      await repository.updateSessionLastActiveAt({
        projectId: authContext.projectId,
        workItemId,
        lastActiveAt: new Date().toISOString()
      });
      await registerThreadFromSession({
        threadRepository,
        session: {
          ...session,
          projectId: authContext.projectId,
          workItemId,
          lastActiveAt: new Date().toISOString()
        },
        authContext
      });

      if (["epic", "feature"].includes(workItemContext.generationMode)) {
        await upsertProjectContextFromSketchPayload({
          workItemRepository: repository,
          projectContextRepository,
          projectContextService,
          adoClient,
          projectId: authContext.projectId,
          workItemId,
          sourceSketch: storedSketch.payload,
          requestId: draftResult.requestId
        });
      }

      return jsonResponse(
        200,
        {
          session,
          sketch: storedSketch.payload,
          backlogItemsCreatedAt: storedSketch.backlogItemsCreatedAt || null,
          updatedAt: storedSketch.updatedAt,
          model: draftResult.model,
          usage: draftResult.usage,
          requestId: draftResult.requestId
        },
        {
          ...corsHeaders,
          "x-request-id": draftResult.requestId
        }
      );
    } finally {
      activeWorkItemRuns.delete(runKey);
    }
  }, WORK_ITEM_HTTP_OPTIONS)
});

app.http("workItemAssistantBacklogCreate", {
  route: "workitem-assistant/items/{workItemId}/backlog",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: withCors(async (request, context, requestId, corsHeaders) => {
    const rawWorkItemId = request.params?.workItemId;
    if (isMissingOrEmpty(rawWorkItemId)) {
      return jsonResponse(400, { error: "workItemId route parameter is required.", requestId }, corsHeaders);
    }

    const workItemId = parseWorkItemId(rawWorkItemId);
    const resolveRequestAuthContext = getAuthResolver();
    const authContext = await resolveRequestAuthContext(request);
    const repository = await getWorkItemRepository();
    const threadRepository = await getWorkItemThreadsRepository();
    const sketchRepository = await getSketchRepository();
    const draftService = getDraftService();
    const adoClient = getAdoClient();
    const projectContextRepository = await getProjectContextRepository();
    const projectContextService = getProjectContextService();

    const session = await repository.getSession({
      projectId: authContext.projectId,
      workItemId
    });
    if (!session) {
      return jsonResponse(
        400,
        {
          error: "No work item draft session exists yet. Prepare draft items first.",
          requestId
        },
        corsHeaders
      );
    }

    await registerThreadFromSession({
      threadRepository,
      session,
      authContext
    });

    const body = await tryReadJson(request);
    const persistedSketch = await sketchRepository.getCurrentSketch(session.conversationId);
    const sourceSketch = body?.sketch || persistedSketch?.payload || null;
    if (!sourceSketch) {
      return jsonResponse(
        400,
        {
          error: "A generated draft is required before backlog creation.",
          requestId
        },
        corsHeaders
      );
    }

    const normalizedSketch = draftService.validateEditableWorkItemSketch(sourceSketch);

    context.log("Class: workItemAssistant");
    context.log("Function: workItemAssistantBacklogCreate");
    context.log(
      `Input: ${JSON.stringify(
        {
          requestId,
          workItemId,
          hasSourceSketch: Boolean(sourceSketch),
          rootId: normalizedSketch?.root?.id || null
        },
        null,
        2
      )}`
    );

    const workItemContext = await adoClient.buildWorkItemDraftContext({
      workItemId,
      requestId
    });
    const result = await adoClient.createWorkItemScopedBacklog({
      workItemContext,
      sketch: normalizedSketch,
      requestId,
      context
    });
    const nowIso = new Date().toISOString();
    const storedSketch = await sketchRepository.upsertCurrentSketch({
      conversationId: session.conversationId,
      payload: normalizedSketch,
      sourceSummaryUpdatedAt: persistedSketch?.sourceSummaryUpdatedAt || null,
      backlogItemsCreatedAt: nowIso,
      updatedAt: nowIso
    });

    if (["epic", "feature"].includes(workItemContext.generationMode)) {
      await upsertProjectContextFromSketchPayload({
        workItemRepository: repository,
        projectContextRepository,
        projectContextService,
        adoClient,
        projectId: authContext.projectId,
        workItemId,
        sourceSketch: normalizedSketch,
        requestId
      });
    }

    await repository.updateSessionLastActiveAt({
      projectId: authContext.projectId,
      workItemId,
      lastActiveAt: new Date().toISOString()
    });
    await registerThreadFromSession({
      threadRepository,
      session: {
        ...session,
        projectId: authContext.projectId,
        workItemId,
        lastActiveAt: new Date().toISOString()
      },
      authContext
    });

    return jsonResponse(
      200,
      {
        session,
        result,
        backlogItemsCreatedAt: storedSketch.backlogItemsCreatedAt || null,
        requestId
      },
      {
        ...corsHeaders,
        "x-request-id": requestId
      }
    );
  }, WORK_ITEM_HTTP_OPTIONS)
});
