const {
  createTableClient,
  isAlreadyExistsError,
  isNotFoundError,
  readOptionalSetting,
  requireNonEmptyString
} = require("./tableStorage");
const { readLargeText, writeLargeText } = require("./largeTextStorage");

const DEFAULT_PROJECT_CONTEXTS_TABLE = "ProjectBacklogContexts";
const PROJECT_CONTEXT_ROW_KEY = "project-backlog-context";

function normalizePositiveInt(value, fieldName) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    const error = new Error(`Field '${fieldName}' must be a positive integer.`);
    error.status = 400;
    throw error;
  }

  return numeric;
}

function mapProjectContextEntity(entity) {
  return {
    projectId: entity.projectId || entity.partitionKey || entity.PartitionKey,
    rootEpicId: Number(entity.rootEpicId),
    rootEpicTitle: entity.rootEpicTitle || "",
    summaryText: entity.summaryText || "",
    revisionHash: entity.revisionHash || "",
    sourceItemCount: Number(entity.sourceItemCount || 0),
    updatedAt: entity.updatedAt || null
  };
}

function createProjectContextEntity({
  projectId,
  rootEpicId,
  rootEpicTitle,
  summaryText,
  revisionHash,
  sourceItemCount,
  updatedAt
}) {
  const normalizedProjectId = requireNonEmptyString(projectId, "projectId");
  const normalizedRootEpicId = normalizePositiveInt(rootEpicId, "rootEpicId");
  const normalizedSummaryText = requireNonEmptyString(summaryText, "summaryText");
  const normalizedRevisionHash = requireNonEmptyString(revisionHash, "revisionHash");

  return {
    partitionKey: normalizedProjectId,
    rowKey: `${PROJECT_CONTEXT_ROW_KEY}:${normalizedRootEpicId}`,
    projectId: normalizedProjectId,
    rootEpicId: normalizedRootEpicId,
    rootEpicTitle: rootEpicTitle || "",
    summaryText: normalizedSummaryText,
    revisionHash: normalizedRevisionHash,
    sourceItemCount:
      Number.isInteger(Number(sourceItemCount)) && Number(sourceItemCount) >= 0
        ? Number(sourceItemCount)
        : 0,
    updatedAt: updatedAt || new Date().toISOString()
  };
}

function createProjectContextRepository() {
  const tableName = readOptionalSetting("TABLE_PROJECT_CONTEXTS_NAME", DEFAULT_PROJECT_CONTEXTS_TABLE);
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

  async function getProjectContext({ projectId, rootEpicId }) {
    const normalizedProjectId = requireNonEmptyString(projectId, "projectId");
    const normalizedRootEpicId = normalizePositiveInt(rootEpicId, "rootEpicId");
    const rowKey = `${PROJECT_CONTEXT_ROW_KEY}:${normalizedRootEpicId}`;

    try {
      const entity = await client.getEntity(normalizedProjectId, rowKey);
      entity.summaryText = await readLargeText({
        client,
        partitionKey: normalizedProjectId,
        headRowKey: rowKey,
        propertyName: "summaryText",
        headEntity: entity
      });
      return mapProjectContextEntity(entity);
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  async function upsertProjectContext(projectContextInput) {
    const entity = createProjectContextEntity(projectContextInput);
    await writeLargeText({
      client,
      partitionKey: entity.partitionKey,
      headRowKey: entity.rowKey,
      propertyName: "summaryText",
      text: entity.summaryText,
      baseEntity: entity,
      updateMode: "Replace"
    });
    return mapProjectContextEntity(entity);
  }

  return {
    ensureTable,
    getProjectContext,
    upsertProjectContext
  };
}

module.exports = {
  createProjectContextRepository
};
