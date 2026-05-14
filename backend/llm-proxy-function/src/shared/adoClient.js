const DEFAULT_ADO_PROJECT = "Nublado";
const DEFAULT_ADO_API_VERSION = "7.1-preview.3";
const DEFAULT_ADO_EPIC_TYPE = "Epic";
const DEFAULT_ADO_FEATURE_TYPE = "Feature";
const DEFAULT_ADO_BACKLOG_TYPE = "Product Backlog Item";
const DEFAULT_ADO_TASK_TYPE = "Task";
const DEFAULT_TASK_ORIGINAL_ESTIMATE_FIELD = "Microsoft.VSTS.Scheduling.OriginalEstimate";
const DEFAULT_EFFORT_FIELD = "Microsoft.VSTS.Scheduling.Effort";
const ACCEPTANCE_CRITERIA_FALLBACK_FIELDS = ["Microsoft.VSTS.Common.AcceptanceCriteria"];
const DEFAULT_ACCEPTANCE_CRITERIA_FIELD = "Microsoft.VSTS.Common.AcceptanceCriteria";
const STORY_POINTS_FALLBACK_FIELDS = [
  "Microsoft.VSTS.Scheduling.StoryPoints",
  "Microsoft.VSTS.Scheduling.Effort"
];
const WORK_ITEM_CONTEXT_FIELDS = [
  "System.Title",
  "System.WorkItemType",
  "System.Description",
  "System.State",
  ...ACCEPTANCE_CRITERIA_FALLBACK_FIELDS,
  ...STORY_POINTS_FALLBACK_FIELDS
];

function readRequiredSetting(name) {
  const value = (process.env[name] || "").trim();
  if (!value) {
    const configurationError = new Error(`Missing required configuration: ${name}`);
    configurationError.status = 500;
    throw configurationError;
  }

  return value;
}

function readOptionalSetting(name, fallbackValue) {
  const value = (process.env[name] || "").trim();
  return value || fallbackValue;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeHtmlWithLineBreaks(value) {
  return escapeHtml(value)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n/g, "<br/>");
}

function toHtmlList(items, ordered = false) {
  if (!Array.isArray(items) || items.length === 0) {
    return "";
  }

  const listTag = ordered ? "ol" : "ul";
  return `<${listTag}>${items.map((item) => `<li>${escapeHtmlWithLineBreaks(item)}</li>`).join("")}</${listTag}>`;
}

function buildDescriptionHtml({ description, acceptanceCriteria, taskHints, includeAcceptanceCriteria = true }) {
  const sections = [];

  if (description) {
    sections.push(`<p>${escapeHtmlWithLineBreaks(description)}</p>`);
  }

  if (includeAcceptanceCriteria && Array.isArray(acceptanceCriteria) && acceptanceCriteria.length > 0) {
    sections.push("<p><strong>Acceptance Criteria</strong></p>");
    sections.push(toHtmlList(acceptanceCriteria, true));
  }

  if (Array.isArray(taskHints) && taskHints.length > 0) {
    sections.push("<p><strong>Suggested Tasks</strong></p>");
    sections.push(toHtmlList(taskHints));
  }

  return sections.join("");
}

function buildAcceptanceCriteriaHtml(acceptanceCriteria) {
  if (!Array.isArray(acceptanceCriteria) || acceptanceCriteria.length === 0) {
    return "";
  }

  return toHtmlList(acceptanceCriteria, true);
}

function getAdoConfiguration() {
  return {
    orgUrl: readRequiredSetting("ADO_ORG_URL").replace(/\/+$/, ""),
    pat: readRequiredSetting("ADO_PAT"),
    project: readOptionalSetting("ADO_PROJECT", DEFAULT_ADO_PROJECT),
    apiVersion: readOptionalSetting("ADO_API_VERSION", DEFAULT_ADO_API_VERSION),
    epicWorkItemType: readOptionalSetting("ADO_EPIC_WORK_ITEM_TYPE", DEFAULT_ADO_EPIC_TYPE),
    featureWorkItemType: readOptionalSetting(
      "ADO_FEATURE_WORK_ITEM_TYPE",
      DEFAULT_ADO_FEATURE_TYPE
    ),
    backlogWorkItemType: readOptionalSetting(
      "ADO_BACKLOG_WORK_ITEM_TYPE",
      DEFAULT_ADO_BACKLOG_TYPE
    ),
    taskWorkItemType: readOptionalSetting("ADO_TASK_WORK_ITEM_TYPE", DEFAULT_ADO_TASK_TYPE),
    storyPointsField: readOptionalSetting("ADO_STORY_POINTS_FIELD", ""),
    taskOriginalEstimateField: readOptionalSetting("ADO_TASK_ORIGINAL_ESTIMATE_FIELD", ""),
    taskOriginalEstimateDefault: normalizePositiveNumber(
      readOptionalSetting("ADO_TASK_ORIGINAL_ESTIMATE_DEFAULT", "1"),
      1
    )
  };
}

function normalizePositiveNumber(value, fallbackValue) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : fallbackValue;
}

function resolveTaskOriginalEstimate(taskNode, fallbackValue) {
  return normalizePositiveNumber(taskNode?.originalEstimate, fallbackValue);
}

function sumTaskOriginalEstimateHours(taskNodes, fallbackValue) {
  const normalizedTaskNodes = Array.isArray(taskNodes) ? taskNodes : [];
  return normalizedTaskNodes.reduce(
    (total, taskNode) => total + resolveTaskOriginalEstimate(taskNode, fallbackValue),
    0
  );
}

