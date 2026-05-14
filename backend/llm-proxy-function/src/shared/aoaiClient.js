const DEFAULT_API_VERSION = "2024-10-21";

function readRequiredSetting(name) {
  const value = (process.env[name] || "").trim();
  if (!value) {
    const configurationError = new Error(`Missing required configuration: ${name}`);
    configurationError.status = 500;
    throw configurationError;
  }

  return value;
}

function extractMessageText(messageContent) {
  if (typeof messageContent === "string") {
    return messageContent;
  }

  if (Array.isArray(messageContent)) {
    return messageContent
      .map((part) => {
        if (!part || typeof part !== "object") {
          return "";
        }

        if (typeof part.text?.value === "string") {
          return part.text.value;
        }

        if (typeof part.text === "string") {
          return part.text;
        }

        return "";
      })
      .join("")
      .trim();
  }

  return "";
}

function mapUsage(usage) {
  if (!usage) {
    return null;
  }

  return {
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0
  };
}

function resolveCallArgs(arg1, arg2, arg3) {
  if (typeof arg3 === "string") {
    return {
      requestBody: arg2,
      requestId: arg3
    };
  }

  return {
    requestBody: arg1,
    requestId: arg2
  };
}

async function callAzureOpenAI(arg1, arg2, arg3) {
  const { requestBody, requestId } = resolveCallArgs(arg1, arg2, arg3);
  const endpoint = readRequiredSetting("AOAI_ENDPOINT").replace(/\/+$/, "");
  const deployment = readRequiredSetting("AOAI_DEPLOYMENT");
  const apiKey = readRequiredSetting("AOAI_API_KEY");
  const apiVersion = (process.env.AOAI_API_VERSION || DEFAULT_API_VERSION).trim();

  const url =
    `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}` +
    `/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;

  const upstreamResponse = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": apiKey,
      "x-ms-client-request-id": requestId
    },
    body: JSON.stringify(requestBody)
  });
  const upstreamRequestId =
    upstreamResponse.headers.get("x-request-id") ||
    upstreamResponse.headers.get("apim-request-id") ||
    requestId;

  let upstreamPayload = null;
  try {
    upstreamPayload = await upstreamResponse.json();
  } catch {
    upstreamPayload = null;
  }
  if (!upstreamResponse.ok) {
    const upstreamError = new Error(
      upstreamPayload?.error?.message ||
        `Model request failed with HTTP ${upstreamResponse.status}.`
    );
    upstreamError.status = upstreamResponse.status >= 500 ? 502 : upstreamResponse.status;
    upstreamError.requestId = upstreamRequestId;
    throw upstreamError;
  }

  const responseText = extractMessageText(upstreamPayload?.choices?.[0]?.message?.content);

  return {
    responseText,
    model: upstreamPayload?.model || deployment,
    requestId: upstreamRequestId,
    usage: mapUsage(upstreamPayload?.usage),
    rawPayload: upstreamPayload
  };
}

module.exports = {
  callAzureOpenAI
};
