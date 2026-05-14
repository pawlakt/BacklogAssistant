function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeAcceptanceCriteria(values) {
  const normalized = Array.isArray(values) ? values : [];
  return normalized
    .map((value) => normalizeString(value))
    .filter(Boolean);
}

function normalizePositiveInt(value, fallbackValue) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return fallbackValue;
  }

  return numeric;
}

function cloneNode(node) {
  return JSON.parse(JSON.stringify(node));
}

function sleep(delayMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function formatConversationContext(messages) {
  const normalized = Array.isArray(messages) ? messages : [];
  return normalized
    .map((message, index) => {
      const role = normalizeString(message?.role).toLowerCase() === "assistant" ? "Assistant" : "User";
      const createdAt = normalizeString(message?.createdAt);
      const content = normalizeString(message?.content);
      return content
        ? `[${index + 1}]${createdAt ? ` @ ${createdAt}` : ""} ${role}: ${content}`
        : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function getChildrenInfo(node) {
  if (!node || typeof node !== "object") {
    return {
      key: "",
      children: []
    };
  }

  if (Array.isArray(node.features)) {
    return {
      key: "features",
      children: node.features
    };
  }
  if (Array.isArray(node.pbis)) {
    return {
      key: "pbis",
      children: node.pbis
    };
  }
  if (Array.isArray(node.tasks)) {
    return {
      key: "tasks",
      children: node.tasks
    };
  }

  return {
    key: "",
    children: []
  };
}

function toPathKey(pathSegments) {
  return (Array.isArray(pathSegments) ? pathSegments : []).join(".");
}

function collectDescendantNodeRefs(rootNode) {
  const collected = [];

  function walk(node, pathSegments) {
    const { key, children } = getChildrenInfo(node);
    if (!key || children.length === 0) {
      return;
    }

    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (!child || typeof child !== "object") {
        continue;
      }

      const nextPath = [...pathSegments, key, index];
      collected.push({
        node: child,
        path: nextPath,
        pathKey: toPathKey(nextPath)
      });
      walk(child, nextPath);
    }
  }

  walk(rootNode, []);
  return collected;
}

//TUTAJ NIE CHCE ROBIC ENRICH DLA ROOTA!
function collectNodesToEnrich(rootNode, { includeRoot = false } = {}) {
  const descendants = collectDescendantNodeRefs(rootNode);
  if (!includeRoot) {
    return descendants;
  }

  return [
    {
      node: rootNode,
      path: [],
      pathKey: ""
    },
    ...descendants
  ];
}

function buildItemPrompt({ node, conversationContext }) {
  const itemPayload = {
    type: normalizeString(node?.type).toLowerCase(),
    title: normalizeString(node?.title),
    description: normalizeString(node?.description),
    acceptanceCriteria: normalizeAcceptanceCriteria(node?.acceptanceCriteria)
  };

  //Tutaj nie potrzebuje podawac kontekstu konwersacji do chuja papieza!
  return [
    "Return only valid JSON and nothing else.",
    //"JSON format:",
    //"{\"type\":\"epic | feature | pbi | task\",\"title\":\"string\",\"description\":\"string\",\"acceptanceCriteria\":[\"string\"],\"tasks\":[{\"title\":\"string\",\"description\":\"string\",\"originalEstimate\":1}]}",
    "",
    `ENRICHING ITEM TYPE: ${itemPayload.type || "(unknown)"}`,
    //"Include 'tasks' only when item type is 'pbi'.",
    "**CONVERSATION CONTEXT START**",
    conversationContext || "(empty conversation context)",
    "**CONVERSATION CONTEXT END**",
    "",
    "BACKLOG ITEM INPUT JSON:",
    JSON.stringify(itemPayload, null, 2)
  ].join("\n");
}

function extractJsonCandidate(text) {
  const normalized = normalizeString(text);
  if (!normalized) {
    throw new Error("Enrichment output was empty.");
  }

  const fencedBlock = normalized.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedBlock?.[1]) {
    return fencedBlock[1].trim();
  }

  const firstBrace = normalized.indexOf("{");
  const lastBrace = normalized.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return normalized.slice(firstBrace, lastBrace + 1).trim();
  }

  return normalized;
}

function parseEnrichedNodePayload(responseText, originalNode, { requireTasksForPbi = false } = {}) {
  const parsed = JSON.parse(extractJsonCandidate(responseText));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Enrichment output must be a JSON object.");
  }

  const enrichedTitle = normalizeString(parsed.title || parsed.Title);
  const enrichedDescription = normalizeString(parsed.description || parsed.Description);
  if (!enrichedTitle || !enrichedDescription) {
    throw new Error("Enrichment output requires non-empty title and description.");
  }

  const originalType = normalizeString(originalNode.type).toLowerCase();
  const normalizedType = normalizeString(parsed.type).toLowerCase();
  const resolvedType = normalizedType || originalType;
  const tasks =
    resolvedType === "pbi"
      ? normalizeEnrichedTasks(parsed.tasks || parsed.Tasks)
      : Array.isArray(originalNode.tasks)
        ? originalNode.tasks
        : [];

  if (requireTasksForPbi && resolvedType === "pbi" && tasks.length === 0) {
    throw new Error("PBI enrichment output requires at least one task.");
  }

  return {
    ...originalNode,
    type: resolvedType,
    title: enrichedTitle,
    description: enrichedDescription,
    acceptanceCriteria: normalizeAcceptanceCriteria(parsed.acceptanceCriteria),
    tasks
  };
}

