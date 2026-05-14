function parseAllowedOrigins() {
  return (process.env.CORS_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function matchesWildcardOrigin(requestOrigin, allowedOrigin) {
  if (!requestOrigin || !allowedOrigin.includes("*")) {
    return false;
  }

  const normalizedAllowed = allowedOrigin.trim();

  // Supported wildcard patterns:
  // - https://*.gallery.vsassets.io
  // - *.gallery.vsassets.io
  const schemePatternMatch = normalizedAllowed.match(/^(https?):\/\/\*\.(.+)$/i);
  if (schemePatternMatch) {
    try {
      const requestUrl = new URL(requestOrigin);
      const allowedProtocol = schemePatternMatch[1].toLowerCase();
      const allowedSuffix = schemePatternMatch[2].toLowerCase();
      return (
        requestUrl.protocol.replace(":", "").toLowerCase() === allowedProtocol &&
        requestUrl.hostname.toLowerCase().endsWith(`.${allowedSuffix}`)
      );
    } catch {
      return false;
    }
  }

  const hostPatternMatch = normalizedAllowed.match(/^\*\.(.+)$/i);
  if (hostPatternMatch) {
    try {
      const requestUrl = new URL(requestOrigin);
      const allowedSuffix = hostPatternMatch[1].toLowerCase();
      return requestUrl.hostname.toLowerCase().endsWith(`.${allowedSuffix}`);
    } catch {
      return false;
    }
  }

  return false;
}

function resolveCorsOrigin(request, allowedOrigins) {
  const requestOrigin = request.headers.get("origin");

  if (allowedOrigins.length === 0 || allowedOrigins.includes("*")) {
    return "*";
  }

  if (
    requestOrigin &&
    allowedOrigins.some(
      (allowedOrigin) =>
        allowedOrigin === requestOrigin ||
        matchesWildcardOrigin(requestOrigin, allowedOrigin)
    )
  ) {
    return requestOrigin;
  }

  return "null";
}

function buildCorsHeaders(request, options = {}) {
  const allowedOrigins = parseAllowedOrigins();
  return {
    "Access-Control-Allow-Origin": resolveCorsOrigin(request, allowedOrigins),
    "Access-Control-Allow-Methods": options.allowedMethods || "GET,POST,PUT,OPTIONS",
    "Access-Control-Allow-Headers": options.allowedHeaders || "Content-Type, x-correlation-id",
    "Access-Control-Max-Age": "86400"
  };
}

function jsonResponse(status, body, headers) {
  return {
    status,
    jsonBody: body,
    headers: {
      "Content-Type": "application/json",
      ...headers
    }
  };
}

function tryReadJson(request) {
  return request
    .json()
    .then((payload) => payload)
    .catch(() => null);
}

function withCors(handler, options = {}) {
  return async (request, context) => {
    const requestId = request.headers.get("x-correlation-id") || context.invocationId;
    const corsHeaders = buildCorsHeaders(request, options);

    if (request.method === "OPTIONS") {
      return {
        status: 204,
        headers: corsHeaders
      };
    }

    try {
      return await handler(request, context, requestId, corsHeaders);
    } catch (error) {
      const errorRequestId = error.requestId || requestId;
      const logPrefix = options.logPrefix || "request";
      context.error(`${logPrefix} failed requestId=${errorRequestId} message=${error.message}`);
      return jsonResponse(
        error.status || 502,
        {
          error: error.message || "Unexpected backend error.",
          requestId: errorRequestId
        },
        {
          ...corsHeaders,
          "x-request-id": errorRequestId
        }
      );
    }
  };
}

module.exports = {
  jsonResponse,
  tryReadJson,
  withCors
};