function convertHoursToEffortPoints(totalHours) {
  const hours = Number(totalHours);
  if (!Number.isFinite(hours) || hours <= 0) {
    return 0;
  }
  if (hours < 8) {
    return 1;
  }

  const fullPoints = Math.floor(hours / 8);
  const remainder = hours % 8;
  return remainder > 4 ? fullPoints + 1 : fullPoints;
}

async function createAdoWorkItem({ config, workItemType, patchDocument, requestId }) {
  const url =
    `${config.orgUrl}/${encodeURIComponent(config.project)}` +
    `/_apis/wit/workitems/$${encodeURIComponent(workItemType)}` +
    `?api-version=${encodeURIComponent(config.apiVersion)}`;
  const authHeader = `Basic ${Buffer.from(`:${config.pat}`).toString("base64")}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json-patch+json",
      Accept: "application/json",
      Authorization: authHeader,
      "x-ms-client-request-id": requestId
    },
    body: JSON.stringify(patchDocument)
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message =
      payload?.message ||
      payload?.error?.message ||
      `Azure DevOps request failed with HTTP ${response.status}.`;
    const error = new Error(message);
    error.status = response.status >= 500 ? 502 : response.status;
    throw error;
  }

  return payload;
}

async function updateAdoWorkItem({ config, workItemId, patchDocument, requestId }) {
  const url =
    `${config.orgUrl}/${encodeURIComponent(config.project)}` +
    `/_apis/wit/workitems/${encodeURIComponent(workItemId)}` +
    `?api-version=${encodeURIComponent(config.apiVersion)}`;
  const authHeader = `Basic ${Buffer.from(`:${config.pat}`).toString("base64")}`;

  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json-patch+json",
      Accept: "application/json",
      Authorization: authHeader,
      "x-ms-client-request-id": requestId
    },
    body: JSON.stringify(patchDocument)
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message =
      payload?.message ||
      payload?.error?.message ||
      `Azure DevOps request failed with HTTP ${response.status}.`;
    const error = new Error(message);
    error.status = response.status >= 500 ? 502 : response.status;
    throw error;
  }

  return payload;
}

async function updateAdoWorkItemEffort({
  config,
  workItemId,
  effortPoints,
  requestId
}) {
  return updateAdoWorkItem({
    config,
    workItemId,
    requestId,
    patchDocument: [
      {
        op: "add",
        path: `/fields/${DEFAULT_EFFORT_FIELD}`,
        value: Number(effortPoints)
      }
    ]
  });
}

function createAdoAuthHeader(config) {
  return `Basic ${Buffer.from(`:${config.pat}`).toString("base64")}`;
}

async function requestAdoJson({
  config,
  method,
  path,
  apiVersion,
  requestId,
  body,
  headers
}) {
  const url =
    `${config.orgUrl}/${encodeURIComponent(config.project)}` +
    `${path}${path.includes("?") ? "&" : "?"}api-version=${encodeURIComponent(
      apiVersion || config.apiVersion
    )}`;

  const response = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: createAdoAuthHeader(config),
      "x-ms-client-request-id": requestId,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(headers || {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message =
      payload?.message ||
      payload?.error?.message ||
      `Azure DevOps request failed with HTTP ${response.status}.`;
    const error = new Error(message);
    error.status = response.status >= 500 ? 502 : response.status;
    throw error;
  }

  return payload;
}

function stripHtml(value) {
  const rawValue = typeof value === "string" ? value : "";
  return rawValue.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function getStoryPointsFromFields(fields, configuredField) {
  if (configuredField && Number.isFinite(Number(fields?.[configuredField]))) {
    return Number(fields[configuredField]);
  }

  for (const field of STORY_POINTS_FALLBACK_FIELDS) {
    const numericValue = Number(fields?.[field]);
    if (Number.isFinite(numericValue)) {
      return numericValue;
    }
  }

  return null;
}

function getAcceptanceCriteriaFromFields(fields) {
  for (const field of ACCEPTANCE_CRITERIA_FALLBACK_FIELDS) {
    const value = stripHtml(fields?.[field]);
    if (value) {
      return value;
    }
  }

  return "";
}

function normalizeWorkItemType(value) {
  return String(value || "").trim().toLowerCase();
}

function isEpicType(workItemType, config) {
  const normalizedType = normalizeWorkItemType(workItemType);
  const configuredEpicType = normalizeWorkItemType(config?.epicWorkItemType);
  return normalizedType === "epic" || (configuredEpicType && normalizedType === configuredEpicType);
}

function isFeatureType(workItemType, config) {
  const normalizedType = normalizeWorkItemType(workItemType);
  const configuredFeatureType = normalizeWorkItemType(config?.featureWorkItemType);
  return normalizedType === "feature" || (configuredFeatureType && normalizedType === configuredFeatureType);
}

function isBacklogType(workItemType, config) {
  const normalizedType = normalizeWorkItemType(workItemType);
  const configuredBacklogType = normalizeWorkItemType(config?.backlogWorkItemType);
  return (
    normalizedType === "product backlog item" ||
    normalizedType === "pbi" ||
    (configuredBacklogType && normalizedType === configuredBacklogType)
  );
}

function mapContextWorkItem(payload, config) {
  const fields = payload?.fields || {};
  return {
    id: payload?.id,
    type: String(fields["System.WorkItemType"] || "").trim(),
    title: String(fields["System.Title"] || "").trim(),
    description: stripHtml(fields["System.Description"]),
    acceptanceCriteria: getAcceptanceCriteriaFromFields(fields),
    state: String(fields["System.State"] || "").trim(),
    storyPoints: getStoryPointsFromFields(fields, config.storyPointsField),
    url: payload?.url || "",
    webUrl: buildAdoWorkItemWebUrl(config, payload?.id),
    parentId: null,
    childIds: Array.isArray(payload?.relations)
      ? payload.relations
          .filter((relation) => relation?.rel === "System.LinkTypes.Hierarchy-Forward")
          .map((relation) => Number(String(relation.url || "").split("/").pop()))
          .filter((id) => Number.isInteger(id) && id > 0)
      : []
  };
}

function mapParentIdFromRelations(workItemPayload) {
  const parentRelation = Array.isArray(workItemPayload?.relations)
    ? workItemPayload.relations.find(
        (relation) => relation?.rel === "System.LinkTypes.Hierarchy-Reverse"
      )
    : null;

  if (!parentRelation?.url) {
    return null;
  }

  const parsedId = Number(String(parentRelation.url).split("/").pop());
  return Number.isInteger(parsedId) && parsedId > 0 ? parsedId : null;
}

async function getWorkItemById({ config, workItemId, requestId }) {
  return requestAdoJson({
    config,
    method: "GET",
    path:
      `/_apis/wit/workitems/${encodeURIComponent(workItemId)}` +
      `?$expand=${encodeURIComponent("relations")}`,
    requestId
  });
}

function classifyGenerationMode(workItemType, config) {
  const normalizedType = normalizeWorkItemType(workItemType);
  if (isEpicType(normalizedType, config)) {
    return "epic";
  }
  if (isFeatureType(normalizedType, config)) {
    return "feature";
  }
  if (isBacklogType(normalizedType, config)) {
    return "pbi";
  }
  if (normalizedType === "task") {
    return "task";
  }

  const error = new Error(
    `Unsupported work item type '${workItemType}'. Supported: Epic, Feature, Product Backlog Item, Task.`
  );
  error.status = 400;
  throw error;
}

async function collectDescendants({ config, requestId, rootIds }) {
  const collected = [];
  const visited = new Set();
  const queue = Array.from(
    new Set((Array.isArray(rootIds) ? rootIds : []).map((id) => Number(id)).filter(Boolean))
  );

  while (queue.length > 0) {
    const levelIds = queue.splice(0, 40).filter((id) => !visited.has(id));
    if (levelIds.length === 0) {
      continue;
    }

    const payloads = await Promise.all(
      levelIds.map((id) =>
        getWorkItemById({
          config,
          workItemId: id,
          requestId
        })
      )
    );

    for (const payload of payloads) {
      const mapped = mapContextWorkItem(payload, config);
      mapped.parentId = mapParentIdFromRelations(payload);
      if (visited.has(mapped.id)) {
        continue;
      }
      visited.add(mapped.id);
      collected.push(mapped);

      for (const childId of mapped.childIds || []) {
        if (!visited.has(childId)) {
          queue.push(childId);
        }
      }
    }
  }

  return collected;
}

function toRevisionNode(item) {
  return {
    id: item.id,
    parentId: item.parentId || null,
    type: item.type || "",
    title: item.title || "",
    description: item.description || "",
    acceptanceCriteria: item.acceptanceCriteria || "",
    state: item.state || ""
  };
}

function buildEpicHierarchySnapshot({ rootEpic, features, pbisByFeatureId, orphanPbis }) {
  return {
    rootEpic: toRevisionNode(rootEpic),
    features: features.map((feature) => ({
      ...toRevisionNode(feature),
      pbis: (pbisByFeatureId.get(feature.id) || []).map((pbi) => toRevisionNode(pbi))
    })),
    orphanPbis: orphanPbis.map((pbi) => toRevisionNode(pbi))
  };
}

async function resolveRootEpicWorkItem({ config, sourcePayload, requestId }) {
  let currentPayload = sourcePayload;
  const visited = new Set();

  while (true) {
    const currentWorkItem = mapContextWorkItem(currentPayload, config);
    currentWorkItem.parentId = mapParentIdFromRelations(currentPayload);

    if (isEpicType(currentWorkItem.type, config)) {
      return currentWorkItem;
    }

    if (!currentWorkItem.parentId) {
      const error = new Error("Unable to resolve root Epic for current work item.");
      error.status = 400;
      throw error;
    }

    if (visited.has(currentWorkItem.parentId)) {
      const error = new Error("Detected cyclic parent linkage while resolving root Epic.");
      error.status = 502;
      throw error;
    }
    visited.add(currentWorkItem.parentId);

    currentPayload = await getWorkItemById({
      config,
      workItemId: currentWorkItem.parentId,
      requestId
    });
  }
}

async function buildEpicScopeContext({ workItemId, requestId }) {
  const config = getAdoConfiguration();
  const sourcePayload = await getWorkItemById({ config, workItemId, requestId });
  const sourceWorkItem = mapContextWorkItem(sourcePayload, config);
  sourceWorkItem.parentId = mapParentIdFromRelations(sourcePayload);

  const rootEpic = await resolveRootEpicWorkItem({
    config,
    sourcePayload,
    requestId
  });

  const descendants = await collectDescendants({
    config,
    requestId,
    rootIds: rootEpic.childIds || []
  });

  const features = descendants
    .filter((item) => isFeatureType(item.type, config))
    .sort((left, right) => left.id - right.id);

  const pbis = descendants
    .filter((item) => isBacklogType(item.type, config))
    .sort((left, right) => left.id - right.id);

  const pbisByFeatureId = new Map();
  const orphanPbis = [];
  for (const pbi of pbis) {
    if (Number.isInteger(pbi.parentId) && pbi.parentId > 0) {
      const existing = pbisByFeatureId.get(pbi.parentId) || [];
      existing.push(pbi);
      pbisByFeatureId.set(pbi.parentId, existing);
    } else {
      orphanPbis.push(pbi);
    }
  }

  const hierarchySnapshot = buildEpicHierarchySnapshot({
    rootEpic,
    features,
    pbisByFeatureId,
    orphanPbis
  });

  return {
    config,
    sourceWorkItem,
    rootEpic,
    features,
    pbis,
    sourceItemCount: 1 + features.length + pbis.length,
    hierarchySnapshot,
    revisionSource: {
      rootEpic: toRevisionNode(rootEpic),
      features: features.map(toRevisionNode),
      pbis: pbis.map(toRevisionNode)
    }
  };
}

async function buildWorkItemDraftContext({ workItemId, requestId }) {
  const config = getAdoConfiguration();
  const sourcePayload = await getWorkItemById({ config, workItemId, requestId });
  const sourceWorkItem = mapContextWorkItem(sourcePayload, config);
  sourceWorkItem.parentId = mapParentIdFromRelations(sourcePayload);

  const generationMode = classifyGenerationMode(sourceWorkItem.type, config);
  let parentContainer = sourceWorkItem;
  let relevantItems = [];
  let parentFeature = null;
  let sourcePbi = null;

  if (generationMode === "epic") {
    relevantItems = await collectDescendants({
      config,
      requestId,
      rootIds: sourceWorkItem.childIds
    });
  } else if (generationMode === "feature") {
    if (!sourceWorkItem.parentId) {
      const error = new Error("Feature does not have a parent Epic.");
      error.status = 400;
      throw error;
    }

    const epicPayload = await getWorkItemById({
      config,
      workItemId: sourceWorkItem.parentId,
      requestId
    });
    const epic = mapContextWorkItem(epicPayload, config);
    epic.parentId = mapParentIdFromRelations(epicPayload);

    const siblingFeatures = (epic.childIds || []).filter((id) => id !== sourceWorkItem.id);
    const siblingBranches = await collectDescendants({
      config,
      requestId,
      rootIds: siblingFeatures
    });
    const currentFeatureBranch = await collectDescendants({
      config,
      requestId,
      rootIds: sourceWorkItem.childIds
    });

    parentContainer = sourceWorkItem;
    parentFeature = sourceWorkItem;
    relevantItems = [
      ...siblingBranches.filter((item) => item.type),
      ...currentFeatureBranch.filter((item) => item.type)
    ];
  } else if (generationMode === "pbi") {
    sourcePbi = sourceWorkItem;
    if (sourceWorkItem.parentId) {
      const featurePayload = await getWorkItemById({
        config,
        workItemId: sourceWorkItem.parentId,
        requestId
      });
      parentFeature = mapContextWorkItem(featurePayload, config);
      parentFeature.parentId = mapParentIdFromRelations(featurePayload);
    }

    const childTasks = await collectDescendants({
      config,
      requestId,
      rootIds: sourceWorkItem.childIds
    });
    relevantItems = childTasks.filter((item) => item.type);
  } else {
    if (!sourceWorkItem.parentId) {
      const error = new Error("Task context requires a parent Product Backlog Item.");
      error.status = 400;
      throw error;
    }

    const pbiPayload = await getWorkItemById({
      config,
      workItemId: sourceWorkItem.parentId,
      requestId
    });
    const pbi = mapContextWorkItem(pbiPayload, config);
    pbi.parentId = mapParentIdFromRelations(pbiPayload);
    sourcePbi = pbi;

    if (pbi.parentId) {
      const featurePayload = await getWorkItemById({
        config,
        workItemId: pbi.parentId,
        requestId
      });
      parentFeature = mapContextWorkItem(featurePayload, config);
      parentFeature.parentId = mapParentIdFromRelations(featurePayload);
    }

    const childTasks = await collectDescendants({
      config,
      requestId,
      rootIds: pbi.childIds
    });

    parentContainer = sourceWorkItem;
    relevantItems = childTasks.filter((item) => item.type);
  }

  const deduplicatedRelevantItems = Array.from(
    new Map(relevantItems.map((item) => [item.id, item])).values()
  );

  return {
    config,
    generationMode,
    sourceWorkItem,
    parentContainer,
    parentFeature,
    sourcePbi,
    existingItems: deduplicatedRelevantItems
  };
}

function ensureNodeHasTitle(node, label) {
  const title = String(node?.title || "").trim();
  if (!title) {
    const error = new Error(`${label} requires a title.`);
    error.status = 400;
    throw error;
  }

  return title;
}

async function createWorkItemScopedBacklog({
  workItemContext,
  sketch,
  requestId,
  context
}) {
  const config = workItemContext?.config || getAdoConfiguration();
  const root = sketch?.root;
  if (!root) {
    const error = new Error("Field 'sketch.root' is required.");
    error.status = 400;
    throw error;
  }

  const parentContainerId = Number(workItemContext?.parentContainer?.id);
  if (!Number.isInteger(parentContainerId) || parentContainerId <= 0) {
    const error = new Error("Parent work item context is missing.");
    error.status = 400;
    throw error;
  }
  const sourceWorkItemId = Number(workItemContext?.sourceWorkItem?.id);
  const sourceWorkItemType = String(
    workItemContext?.sourceWorkItem?.type || ""
  ).trim();

  const mode = workItemContext.generationMode;
  const createdFeatures = [];
  const createdPbis = [];
  const createdTasks = [];
  const effortSummaryPbis = [];
  let shouldAttachTaskOriginalEstimate = Boolean(config.taskOriginalEstimateField);
  const taskOriginalEstimateField =
    config.taskOriginalEstimateField || DEFAULT_TASK_ORIGINAL_ESTIMATE_FIELD;
  const taskOriginalEstimateValue = config.taskOriginalEstimateDefault;

  async function createTaskItem(taskNode, pbiId) {
    const taskTitle = ensureNodeHasTitle(taskNode, "Task");
    const resolvedTaskOriginalEstimate = resolveTaskOriginalEstimate(
      taskNode,
      taskOriginalEstimateValue
    );
    const buildTaskPatchDocument = (includeOriginalEstimate) =>
      buildPatchDocument({
        config,
        workItemType: config.taskWorkItemType,
        title: taskTitle,
        description: taskNode.description || "",
        acceptanceCriteria: Array.isArray(taskNode.acceptanceCriteria)
          ? taskNode.acceptanceCriteria
          : [],
        parentId: pbiId,
        extraNumericFields: includeOriginalEstimate
          ? [
              {
                path: taskOriginalEstimateField,
                value: resolvedTaskOriginalEstimate
              }
            ]
          : []
      });

    try {
      return await createAdoWorkItem({
        config,
        workItemType: config.taskWorkItemType,
        patchDocument: buildTaskPatchDocument(shouldAttachTaskOriginalEstimate),
        requestId
      });
    } catch (error) {
      if (!shouldAttachTaskOriginalEstimate && isOriginalEstimateRequiredError(error)) {
        shouldAttachTaskOriginalEstimate = true;
        return createAdoWorkItem({
          config,
          workItemType: config.taskWorkItemType,
          patchDocument: buildTaskPatchDocument(true),
          requestId
        });
      }
      throw error;
    }
  }

  if (mode === "epic") {
    for (const featureNode of root.features || []) {
      const featureTitle = ensureNodeHasTitle(featureNode, "Feature");
      const createdFeature = await createAdoWorkItemWithAcceptanceCriteriaFallback({
        config,
        workItemType: config.featureWorkItemType,
        patchInput: {
          title: featureTitle,
          description: featureNode.description || "",
          acceptanceCriteria: featureNode.acceptanceCriteria || [],
          parentId: parentContainerId
        },
        requestId,
        context
      });

      createdFeatures.push(
        mapCreatedItem(
          createdFeature,
          featureTitle,
          config,
          parentContainerId,
          config.featureWorkItemType
        )
      );
    }
  } else if (mode === "feature") {
    let featureEffortPoints = 0;
    for (const pbiNode of root.pbis || []) {
      const pbiTitle = ensureNodeHasTitle(pbiNode, "PBI");
      const createdPbi = await createAdoWorkItemWithAcceptanceCriteriaFallback({
        config,
        workItemType: config.backlogWorkItemType,
        patchInput: {
          title: pbiTitle,
          description: pbiNode.description || "",
          acceptanceCriteria: pbiNode.acceptanceCriteria || [],
          parentId: parentContainerId
        },
        requestId,
        context
      });

      const mappedPbi = mapCreatedItem(
        createdPbi,
        pbiTitle,
        config,
        parentContainerId,
        config.backlogWorkItemType
      );
      createdPbis.push(mappedPbi);

      const pbiTaskHours = sumTaskOriginalEstimateHours(pbiNode.tasks || [], taskOriginalEstimateValue);
      const pbiEffortPoints = convertHoursToEffortPoints(pbiTaskHours);

      for (const taskNode of pbiNode.tasks || []) {
        const createdTask = await createTaskItem(taskNode, createdPbi.id);
        createdTasks.push(
          mapCreatedItem(
            createdTask,
            taskNode.title,
            config,
            createdPbi.id,
            config.taskWorkItemType
          )
        );
      }

      await updateAdoWorkItemEffort({
        config,
        workItemId: createdPbi.id,
        effortPoints: pbiEffortPoints,
        requestId
      });

      featureEffortPoints += pbiEffortPoints;
      effortSummaryPbis.push({
        id: createdPbi.id,
        title: mappedPbi.title,
        effortPoints: pbiEffortPoints
      });
    }

    await updateAdoWorkItemEffort({
      config,
      workItemId: parentContainerId,
      effortPoints: featureEffortPoints,
      requestId
    });
  } else if (mode === "pbi") {
    if (!Number.isInteger(sourceWorkItemId) || sourceWorkItemId <= 0) {
      const error = new Error("PBI update requires source work item context.");
      error.status = 400;
      throw error;
    }

    const updatedPbi = await updateAdoWorkItemWithAcceptanceCriteriaFallback({
      config,
      workItemId: sourceWorkItemId,
      workItemType: sourceWorkItemType || config.backlogWorkItemType,
      patchInput: {
        description: root.description || "",
        acceptanceCriteria: root.acceptanceCriteria || []
      },
      requestId,
      context
    });

    const mappedPbi = mapCreatedItem(
      updatedPbi,
      root.title || workItemContext.parentContainer.title,
      config,
      workItemContext.parentContainer.parentId || null,
      sourceWorkItemType || config.backlogWorkItemType
    );
    createdPbis.push(mappedPbi);

    const taskNodes = Array.isArray(root.tasks) ? root.tasks : [];
    for (const taskNode of taskNodes) {
      const createdTask = await createTaskItem(taskNode, sourceWorkItemId);
      createdTasks.push(
        mapCreatedItem(
          createdTask,
          taskNode.title,
          config,
          sourceWorkItemId,
          config.taskWorkItemType
        )
      );
    }

    if (taskNodes.length > 0) {
      const pbiTaskHours = sumTaskOriginalEstimateHours(taskNodes, taskOriginalEstimateValue);
      const pbiEffortPoints = convertHoursToEffortPoints(pbiTaskHours);
      await updateAdoWorkItemEffort({
        config,
        workItemId: sourceWorkItemId,
        effortPoints: pbiEffortPoints,
        requestId
      });
      effortSummaryPbis.push({
        id: sourceWorkItemId,
        title: mappedPbi.title,
        effortPoints: pbiEffortPoints
      });
    }
  } else if (mode === "task") {
    if (!Number.isInteger(sourceWorkItemId) || sourceWorkItemId <= 0) {
      const error = new Error("Task update requires source work item context.");
      error.status = 400;
      throw error;
    }

    const updatedTask = await updateAdoWorkItemWithAcceptanceCriteriaFallback({
      config,
      workItemId: sourceWorkItemId,
      workItemType: sourceWorkItemType || config.taskWorkItemType,
      patchInput: {
        description: root.description || "",
        acceptanceCriteria: []
      },
      requestId,
      context
    });

    createdTasks.push(
      mapCreatedItem(
        updatedTask,
        root.title || workItemContext.parentContainer.title,
        config,
        workItemContext.parentContainer.parentId || null,
        sourceWorkItemType || config.taskWorkItemType
      )
    );
  }

  return {
    project: config.project,
    parent: {
      id: parentContainerId,
      title: workItemContext.parentContainer.title,
      type: workItemContext.parentContainer.type,
      webUrl: buildAdoWorkItemWebUrl(config, parentContainerId)
    },
    counts: {
      features: createdFeatures.length,
      pbis: createdPbis.length,
      tasks: createdTasks.length,
      totalCreated: createdFeatures.length + createdPbis.length + createdTasks.length
    },
    features: createdFeatures,
    pbis: createdPbis,
    tasks: createdTasks,
    effortSummary: {
      pbis: effortSummaryPbis,
      totalEffortPoints: effortSummaryPbis.reduce(
        (total, item) => total + Number(item.effortPoints || 0),
        0
      )
    }
  };
}

function buildAdoWorkItemWebUrl(config, workItemId) {
  return `${config.orgUrl}/${encodeURIComponent(config.project)}/_workitems/edit/${workItemId}`;
}

function buildParentRelationValue(config, parentId) {
  return {
    rel: "System.LinkTypes.Hierarchy-Reverse",
    url: `${config.orgUrl}/_apis/wit/workItems/${parentId}`
  };
}

function isTaskType(workItemType, config) {
  const normalizedType = normalizeWorkItemType(workItemType);
  const configuredTaskType = normalizeWorkItemType(config?.taskWorkItemType);
  return normalizedType === "task" || (configuredTaskType && normalizedType === configuredTaskType);
}

function shouldSplitAcceptanceCriteria(workItemType, config, forceInlineAcceptanceCriteria) {
  if (forceInlineAcceptanceCriteria) {
    return false;
  }

  if (!normalizeWorkItemType(workItemType)) {
    return false;
  }

  return !isTaskType(workItemType, config);
}

function buildPatchDocument({
  config,
  workItemType,
  title,
  description,
  acceptanceCriteria,
  taskHints,
  parentId,
  storyPoints,
  extraNumericFields,
  forceInlineAcceptanceCriteria = false
}) {
  const splitAcceptanceCriteria = shouldSplitAcceptanceCriteria(
    workItemType,
    config,
    forceInlineAcceptanceCriteria
  );

  const patchDocument = [{ op: "add", path: "/fields/System.Title", value: title }];
  const descriptionHtml = buildDescriptionHtml({
    description,
    acceptanceCriteria,
    taskHints,
    includeAcceptanceCriteria: !splitAcceptanceCriteria
  });

  if (descriptionHtml) {
    patchDocument.push({
      op: "add",
      path: "/fields/System.Description",
      value: descriptionHtml
    });
  }

  if (splitAcceptanceCriteria) {
    const acceptanceCriteriaHtml = buildAcceptanceCriteriaHtml(acceptanceCriteria);
    if (acceptanceCriteriaHtml) {
      patchDocument.push({
        op: "add",
        path: `/fields/${DEFAULT_ACCEPTANCE_CRITERIA_FIELD}`,
        value: acceptanceCriteriaHtml
      });
    }
  }

  if (config.storyPointsField) {
    const numericStoryPoints = Number(storyPoints);
    if (Number.isFinite(numericStoryPoints) && numericStoryPoints > 0) {
      patchDocument.push({
        op: "add",
        path: `/fields/${config.storyPointsField}`,
        value: numericStoryPoints
      });
    }
  }

  if (Array.isArray(extraNumericFields)) {
    for (const field of extraNumericFields) {
      if (!field?.path) {
        continue;
      }

      const numericValue = Number(field.value);
      if (!Number.isFinite(numericValue) || numericValue <= 0) {
        continue;
      }

      patchDocument.push({
        op: "add",
        path: `/fields/${field.path}`,
        value: numericValue
      });
    }
  }

  if (parentId) {
    patchDocument.push({
      op: "add",
      path: "/relations/-",
      value: buildParentRelationValue(config, parentId)
    });
  }

  return patchDocument;
}

function buildUpdatePatchDocument({
  config,
  workItemType,
  description,
  acceptanceCriteria,
  forceInlineAcceptanceCriteria = false
}) {
  const splitAcceptanceCriteria = shouldSplitAcceptanceCriteria(
    workItemType,
    config,
    forceInlineAcceptanceCriteria
  );

  const patchDocument = [];
  const descriptionHtml = buildDescriptionHtml({
    description,
    acceptanceCriteria,
    includeAcceptanceCriteria: !splitAcceptanceCriteria
  });
  patchDocument.push({
    op: "add",
    path: "/fields/System.Description",
    value: descriptionHtml || ""
  });

  if (splitAcceptanceCriteria) {
    const acceptanceCriteriaHtml = buildAcceptanceCriteriaHtml(acceptanceCriteria);
    patchDocument.push({
      op: "add",
      path: `/fields/${DEFAULT_ACCEPTANCE_CRITERIA_FIELD}`,
      value: acceptanceCriteriaHtml || ""
    });
  }

  return patchDocument;
}

function isAcceptanceCriteriaFieldUnsupportedError(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("acceptance criteria") ||
    message.includes("microsoft.vsts.common.acceptancecriteria")
  );
}

async function createAdoWorkItemWithAcceptanceCriteriaFallback({
  config,
  workItemType,
  patchInput,
  requestId,
  context
}) {
  if (context?.log) {
    context.log("Class: adoClient");
    context.log("Function: createAdoWorkItemWithAcceptanceCriteriaFallback");
    context.log(`Input: ${JSON.stringify({ workItemType, patchInput }, null, 2)}`);
  }

  try {
    const created = await createAdoWorkItem({
      config,
      workItemType,
      patchDocument: buildPatchDocument({
        config,
        workItemType,
        ...patchInput
      }),
      requestId
    });

    if (context?.log) {
      context.log("Class: adoClient");
      context.log("Function: createAdoWorkItemWithAcceptanceCriteriaFallback");
      context.log(`Output: ${JSON.stringify({ id: created?.id, workItemType }, null, 2)}`);
    }

    return created;
  } catch (error) {
    if (!isAcceptanceCriteriaFieldUnsupportedError(error) || isTaskType(workItemType, config)) {
      throw error;
    }

    if (context?.log) {
      context.log("Class: adoClient");
      context.log("Function: createAdoWorkItemWithAcceptanceCriteriaFallback");
      context.log(
        `Output: ${JSON.stringify({ fallback: "inline_acceptance_criteria", reason: error.message, workItemType }, null, 2)}`
      );
    }

    const created = await createAdoWorkItem({
      config,
      workItemType,
      patchDocument: buildPatchDocument({
        config,
        workItemType,
        ...patchInput,
        forceInlineAcceptanceCriteria: true
      }),
      requestId
    });

    if (context?.log) {
      context.log("Class: adoClient");
      context.log("Function: createAdoWorkItemWithAcceptanceCriteriaFallback");
      context.log(`Output: ${JSON.stringify({ id: created?.id, workItemType, fallbackApplied: true }, null, 2)}`);
    }

    return created;
  }
}

async function updateAdoWorkItemWithAcceptanceCriteriaFallback({
  config,
  workItemId,
  workItemType,
  patchInput,
  requestId,
  context
}) {
  if (context?.log) {
    context.log("Class: adoClient");
    context.log("Function: updateAdoWorkItemWithAcceptanceCriteriaFallback");
    context.log(`Input: ${JSON.stringify({ workItemId, workItemType, patchInput }, null, 2)}`);
  }

  try {
    const updated = await updateAdoWorkItem({
      config,
      workItemId,
      patchDocument: buildUpdatePatchDocument({
        config,
        workItemType,
        ...patchInput
      }),
      requestId
    });

    if (context?.log) {
      context.log("Class: adoClient");
      context.log("Function: updateAdoWorkItemWithAcceptanceCriteriaFallback");
      context.log(`Output: ${JSON.stringify({ id: updated?.id, workItemType }, null, 2)}`);
    }

    return updated;
  } catch (error) {
    if (!isAcceptanceCriteriaFieldUnsupportedError(error) || isTaskType(workItemType, config)) {
      throw error;
    }

    if (context?.log) {
      context.log("Class: adoClient");
      context.log("Function: updateAdoWorkItemWithAcceptanceCriteriaFallback");
      context.log(
        `Output: ${JSON.stringify({ fallback: "inline_acceptance_criteria", reason: error.message, workItemType }, null, 2)}`
      );
    }

    const updated = await updateAdoWorkItem({
      config,
      workItemId,
      patchDocument: buildUpdatePatchDocument({
        config,
        workItemType,
        ...patchInput,
        forceInlineAcceptanceCriteria: true
      }),
      requestId
    });

    if (context?.log) {
      context.log("Class: adoClient");
      context.log("Function: updateAdoWorkItemWithAcceptanceCriteriaFallback");
      context.log(`Output: ${JSON.stringify({ id: updated?.id, workItemType, fallbackApplied: true }, null, 2)}`);
    }

    return updated;
  }
}

function isOriginalEstimateRequiredError(error) {
  const message = String(error?.message || "");
  return message.includes("Original Estimate") && message.includes("Required");
}

function mapCreatedItem(payload, fallbackTitle, config, parentId, workItemType) {
  return {
    id: payload.id,
    title: payload.fields?.["System.Title"] || fallbackTitle,
    workItemType,
    url: payload.url,
    webUrl: buildAdoWorkItemWebUrl(config, payload.id),
    parentId: parentId || null
  };
}

async function createSketchBacklogHierarchy({ sketch, requestId, context }) {
  if (!sketch?.epic) {
    const error = new Error("Field 'sketch.epic' is required.");
    error.status = 400;
    throw error;
  }

  const config = getAdoConfiguration();
  const epicNode = sketch.epic;
  const createdFeatures = [];
  const createdPbis = [];
  const createdTasks = [];
  const effortSummaryPbis = [];
  let shouldAttachTaskOriginalEstimate = Boolean(config.taskOriginalEstimateField);
  const taskOriginalEstimateField =
    config.taskOriginalEstimateField || DEFAULT_TASK_ORIGINAL_ESTIMATE_FIELD;
  const taskOriginalEstimateValue = config.taskOriginalEstimateDefault;

  const epic = await createAdoWorkItemWithAcceptanceCriteriaFallback({
    config,
    workItemType: config.epicWorkItemType,
    patchInput: {
      title: epicNode.title,
      description: epicNode.description,
      acceptanceCriteria: epicNode.acceptanceCriteria || [],
      storyPoints: epicNode.storyPoints
    },
    requestId,
    context
  });

  for (const feature of epicNode.features || []) {
    const createdFeature = await createAdoWorkItemWithAcceptanceCriteriaFallback({
      config,
      workItemType: config.featureWorkItemType,
      patchInput: {
        title: feature.title,
        description: feature.description,
        acceptanceCriteria: feature.acceptanceCriteria,
        storyPoints: feature.storyPoints,
        parentId: epic.id
      },
      requestId,
      context
    });

    const mappedFeature = mapCreatedItem(
      createdFeature,
      feature.title,
      config,
      epic.id,
      config.featureWorkItemType
    );
    createdFeatures.push(mappedFeature);
    let featureEffortPoints = 0;

    for (const pbi of feature.pbis || []) {
      const createdPbi = await createAdoWorkItemWithAcceptanceCriteriaFallback({
        config,
        workItemType: config.backlogWorkItemType,
        patchInput: {
          title: pbi.title,
          description: pbi.description,
          acceptanceCriteria: pbi.acceptanceCriteria,
          storyPoints: pbi.storyPoints,
          parentId: createdFeature.id
        },
        requestId,
        context
      });

      const mappedPbi = mapCreatedItem(
        createdPbi,
        pbi.title,
        config,
        createdFeature.id,
        config.backlogWorkItemType
      );
      createdPbis.push(mappedPbi);
      const pbiTaskHours = sumTaskOriginalEstimateHours(pbi.tasks || [], taskOriginalEstimateValue);
      const pbiEffortPoints = convertHoursToEffortPoints(pbiTaskHours);

      for (const task of pbi.tasks || []) {
        const resolvedTaskOriginalEstimate = resolveTaskOriginalEstimate(
          task,
          taskOriginalEstimateValue
        );
        const buildTaskPatchDocument = (includeOriginalEstimate) =>
          buildPatchDocument({
            config,
            workItemType: config.taskWorkItemType,
            title: task.title,
            description: task.description,
            acceptanceCriteria: task.acceptanceCriteria,
            parentId: createdPbi.id,
            extraNumericFields: includeOriginalEstimate
              ? [
                  {
                    path: taskOriginalEstimateField,
                    value: resolvedTaskOriginalEstimate
                  }
                ]
              : []
          });

        let createdTask = null;
        try {
          createdTask = await createAdoWorkItem({
            config,
            workItemType: config.taskWorkItemType,
            patchDocument: buildTaskPatchDocument(shouldAttachTaskOriginalEstimate),
            requestId
          });
        } catch (error) {
          // Some ADO processes require Original Estimate on Task, so retry once with the common field.
          if (!shouldAttachTaskOriginalEstimate && isOriginalEstimateRequiredError(error)) {
            shouldAttachTaskOriginalEstimate = true;
            createdTask = await createAdoWorkItem({
              config,
              workItemType: config.taskWorkItemType,
              patchDocument: buildTaskPatchDocument(true),
              requestId
            });
          } else {
            throw error;
          }
        }

        createdTasks.push(
          mapCreatedItem(
            createdTask,
            task.title,
            config,
            createdPbi.id,
            config.taskWorkItemType
          )
        );
      }

      await updateAdoWorkItemEffort({
        config,
        workItemId: createdPbi.id,
        effortPoints: pbiEffortPoints,
        requestId
      });
      featureEffortPoints += pbiEffortPoints;
      effortSummaryPbis.push({
        id: createdPbi.id,
        title: mappedPbi.title,
        effortPoints: pbiEffortPoints
      });
    }

    await updateAdoWorkItemEffort({
      config,
      workItemId: createdFeature.id,
      effortPoints: featureEffortPoints,
      requestId
    });
  }

  return {
    project: config.project,
    epic: mapCreatedItem(epic, epicNode.title, config, null, config.epicWorkItemType),
    counts: {
      features: createdFeatures.length,
      pbis: createdPbis.length,
      tasks: createdTasks.length,
      totalCreated: 1 + createdFeatures.length + createdPbis.length + createdTasks.length
    },
    features: createdFeatures,
    pbis: createdPbis,
    tasks: createdTasks,
    effortSummary: {
      pbis: effortSummaryPbis,
      totalEffortPoints: effortSummaryPbis.reduce(
        (total, item) => total + Number(item.effortPoints || 0),
        0
      )
    }
  };
}

module.exports = {
  createSketchBacklogHierarchy,
  buildWorkItemDraftContext,
  buildEpicScopeContext,
  createWorkItemScopedBacklog
};
