import * as SDK from "azure-devops-extension-sdk";
import { getWorkItemHostContext } from "./workItemHostBridge";

const WORK_ITEM_FORM_SERVICE_ID = "ms.vss-work-web.work-item-form";

export function readAdoContext() {
  try {
    const webContext = SDK.getWebContext();
    const user = SDK.getUser();
    return {
      project: webContext?.project?.name ?? null,
      projectId: webContext?.project?.id ?? null,
      user: user?.name ?? null,
      userId: user?.id ?? null
    };
  } catch {
    return {
      project: null,
      projectId: null,
      user: null,
      userId: null
    };
  }
}

function readContextFromUrl(urlValue) {
  const rawValue = String(urlValue || "").trim();
  if (!rawValue) {
    return null;
  }

  try {
    const parsedUrl = new URL(rawValue, window.location.origin);
    const pathMatch = parsedUrl.pathname.match(/\/_workitems\/edit\/(\d+)/i);
    const queryParams = parsedUrl.searchParams;
    const hashParams = new URLSearchParams(
      String(parsedUrl.hash || "")
        .replace(/^#/, "")
        .replace(/^[^?]*\?/, "")
    );
    const readParam = (name) => queryParams.get(name) || hashParams.get(name);
    const candidateId = pathMatch
      ? Number(pathMatch[1])
      : Number(
          readParam("workitem") ||
            readParam("workItemId") ||
            readParam("id") ||
            ""
        );
    const candidateType =
      String(
        readParam("workItemType") ||
          readParam("workitemtype") ||
          readParam("type") ||
          ""
      ).trim() || null;

    if (Number.isInteger(candidateId) && candidateId > 0) {
      return {
        workItemId: candidateId,
        workItemType: candidateType
      };
    }
  } catch {
    return null;
  }

  return null;
}

function sleep(delayMs) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
}

export async function resolveWorkItemContext() {
  const diagnostics = [];
  function addDiagnostic(source, payload) {
    diagnostics.push({ source, payload });
  }

  const localWorkItemId = Number(import.meta.env.VITE_WORK_ITEM_ID || "");
  const localWorkItemType = String(import.meta.env.VITE_WORK_ITEM_TYPE || "").trim();

  if (
    ["localhost", "127.0.0.1", "0.0.0.0"].includes(window.location.hostname) &&
    Number.isInteger(localWorkItemId) &&
    localWorkItemId > 0
  ) {
    addDiagnostic("local-env", {
      workItemId: localWorkItemId,
      workItemType: localWorkItemType || null
    });
    return {
      workItemId: localWorkItemId,
      workItemType: localWorkItemType || null,
      isLocalFallback: true
    };
  }

  const bridgedContext = getWorkItemHostContext();
  addDiagnostic("host-bridge", bridgedContext);
  if (Number.isInteger(Number(bridgedContext.workItemId)) && Number(bridgedContext.workItemId) > 0) {
    return {
      workItemId: Number(bridgedContext.workItemId),
      workItemType: bridgedContext.workItemType ? String(bridgedContext.workItemType).trim() : null,
      isLocalFallback: false
    };
  }

  try {
    const configuration = SDK.getConfiguration() || {};
    const witInputs = configuration.witInputs || {};
    const configuredId = Number(
      witInputs.id || configuration.workItemId || configuration.workitemId || ""
    );
    const configuredType =
      String(
        witInputs.workItemType || configuration.workItemType || configuration.workitemType || ""
      ).trim() || null;

    if (Number.isInteger(configuredId) && configuredId > 0) {
      addDiagnostic("sdk-configuration", {
        workItemId: configuredId,
        workItemType: configuredType
      });
      return {
        workItemId: configuredId,
        workItemType: configuredType,
        isLocalFallback: false
      };
    }

    addDiagnostic("sdk-configuration", "missing-id");
  } catch {
    addDiagnostic("sdk-configuration", "error");
    // Continue with service lookup fallback.
  }

  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const service = await SDK.getService(WORK_ITEM_FORM_SERVICE_ID);
      const workItemId = await service.getId();
      const workItemType = await service.getFieldValue("System.WorkItemType");

      if (Number.isInteger(Number(workItemId)) && Number(workItemId) > 0) {
        addDiagnostic("work-item-form-service", {
          attempt: attempt + 1,
          workItemId: Number(workItemId),
          workItemType: workItemType ? String(workItemType).trim() : null
        });
        return {
          workItemId: Number(workItemId),
          workItemType: workItemType ? String(workItemType).trim() : null,
          isLocalFallback: false
        };
      }

      addDiagnostic("work-item-form-service", {
        attempt: attempt + 1,
        status: "missing-id"
      });
    } catch (error) {
      addDiagnostic("work-item-form-service", {
        attempt: attempt + 1,
        status: "error",
        message: String(error?.message || "unknown")
      });
    }

    await sleep(250);
  }

  const fromLocationUrl = readContextFromUrl(window.location.href);
  addDiagnostic("window-location", fromLocationUrl || "missing-id");
  if (fromLocationUrl) {
    return {
      workItemId: fromLocationUrl.workItemId,
      workItemType: fromLocationUrl.workItemType,
      isLocalFallback: false
    };
  }

  const fromReferrer = readContextFromUrl(document.referrer);
  addDiagnostic("document-referrer", fromReferrer || "missing-id");
  if (fromReferrer) {
    return {
      workItemId: fromReferrer.workItemId,
      workItemType: fromReferrer.workItemType,
      isLocalFallback: false
    };
  }

  if (typeof window !== "undefined") {
    window.__AI_ASSISTANT_WORKITEM_CONTEXT_DEBUG__ = diagnostics;
    console.warn("[AI Assistant] Unable to resolve work item context.", diagnostics);
  }

  return {
    workItemId: null,
    workItemType: null,
    isLocalFallback: false
  };
}

export function normalizeRequestError(requestError, fallbackMessage) {
  return {
    message: requestError?.message || fallbackMessage,
    requestId: requestError?.requestId || null
  };
}
