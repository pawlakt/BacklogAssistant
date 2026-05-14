import { createRoot } from "react-dom/client";
import * as SDK from "azure-devops-extension-sdk";
import App from "./App";
import "./styles.css";
import { initWorkItemHostBridge } from "./lib/workItemHostBridge";

function renderApp() {
  const root = createRoot(document.getElementById("root"));
  root.render(<App />);
}

const isLocalDevHost = ["localhost", "127.0.0.1", "0.0.0.0"].includes(window.location.hostname);

if (isLocalDevHost) {
  // Local Vite runs outside Azure DevOps, so the host handshake must be skipped.
  renderApp();
} else {
  SDK.init({ loaded: false });

  SDK.ready()
    .then(() => {
      initWorkItemHostBridge();
      renderApp();
      SDK.notifyLoadSucceeded();
    })
    .catch(() => {
      renderApp();
    });
}
