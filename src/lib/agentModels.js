function formatUserDisplayName(rawValue) {
  const original = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!original) {
    return null;
  }

  const localPart = original.includes("@") ? original.split("@")[0] : original;
  const normalized = localPart
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return original;
  }

  const formatted = normalized
    .split(" ")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");

  return formatted || original;
}

export function normalizeAgentMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map((message, index) => ({
      id:
        typeof message?.id === "string" && message.id.trim()
          ? message.id.trim()
          : `msg-${index}-${Date.now()}`,
      role: message?.role === "assistant" ? "assistant" : "user",
      content: typeof message?.content === "string" ? message.content : "",
      createdAt: typeof message?.createdAt === "string" ? message.createdAt : null,
      authorDisplayName: formatUserDisplayName(message?.authorDisplayName)
    }))
    .filter((message) => message.content.trim().length > 0);
}

export function normalizeConversationSummary(summary) {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    return null;
  }

  const normalizeItems = (value) =>
    Array.isArray(value)
      ? value
          .map((item) => (typeof item === "string" ? item.trim() : ""))
          .filter(Boolean)
      : [];

  const clarifiedScope =
    typeof summary.clarifiedScope === "string" ? summary.clarifiedScope.trim() : "";

  if (!clarifiedScope) {
    return null;
  }

  const rawMessageCount = Number(summary.messageCount);

  return {
    clarifiedScope,
    assumptions: normalizeItems(summary.assumptions),
    openQuestions: normalizeItems(summary.openQuestions),
    implementationNotes: normalizeItems(summary.implementationNotes),
    messageCount: Number.isFinite(rawMessageCount) ? rawMessageCount : null,
    summarizedAt: typeof summary.summarizedAt === "string" ? summary.summarizedAt : null,
    editedAt: typeof summary.editedAt === "string" ? summary.editedAt : null
  };
}

export function createSummaryEditDraft(summary) {
  return {
    clarifiedScope: summary?.clarifiedScope || "",
    assumptions: Array.isArray(summary?.assumptions) ? summary.assumptions.join("\n") : "",
    openQuestions: Array.isArray(summary?.openQuestions) ? summary.openQuestions.join("\n") : "",
    implementationNotes: Array.isArray(summary?.implementationNotes)
      ? summary.implementationNotes.join("\n")
      : ""
  };
}

function splitTextAreaLines(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function buildSummaryUpdatePayload(draft, currentSummary) {
  return {
    clarifiedScope: String(draft?.clarifiedScope || "").trim(),
    assumptions: splitTextAreaLines(draft?.assumptions),
    openQuestions: splitTextAreaLines(draft?.openQuestions),
    implementationNotes: splitTextAreaLines(draft?.implementationNotes),
    messageCount: currentSummary?.messageCount ?? 0,
    summarizedAt: currentSummary?.summarizedAt || new Date().toISOString(),
    editedAt: new Date().toISOString()
  };
}
