import * as SDK from "azure-devops-extension-sdk";

const listeners = new Set();
let initialized = false;
let latestContext = {
  workItemId: null,
  workItemType: null
};

function normalizeWorkItemId(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeWorkItemType(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function extractContextCandidate(source) {
  if (!source || typeof source !== "object") {
    return null;
  }

  const directId =
    source.id ??
    source.workItemId ??
    source.workitemId ??
    source?.workItem?.workItemId ??
    source?.workItem?.id ??
    source?.workItemIds?.[0] ??
    source?.witInputs?.id;
  const directType =
    source.workItemType ??
    source.workitemType ??
    source?.workItem?.workItemTypeName ??
    source?.workItem?.workItemType ??
    source?.workItem?.type ??
    source?.witInputs?.workItemType;

  const workItemId = normalizeWorkItemId(directId);
  const workItemType = normalizeWorkItemType(directType);

  if (!workItemId) {
    return null;
  }

  return {
    workItemId,
    workItemType
  };
}

function notifyListeners() {
  for (const listener of listeners) {
    listener(latestContext);
  }
}

function setContextIfChanged(nextContext) {
  if (!nextContext) {
    return;
  }

  if (
    latestContext.workItemId === nextContext.workItemId &&
    latestContext.workItemType === nextContext.workItemType
  ) {
    return;
  }

  latestContext = nextContext;
  notifyListeners();
}

function readConfigurationContext() {
  try {
    return extractContextCandidate(SDK.getConfiguration() || {});
  } catch {
    return null;
  }
}

export function initWorkItemHostBridge() {
  if (initialized) {
    return;
  }

  let contributionId = "";
  try {
    contributionId = SDK.getContributionId();
  } catch {
    return;
  }

  if (!contributionId) {
    return;
  }

  initialized = true;
  setContextIfChanged(readConfigurationContext());

  SDK.register(contributionId, () => ({
    onLoaded(args) {
      setContextIfChanged(extractContextCandidate(args));
      return Promise.resolve();
    },
    onRefreshed(args) {
      setContextIfChanged(extractContextCandidate(args));
      return Promise.resolve();
    },
    onFieldChanged(args) {
      setContextIfChanged(extractContextCandidate(args));
      return Promise.resolve();
    },
    onSaved() {
      return Promise.resolve();
    },
    onReset() {
      return Promise.resolve();
    },
    onUnloaded() {
      return Promise.resolve();
    }
  }));
}

export function getWorkItemHostContext() {
  return latestContext;
}

export function subscribeWorkItemHostContext(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
