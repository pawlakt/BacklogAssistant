const crypto = require("node:crypto");
const { escapeODataLiteral } = require("./tableStorage");

const INLINE_LIMIT_CHARS = 30000;
const CHUNK_SIZE_CHARS = 24000;
const MAX_CHUNK_COUNT = 512;

function hashText(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function splitIntoChunks(text, chunkSize) {
  const chunks = [];
  for (let start = 0; start < text.length; start += chunkSize) {
    chunks.push(text.slice(start, start + chunkSize));
  }
  return chunks;
}

function buildRowKeyPrefix(headRowKey, version) {
  return `${headRowKey}:chunk:${version}:`;
}

function buildRowKey(headRowKey, version, index) {
  return `${buildRowKeyPrefix(headRowKey, version)}${String(index).padStart(4, "0")}`;
}

async function listRowsByPrefix({ client, partitionKey, rowKeyPrefix, select }) {
  const filter =
    `PartitionKey eq '${escapeODataLiteral(partitionKey)}' and ` +
    `RowKey ge '${escapeODataLiteral(rowKeyPrefix)}' and ` +
    `RowKey lt '${escapeODataLiteral(`${rowKeyPrefix}~`)}'`;

  const rows = [];
  for await (const entity of client.listEntities({
    queryOptions: {
      filter,
      select
    }
  })) {
    rows.push(entity);
  }
  return rows;
}

async function deleteRowsByPrefix({ client, partitionKey, rowKeyPrefix, skipPrefix = "" }) {
  const rows = await listRowsByPrefix({
    client,
    partitionKey,
    rowKeyPrefix,
    select: ["RowKey"]
  });

  for (const row of rows) {
    const rowKey = row.rowKey || row.RowKey;
    if (!rowKey) {
      continue;
    }
    if (skipPrefix && rowKey.startsWith(skipPrefix)) {
      continue;
    }
    await client.deleteEntity(partitionKey, rowKey);
  }
}

async function readLargeText({
  client,
  partitionKey,
  headRowKey,
  propertyName,
  headEntity
}) {
  const entity = headEntity || (await client.getEntity(partitionKey, headRowKey));
  const mode = (entity.storageMode || "").toLowerCase();
  if (mode !== "chunked") {
    return typeof entity[propertyName] === "string" ? entity[propertyName] : "";
  }

  const version = String(entity.contentVersion || "").trim();
  const chunkCount = Number(entity.chunkCount || 0);
  if (!version || !Number.isInteger(chunkCount) || chunkCount <= 0) {
    const error = new Error(`Invalid chunk metadata for ${propertyName}.`);
    error.status = 500;
    throw error;
  }

  const rowKeyPrefix = buildRowKeyPrefix(headRowKey, version);
  const rows = await listRowsByPrefix({
    client,
    partitionKey,
    rowKeyPrefix,
    select: ["chunkText", "RowKey"]
  });
  const sortedRows = rows.sort((a, b) => String(a.rowKey || a.RowKey).localeCompare(String(b.rowKey || b.RowKey)));
  if (sortedRows.length !== chunkCount) {
    const error = new Error(`Chunk count mismatch for ${propertyName}.`);
    error.status = 500;
    throw error;
  }

  const text = sortedRows.map((row) => (typeof row.chunkText === "string" ? row.chunkText : "")).join("");
  if ((entity.contentHash || "") && hashText(text) !== entity.contentHash) {
    const error = new Error(`Chunk hash mismatch for ${propertyName}.`);
    error.status = 500;
    throw error;
  }

  return text;
}

async function writeLargeText({
  client,
  partitionKey,
  headRowKey,
  propertyName,
  text,
  baseEntity,
  updateMode = "Replace"
}) {
  const normalizedText = typeof text === "string" ? text : "";
  const contentHash = hashText(normalizedText);
  const basePrefix = `${headRowKey}:chunk:`;

  if (normalizedText.length <= INLINE_LIMIT_CHARS) {
    const headEntity = {
      ...baseEntity,
      storageMode: "inline",
      contentVersion: "",
      chunkCount: 0,
      contentHash,
      [propertyName]: normalizedText
    };
    await client.upsertEntity(headEntity, updateMode);
    await deleteRowsByPrefix({ client, partitionKey, rowKeyPrefix: basePrefix });
    return headEntity;
  }

  const chunks = splitIntoChunks(normalizedText, CHUNK_SIZE_CHARS);
  if (chunks.length > MAX_CHUNK_COUNT) {
    const error = new Error(`Value for ${propertyName} is too large.`);
    error.status = 413;
    throw error;
  }

  const version = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  for (let index = 0; index < chunks.length; index += 1) {
    await client.upsertEntity(
      {
        partitionKey,
        rowKey: buildRowKey(headRowKey, version, index),
        chunkText: chunks[index]
      },
      "Replace"
    );
  }

  const headEntity = {
    ...baseEntity,
    storageMode: "chunked",
    contentVersion: version,
    chunkCount: chunks.length,
    contentHash
  };
  await client.upsertEntity(headEntity, updateMode);

  const keepPrefix = buildRowKeyPrefix(headRowKey, version);
  await deleteRowsByPrefix({
    client,
    partitionKey,
    rowKeyPrefix: basePrefix,
    skipPrefix: keepPrefix
  });

  return headEntity;
}

module.exports = {
  readLargeText,
  writeLargeText
};
