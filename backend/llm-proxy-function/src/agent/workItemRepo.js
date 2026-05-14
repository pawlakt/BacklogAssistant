const {
  createTableClient,
  isAlreadyExistsError,
  isNotFoundError,
  readOptionalSetting,
  requireNonEmptyString
} = require("./tableStorage");

const DEFAULT_WORK_ITEM_SESSIONS_TABLE = "WorkItemAssistantSessions";

function mapSessionEntity(entity) {
  return {
    projectId: entity.projectId || entity.partitionKey || entity.PartitionKey,
    workItemId: Number(entity.workItemId || entity.rowKey || entity.RowKey),
    workItemType: entity.workItemType || "",
    parentContainerId: entity.parentContainerId ? Number(entity.parentContainerId) : null,
    parentContainerType: entity.parentContainerType || "",
    conversationId: entity.conversationId || "",
    threadId: entity.threadId || "",
    rootEpicId: entity.rootEpicId ? Number(entity.rootEpicId) : null,
    projectContextRevision: entity.projectContextRevision || "",
    projectContextUpdatedAt: entity.projectContextUpdatedAt || null,
    title: entity.title || "AI Assistant Session",
    createdAt: entity.createdAt || null,
    lastActiveAt: entity.lastActiveAt || null
  };
}

function createSessionEntity({
  projectId,
  workItemId,
  workItemType,
  parentContainerId,
  parentContainerType,
  conversationId,
  threadId,
  rootEpicId,
  projectContextRevision,
  projectContextUpdatedAt,
  title,
  createdAt,
  lastActiveAt
}) {
  const normalizedProjectId = requireNonEmptyString(projectId, "projectId");
  const normalizedWorkItemId = Number(requireNonEmptyString(String(workItemId), "workItemId"));
  if (!Number.isInteger(normalizedWorkItemId) || normalizedWorkItemId <= 0) {
    const error = new Error("Field 'workItemId' must be a positive integer.");
    error.status = 400;
    throw error;
  }

  return {
    partitionKey: normalizedProjectId,
    rowKey: String(normalizedWorkItemId),
    projectId: normalizedProjectId,
    workItemId: normalizedWorkItemId,
    workItemType: workItemType || "",
    parentContainerId:
      Number.isInteger(Number(parentContainerId)) && Number(parentContainerId) > 0
        ? Number(parentContainerId)
        : null,
    parentContainerType: parentContainerType || "",
    conversationId: requireNonEmptyString(conversationId, "conversationId"),
    threadId: requireNonEmptyString(threadId, "threadId"),
    rootEpicId:
      Number.isInteger(Number(rootEpicId)) && Number(rootEpicId) > 0 ? Number(rootEpicId) : null,
    projectContextRevision: projectContextRevision || "",
    projectContextUpdatedAt: projectContextUpdatedAt || null,
    title: title || "AI Assistant Session",
    createdAt: createdAt || new Date().toISOString(),
    lastActiveAt: lastActiveAt || createdAt || new Date().toISOString()
  };
}

function createWorkItemRepository() {
  const sessionsTableName = readOptionalSetting(
    "TABLE_WORK_ITEM_SESSIONS_NAME",
    DEFAULT_WORK_ITEM_SESSIONS_TABLE
  );
  const sessionsClient = createTableClient(sessionsTableName);

  async function ensureTable() {
    try {
      await sessionsClient.createTable();
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }
  }

  async function getSession({ projectId, workItemId }) {
    const normalizedProjectId = requireNonEmptyString(projectId, "projectId");
    const normalizedWorkItemId = requireNonEmptyString(String(workItemId), "workItemId");

    try {
      const entity = await sessionsClient.getEntity(normalizedProjectId, normalizedWorkItemId);
      return mapSessionEntity(entity);
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  async function upsertSession(sessionInput) {
    const entity = createSessionEntity(sessionInput);
    await sessionsClient.upsertEntity(entity, "Merge");
    return mapSessionEntity(entity);
  }

  async function updateSessionLastActiveAt({ projectId, workItemId, lastActiveAt }) {
    const normalizedProjectId = requireNonEmptyString(projectId, "projectId");
    const normalizedWorkItemId = requireNonEmptyString(String(workItemId), "workItemId");

    const updateEntity = {
      partitionKey: normalizedProjectId,
      rowKey: normalizedWorkItemId,
      lastActiveAt: lastActiveAt || new Date().toISOString()
    };
    await sessionsClient.updateEntity(
      updateEntity,
      "Merge"
    );
  }

  async function updateSessionProjectContext({
    projectId,
    workItemId,
    rootEpicId,
    projectContextRevision,
    projectContextUpdatedAt
  }) {
    const normalizedProjectId = requireNonEmptyString(projectId, "projectId");
    const normalizedWorkItemId = requireNonEmptyString(String(workItemId), "workItemId");

    const updateEntity = {
      partitionKey: normalizedProjectId,
      rowKey: normalizedWorkItemId,
      rootEpicId:
        Number.isInteger(Number(rootEpicId)) && Number(rootEpicId) > 0 ? Number(rootEpicId) : null,
      projectContextRevision: projectContextRevision || "",
      projectContextUpdatedAt: projectContextUpdatedAt || new Date().toISOString()
    };
    await sessionsClient.updateEntity(
      updateEntity,
      "Merge"
    );
  }

  return {
    ensureTable,
    getSession,
    upsertSession,
    updateSessionLastActiveAt,
    updateSessionProjectContext
  };
}

module.exports = {
  createWorkItemRepository
};
