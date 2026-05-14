const {
  createTableClient,
  escapeODataLiteral,
  isAlreadyExistsError,
  isNotFoundError,
  readOptionalSetting,
  requireNonEmptyString
} = require("./tableStorage");

const DEFAULT_WORK_ITEM_THREADS_TABLE = "WorkItemAssistantThreads";

function toThreadPartitionKey(projectId, workItemId) {
  const normalizedProjectId = requireNonEmptyString(projectId, "projectId");
  const normalizedWorkItemId = Number(requireNonEmptyString(String(workItemId), "workItemId"));
  if (!Number.isInteger(normalizedWorkItemId) || normalizedWorkItemId <= 0) {
    const error = new Error("Field 'workItemId' must be a positive integer.");
    error.status = 400;
    throw error;
  }

  return `${normalizedProjectId}:${normalizedWorkItemId}`;
}

function toThreadEntity({
  projectId,
  workItemId,
  conversationId,
  threadId,
  workItemType,
  createdBy,
  createdById,
  createdAt,
  lastActiveAt
}) {
  const normalizedConversationId = requireNonEmptyString(conversationId, "conversationId");
  return {
    partitionKey: toThreadPartitionKey(projectId, workItemId),
    rowKey: normalizedConversationId,
    projectId: requireNonEmptyString(projectId, "projectId"),
    workItemId: Number(workItemId),
    conversationId: normalizedConversationId,
    threadId: requireNonEmptyString(threadId, "threadId"),
    workItemType: workItemType || "",
    createdBy: createdBy || "",
    createdById: createdById || "",
    createdAt: createdAt || new Date().toISOString(),
    lastActiveAt: lastActiveAt || createdAt || new Date().toISOString()
  };
}

function mapThreadEntity(entity) {
  return {
    projectId: entity.projectId || "",
    workItemId: Number(entity.workItemId || 0),
    conversationId: entity.conversationId || entity.rowKey || entity.RowKey || "",
    threadId: entity.threadId || "",
    workItemType: entity.workItemType || "",
    createdBy: entity.createdBy || "",
    createdById: entity.createdById || "",
    createdAt: entity.createdAt || null,
    lastActiveAt: entity.lastActiveAt || null
  };
}

function sortThreadsByLastActiveDesc(threads) {
  return [...threads].sort((left, right) => {
    const leftTimestamp = Date.parse(left.lastActiveAt || left.createdAt || 0);
    const rightTimestamp = Date.parse(right.lastActiveAt || right.createdAt || 0);
    return rightTimestamp - leftTimestamp;
  });
}

function createWorkItemThreadsRepository() {
  const tableName = readOptionalSetting(
    "TABLE_WORK_ITEM_THREADS_NAME",
    DEFAULT_WORK_ITEM_THREADS_TABLE
  );
  const client = createTableClient(tableName);

  async function ensureTable() {
    try {
      await client.createTable();
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }
  }

  async function getThread({ projectId, workItemId, conversationId }) {
    const partitionKey = toThreadPartitionKey(projectId, workItemId);
    const normalizedConversationId = requireNonEmptyString(conversationId, "conversationId");
    try {
      const entity = await client.getEntity(partitionKey, normalizedConversationId);
      return mapThreadEntity(entity);
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  async function listThreads({ projectId, workItemId }) {
    const partitionKey = toThreadPartitionKey(projectId, workItemId);
    const normalizedPartitionKey = escapeODataLiteral(partitionKey);
    const filter = `PartitionKey eq '${normalizedPartitionKey}'`;
    const threads = [];

    for await (const entity of client.listEntities({
      queryOptions: { filter }
    })) {
      threads.push(mapThreadEntity(entity));
    }

    return sortThreadsByLastActiveDesc(threads);
  }

  async function upsertThread(threadInput) {
    const entity = toThreadEntity(threadInput);
    await client.upsertEntity(entity, "Merge");
    return mapThreadEntity(entity);
  }

  return {
    ensureTable,
    getThread,
    listThreads,
    upsertThread
  };
}

module.exports = {
  createWorkItemThreadsRepository
};
