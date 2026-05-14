import React from "react";

export default function ProgressBlock({ title, subtitle }) {
  return (
    <div className="sketching-state" role="status" aria-live="polite">
      <div className="sketching-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div>
        <strong>{title}</strong>
        <p>{subtitle}</p>
      </div>
    </div>
  );
}
