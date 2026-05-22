"use client";

import { useState } from "react";
import { renameDevice, deleteDevice } from "./actions";

export function DeviceActions({
  id,
  name,
  mac,
}: {
  id: string;
  name: string | null;
  mac: string;
}) {
  const [editing, setEditing] = useState(false);
  const display = name ?? "Unnamed device";

  function handleDeleteSubmit(e: React.FormEvent<HTMLFormElement>) {
    if (!confirm(`Delete "${display}" (${mac})?\n\nAll readings and events will be permanently removed. This cannot be undone.`)) {
      e.preventDefault();
    }
  }

  return (
    <div>
      {editing ? (
        <form action={renameDevice} className="rename" onSubmit={() => setEditing(false)}>
          <input type="hidden" name="id" value={id} />
          <input name="name" defaultValue={name ?? ""} placeholder="Device name" autoFocus maxLength={64} />
          <button type="submit">Save</button>
          <button type="button" onClick={() => setEditing(false)}>Cancel</button>
        </form>
      ) : (
        <h1>
          {display}
          <span className="mac">{mac}</span>
        </h1>
      )}
      <div className="actions">
        {!editing && (
          <button type="button" onClick={() => setEditing(true)}>Rename</button>
        )}
        <form action={deleteDevice} onSubmit={handleDeleteSubmit} style={{ display: "inline" }}>
          <input type="hidden" name="id" value={id} />
          <button type="submit" className="danger">Delete</button>
        </form>
      </div>
    </div>
  );
}
