"use client";
import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { Trash2, X } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "./ui/button";
export default function DeleteProjectDialog({
  id,
  title,
  disabled,
  onDeleted,
}: {
  id: string;
  title: string;
  disabled: boolean;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!busy) {
          setOpen(value);
          setError("");
        }
      }}
    >
      <Dialog.Trigger asChild>
        <button className="text-link danger" disabled={disabled}>
          <Trash2 size={15} /> Delete project
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal">
          <Dialog.Title>Delete this chapter?</Dialog.Title>
          <Dialog.Description>
            Delete "{title}", its images, and every saved edit. This cannot be
            undone.
          </Dialog.Description>
          <Dialog.Close
            className="modal-close icon-button"
            aria-label="Close"
            disabled={busy}
          >
            <X size={20} />
          </Dialog.Close>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="actions">
            <Dialog.Close asChild>
              <Button variant="outline" disabled={busy} autoFocus>
                Keep chapter
              </Button>
            </Dialog.Close>
            <Button
              disabled={busy}
              aria-busy={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await api("/projects/" + id, { method: "DELETE" });
                  setOpen(false);
                  onDeleted();
                } catch (cause) {
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : "Could not delete this chapter. Retry shortly.",
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Deleting..." : "Delete chapter"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
