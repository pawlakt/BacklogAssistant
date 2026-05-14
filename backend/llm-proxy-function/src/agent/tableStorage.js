const { TableClient } = require("@azure/data-tables");

let DefaultAzureCredential = null;
try {
  ({ DefaultAzureCredential } = require("@azure/identity"));
} catch {
  DefaultAzureCredential = null;
}

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

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    const error = new Error(`Field '${fieldName}' is required.`);
    error.status = 400;
    throw error;
  }

  return value.trim();
}

function escapeODataLiteral(value) {
  return String(value).replaceAll("'", "''");
}

function buildAccountEndpoint(accountName) {
  const overrideEndpoint = readOptionalSetting("TABLES_ENDPOINT");
  if (overrideEndpoint) {
    return overrideEndpoint.replace(/\/+$/, "");
  }

  return `https://${accountName}.table.core.windows.net`;
}

function createTableClient(tableName) {
  const connectionString = readOptionalSetting("TABLE_STORAGE_CONNECTION_STRING");
  if (connectionString) {
    return TableClient.fromConnectionString(connectionString, tableName);
  }

  const accountName = readRequiredSetting("TABLES_ACCOUNT_NAME");
  if (!DefaultAzureCredential) {
    const error = new Error(
      "Managed identity mode requires @azure/identity. Install dependencies in backend/llm-proxy-function."
    );
    error.status = 500;
    throw error;
  }

  return new TableClient(buildAccountEndpoint(accountName), tableName, new DefaultAzureCredential());
}

function isAlreadyExistsError(error) {
  return error?.statusCode === 409;
}

function isNotFoundError(error) {
  return error?.statusCode === 404;
}

module.exports = {
  createTableClient,
  escapeODataLiteral,
  isAlreadyExistsError,
  isNotFoundError,
  readOptionalSetting,
  readRequiredSetting,
  requireNonEmptyString
};
