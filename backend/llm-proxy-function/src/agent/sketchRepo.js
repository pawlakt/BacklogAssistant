const {
  createTableClient,
  isAlreadyExistsError,
  isNotFoundError,
  readOptionalSetting,
  requireNonEmptyString
} = require("./tableStorage");
const { readLargeText, writeLargeText } = require("./largeTextStorage");

const DEFAULT_CONVERSATION_SKETCHES_TABLE = "ConversationSketches";
const CURRENT_SKETCH_ROW_KEY = "current";

function mapSketchEntity(entity) {
  let payload = null;
  if (typeof entity.payloadJson === "string" && entity.payloadJson.trim()) {
    payload = JSON.parse(entity.payloadJson);
  }

  return {
    conversationId: entity.conversationId || entity.partitionKey || entity.PartitionKey,
    sketchId: entity.sketchId || entity.rowKey || entity.RowKey,
    payload,
    sourceSummaryUpdatedAt: entity.sourceSummaryUpdatedAt || null,
    backlogItemsCreatedAt: entity.backlogItemsCreatedAt || null,
    updatedAt: entity.updatedAt || null,
    warnings: Array.isArray(payload?.warnings) ? payload.warnings : []
  };
}

function createSketchRepository() {
  const sketchesTableName = readOptionalSetting(
    "TABLE_CONVERSATION_SKETCHES_NAME",
    DEFAULT_CONVERSATION_SKETCHES_TABLE
  );
  const sketchesClient = createTableClient(sketchesTableName);

  async function ensureTable() {
    try {
      await sketchesClient.createTable();
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }
  }

  async function getCurrentSketch(conversationId) {
    const normalizedConversationId = requireNonEmptyString(conversationId, "conversationId");

    try {
      const entity = await sketchesClient.getEntity(
        normalizedConversationId,
        CURRENT_SKETCH_ROW_KEY
      );
      entity.payloadJson = await readLargeText({
        client: sketchesClient,
        partitionKey: normalizedConversationId,
        headRowKey: CURRENT_SKETCH_ROW_KEY,
        propertyName: "payloadJson",
        headEntity: entity
      });
      return mapSketchEntity(entity);
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  async function upsertCurrentSketch({
    conversationId,
    payload,
    sourceSummaryUpdatedAt,
    backlogItemsCreatedAt,
    updatedAt
  }) {
    const normalizedConversationId = requireNonEmptyString(conversationId, "conversationId");
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      const error = new Error("Field 'payload' must be an object.");
      error.status = 400;
      throw error;
    }

    const entity = {
      partitionKey: normalizedConversationId,
      rowKey: CURRENT_SKETCH_ROW_KEY,
      conversationId: normalizedConversationId,
      sketchId: CURRENT_SKETCH_ROW_KEY,
      sourceSummaryUpdatedAt: sourceSummaryUpdatedAt || null,
      backlogItemsCreatedAt: backlogItemsCreatedAt || null,
      updatedAt: updatedAt || new Date().toISOString()
    };

    const payloadJson = JSON.stringify(payload);
    await writeLargeText({
      client: sketchesClient,
      partitionKey: normalizedConversationId,
      headRowKey: CURRENT_SKETCH_ROW_KEY,
      propertyName: "payloadJson",
      text: payloadJson,
      baseEntity: entity,
      updateMode: "Replace"
    });

    return {
      conversationId: normalizedConversationId,
      sketchId: CURRENT_SKETCH_ROW_KEY,
      payload,
      sourceSummaryUpdatedAt: entity.sourceSummaryUpdatedAt,
      backlogItemsCreatedAt: entity.backlogItemsCreatedAt,
      updatedAt: entity.updatedAt,
      warnings: Array.isArray(payload?.warnings) ? payload.warnings : []
    };
  }

  return {
    ensureTable,
    getCurrentSketch,
    upsertCurrentSketch
  };
}

module.exports = {
  createSketchRepository
};