function normalizeOriginalEstimate(value) {
  if (value == null || value === "") {
    return null;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  return Math.round(numeric * 100) / 100;
}

function normalizeEnrichedTasks(rawTasks) {
  const normalized = Array.isArray(rawTasks) ? rawTasks : [];
  return normalized
    .map((task, index) => {
      const title = normalizeString(task?.title || task?.Title);
      const description = normalizeString(task?.description || task?.Description);
      if (!title || !description) {
        throw new Error(`Task #${index + 1} requires non-empty title and description.`);
      }

      return {
        id: normalizeString(task?.id) || `task-enriched-${index + 1}`,
        type: "task",
        title,
        description,
        originalEstimate: normalizeOriginalEstimate(
          task?.originalEstimate ??
            task?.original_estimate ??
            task?.["original estimate"] ??
            task?.["Original Estimate"]
        ),
        acceptanceCriteria: normalizeAcceptanceCriteria(task?.acceptanceCriteria || task?.AcceptanceCriteria)
      };
    })
    .filter(Boolean);
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const resolvedItems = Array.isArray(items) ? items : [];
  if (resolvedItems.length === 0) {
    return [];
  }

  const workerCount = Math.min(concurrency, resolvedItems.length);
  const outputs = new Array(resolvedItems.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const currentIndex = cursor;
      cursor += 1;
      if (currentIndex >= resolvedItems.length) {
        return;
      }

      outputs[currentIndex] = await mapper(resolvedItems[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return outputs;
}

function getNodeByPath(rootNode, pathSegments) {
  let current = rootNode;
  for (let index = 0; index < pathSegments.length; index += 1) {
    if (current == null) {
      return null;
    }
    current = current[pathSegments[index]];
  }
  return current;
}

function applyEnrichedNodes(rootNode, enrichedByPathKey) {
  const output = cloneNode(rootNode);

  for (const [pathKey, enriched] of enrichedByPathKey.entries()) {
    const pathSegments = pathKey.split(".").filter(Boolean);
    const node = getNodeByPath(output, pathSegments);
    if (!node || typeof node !== "object") {
      continue;
    }

    node.title = enriched.title;
    node.description = enriched.description;
    node.acceptanceCriteria = enriched.acceptanceCriteria;
    if (Array.isArray(enriched.tasks)) {
      node.tasks = enriched.tasks;
    }
  }

  return output;
}

function toSafeRequestSuffix(pathKey) {
  return normalizeString(pathKey).replace(/[^a-zA-Z0-9-]/g, "-") || "node";
}

async function enrichSingleNode({
  nodeRef,
  conversationContext,
  agentClient,
  requestId,
  agentIdOverride,
  attempt,
  requireTasksForPbi,
  context
}) {
  const node = nodeRef?.node;
  const pathKey = nodeRef?.pathKey || "unknown";
  const safePathKey = toSafeRequestSuffix(pathKey);

  context.log("Class: workItemDetailsEnrichmentService");
  context.log("Function: enrichSingleNode");
  // context.log(
  //   `Input: ${JSON.stringify(
  //     {
  //       requestId,
  //       attempt,
  //       nodePath: pathKey,
  //       nodeId: node?.id,
  //       nodeType: node?.type,
  //       nodeTitle: node?.title
  //     },
  //     null,
  //     2
  //   )}`
  // );

  const threadId = await agentClient.createThread({
    requestId: `${requestId}-details-thread-${safePathKey}-${attempt}`
  });
  const prompt = buildItemPrompt({
    node,
    conversationContext
  });

  //'Return only valid JSON and nothing else <- to idzie do agenta!
  const runResult = await agentClient.runAgentTurn({
    threadId,
    userMessage: prompt,
    requestId: `${requestId}-details-run-${safePathKey}-${attempt}`,
    agentIdOverride
  });

  context.log("Function: enrichSingleNode");
  context.log(
    `Output: ${JSON.stringify(
      {
        nodePath: pathKey,
        nodeId: node?.id || null,
        attempt,
        agentPrompt: prompt,
        assistantMessage: runResult?.assistantMessage?.content || ""
      },
      null,
      2
    )}`
  );

  return parseEnrichedNodePayload(runResult?.assistantMessage?.content || "", node, {
    requireTasksForPbi
  });
}

async function enrichWorkItemSketchWithAgent({
  sketch,
  conversationMessages,
  agentClient,
  requestId,
  agentIdOverride,
  includeRoot = false,
  requireTasksForPbi = false,
  context
}) {
  context.log("Class: workItemDetailsEnrichmentService");
  context.log("Function: enrichWorkItemSketchWithAgent");
  // context.log(
  //   `Input: ${JSON.stringify(
  //     {
  //       requestId,
  //       agentIdOverride,
  //       rootId: sketch?.root?.id || null
  //     },
  //     null,
  //     2
  //   )}`
  // );

  if (!sketch?.root) {
    const error = new Error("Field 'sketch.root' is required for details enrichment.");
    error.status = 400;
    throw error;
  }

  if (!agentIdOverride) {
    const error = new Error("FOUNDRY_WORKITEM_DETAILS_AGENT_ID is required for details enrichment.");
    error.status = 500;
    throw error;
  }

  const nodesToEnrich = collectNodesToEnrich(sketch.root, { includeRoot });
  const conversationContext = formatConversationContext(conversationMessages);
  const enrichedByPathKey = new Map();
  const maxConcurrency = normalizePositiveInt(process.env.WORKITEM_DETAILS_ENRICH_CONCURRENCY, 4);
  const maxAttempts = normalizePositiveInt(process.env.WORKITEM_DETAILS_ENRICH_ATTEMPTS, 3);
  const baseRetryDelayMs = normalizePositiveInt(process.env.WORKITEM_DETAILS_ENRICH_RETRY_MS, 1200);
  const failures = [];

  await mapWithConcurrency(nodesToEnrich, maxConcurrency, async (nodeRef) => {
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const enriched = await enrichSingleNode({
          nodeRef,
          conversationContext,
          agentClient,
          requestId,
          agentIdOverride,
          attempt,
          requireTasksForPbi,
          context
        });
        enrichedByPathKey.set(nodeRef.pathKey, enriched);
        return;
      } catch (error) {
        lastError = error;
        context.log("Class: workItemDetailsEnrichmentService");
        context.log("Function: enrichWorkItemSketchWithAgent");
        context.log(
          `Output: ${JSON.stringify(
            {
              retryNodePath: nodeRef.pathKey,
              retryNodeId: nodeRef.node?.id || null,
              attempt,
              maxAttempts,
              reason: String(error?.message || "Unknown enrichment failure")
            },
            null,
            2
          )}`
        );

        if (attempt < maxAttempts) {
          await sleep(baseRetryDelayMs * attempt);
        }
      }
    }

    failures.push({
      nodePath: nodeRef.pathKey,
      nodeId: nodeRef.node?.id || null,
      nodeType: nodeRef.node?.type || "",
      nodeTitle: nodeRef.node?.title || "",
      reason: String(lastError?.message || "Unknown enrichment failure")
    });
  });

  if (nodesToEnrich.length === 0) {
    const output = {
      sketch,
      stats: {
        total: 0,
        enriched: 0,
        failed: 0,
        skipped: false
      }
    };
    context.log("Class: workItemDetailsEnrichmentService");
    context.log("Function: enrichWorkItemSketchWithAgent");
    // context.log(`Output: ${JSON.stringify(output, null, 2)}`);
    return output;
  }

  if (failures.length > 0 || enrichedByPathKey.size !== nodesToEnrich.length) {
    const error = new Error(
      `Work item details enrichment failed for ${failures.length || nodesToEnrich.length - enrichedByPathKey.size} item(s). Backlog creation cancelled.`
    );
    error.status = 502;
    error.details = failures;

    context.log("Class: workItemDetailsEnrichmentService");
    context.log("Function: enrichWorkItemSketchWithAgent");
    // context.log(
    //   `Output: ${JSON.stringify(
    //     {
    //       failures,
    //       expected: nodesToEnrich.length,
    //       enriched: enrichedByPathKey.size
    //     },
    //     null,
    //     2
    //   )}`
    // );
    throw error;
  }

  const enrichedRoot = applyEnrichedNodes(sketch.root, enrichedByPathKey);
  const output = {
    sketch: {
      ...sketch,
      root: enrichedRoot
    },
    stats: {
      total: nodesToEnrich.length,
      enriched: nodesToEnrich.length,
      failed: 0,
      skipped: false
    }
  };

  context.log("Class: workItemDetailsEnrichmentService");
  context.log("Function: enrichWorkItemSketchWithAgent");
  // context.log(`Output: ${JSON.stringify(output.stats, null, 2)}`);
  return output;
}

module.exports = {
  enrichWorkItemSketchWithAgent
};
