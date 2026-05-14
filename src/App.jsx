import React, { useMemo } from "react";
import WorkItemAssistantApp from "./components/WorkItemAssistantApp";
import { readAdoContext } from "./lib/appHelpers";

export default function App() {
  const adoContext = useMemo(readAdoContext, []);
  return <WorkItemAssistantApp adoContext={adoContext} />;
}
