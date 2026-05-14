function readOptionalSetting(name, fallbackValue = "") {
  const value = (process.env[name] || "").trim();
  return value || fallbackValue;
}

function parseBooleanSetting(name, fallbackValue = false) {
  const value = readOptionalSetting(name);
  if (!value) {
    return fallbackValue;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function readHeaderValue(request, headerName) {
  return (request.headers.get(headerName) || "").trim();
}

function readQueryValue(request, key) {
  const url = String(request?.url || "").trim();
  if (!url) {
    return "";
  }

  try {
    const parsed = new URL(url);
    return String(parsed.searchParams.get(key) || "").trim();
  } catch {
    return "";
  }
}

function normalizeProjectContextValue(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }

  // Azure Table partition keys cannot contain these characters.
  if (/[\/\\#\?]/.test(normalized)) {
    return "";
  }

  return normalized;
}

function firstNonEmpty(values) {
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function resolveUserContextFromHeaders(request) {
  const adoUserId = firstNonEmpty([
    readHeaderValue(request, "x-ado-user-id"),
    readHeaderValue(request, "x-ms-client-principal-id"),
    readHeaderValue(request, "x-vss-userid"),
    readQueryValue(request, "adoUserId"),
    readQueryValue(request, "userId")
  ]);
  const projectId = firstNonEmpty([
    readHeaderValue(request, "x-ado-project-id"),
    readHeaderValue(request, "x-ado-project-name"),
    readHeaderValue(request, "x-vss-project-id"),
    readHeaderValue(request, "x-vss-project-name"),
    readQueryValue(request, "adoProjectId"),
    readQueryValue(request, "projectId"),
    readQueryValue(request, "project")
  ]);
  const userDisplayName = readHeaderValue(request, "x-ado-user-name");
  const fallbackProjectId = normalizeProjectContextValue(readOptionalSetting("ADO_PROJECT", ""));
  const fallbackUserId = readOptionalSetting("ADO_FALLBACK_USER_ID", "ado-extension-user");

  return {
    adoUserId: adoUserId || fallbackUserId,
    projectId: normalizeProjectContextValue(projectId) || fallbackProjectId,
    userDisplayName
  };
}

async function resolveRequestAuthContext(request) {
  const requireTokenValidation = parseBooleanSetting("ENABLE_ADO_TOKEN_VALIDATION", false);
  const contextFromHeaders = resolveUserContextFromHeaders(request);

  if (!contextFromHeaders.adoUserId) {
    const error = new Error(
      "Missing user context. Expected one of: x-ado-user-id, x-ms-client-principal-id, x-vss-userid, adoUserId."
    );
    error.status = 401;
    throw error;
  }

  if (!contextFromHeaders.projectId) {
    const error = new Error(
      "Missing project context. Expected one of: x-ado-project-id, x-ado-project-name, x-vss-project-id, adoProjectId, or ADO_PROJECT setting."
    );
    error.status = 400;
    throw error;
  }

  if (requireTokenValidation) {
    const error = new Error(
      "ADO token validation is enabled but not implemented yet for agent endpoints."
    );
    error.status = 501;
    throw error;
  }

  return contextFromHeaders;
}

module.exports = {
  resolveRequestAuthContext
};
