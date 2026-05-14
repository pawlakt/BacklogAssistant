const LOG_SEPARATOR = "=".repeat(120);

function toPrettyString(value) {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function logBlock(title, content) {
  const safeTitle = String(title || "DEBUG");
  const safeContent = toPrettyString(content);

  console.log(
    `\n${LOG_SEPARATOR}\n${safeTitle}\n${LOG_SEPARATOR}\n${safeContent}\n${LOG_SEPARATOR}\n`
  );
}

function logJsonBlock(title, payload) {
  logBlock(title, payload);
}

function logTextBlock(title, text) {
  logBlock(title, typeof text === "string" ? text : String(text || ""));
}

module.exports = {
  logBlock,
  logJsonBlock,
  logTextBlock
};
