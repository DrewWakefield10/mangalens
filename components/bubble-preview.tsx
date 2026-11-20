"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { api, type Page, type Project } from "@/lib/api";
import { Button } from "@/components/ui/button";

type Point = [number, number];
type Bubble = {
  id?: string;
  polygon: Point[];
  detection: "accepted" | "uncertain" | "manual";
  decision: "approved" | "dismissed" | "pending";
  reason?: string;
  confirmed?: boolean;
};
type Scan = {
  status: Page["bubble_scan_status"];
  revision: string;
  bubbles: Bubble[];
  reason?: string;
  reviewed?: boolean;
  skipped?: boolean;
};

export function BubblePreview({
  projectId,
  pages,
  onReady,
  onTranslate,
  initialBubble,
}: {
  projectId: string;
  pages: Page[];
  onReady?: (ready: boolean) => void;
  onTranslate?: (page: Page) => Promise<void>;
  initialBubble?: string;
}) {
  const [index, setIndex] = useState(0);
  const [scanError, setError] = useState("");
  const [scanning, setScanning] = useState(false);
  const [dirty, setDirty] = useState(false);
  const client = useQueryClient();
  const status = useQuery({
    queryKey: ["bubble-project", projectId],
    queryFn: () => api<Project>("/projects/" + projectId),
    refetchInterval: (query) =>
      query.state.data?.pages.some(
        (page) => page.bubble_scan_status === "scanning",
      )
        ? 1200
        : false,
  });
  const page = pages[index];
  const current = status.data?.pages.find((item) => item.id === page?.id);
  const scan = useQuery({
    queryKey: ["bubble-scan", page?.id, current?.bubble_scan_status],
    queryFn: () => api<Scan>("/pages/" + page.id + "/bubbles"),
    enabled: !!page,
    staleTime: 0,
  });

  async function detect(pageIds?: string[]) {
    setScanning(true);
    setError("");
    try {
      const project = await api<Project>(
        "/projects/" + projectId + "/bubble-scans",
        {
          method: "POST",
          body: JSON.stringify({ page_ids: pageIds }),
        },
      );
      client.setQueryData(["bubble-project", projectId], project);
      await scan.refetch();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setScanning(false);
    }
  }
  useEffect(() => {
    void detect(pages.map((item) => item.id));
  }, [projectId]);
  const confirmedPages = pages.filter((item) =>
    status.data?.pages.some(
      (saved) => saved.id === item.id && saved.bubble_reviewed,
    ),
  ).length;
  useEffect(() => {
    onReady?.(
      !dirty && !status.data?.active && confirmedPages === pages.length,
    );
  }, [confirmedPages, dirty, onReady, pages.length, status.data?.active]);

  if (!page) return null;
  return (
    <section className="bubble-preview" aria-label="Preview Detected Bubbles">
      <div className="actions bubble-preview-toolbar">
        <label>
          Page{" "}
          <select
            value={index}
            onChange={(event) => setIndex(Number(event.target.value))}
            disabled={dirty}
            aria-label="Bubble preview page"
          >
            {pages.map((item, number) => (
              <option key={item.id} value={number}>
                {number + 1} · {item.name}
              </option>
            ))}
          </select>
        </label>
        <span className="hint" role="status">
          {confirmedPages} / {pages.length} pages ready
        </span>
      </div>
      {scanError || status.error || scan.error ? (
        <p className="error" role="alert">
          {scanError || status.error?.message || scan.error?.message}
        </p>
      ) : null}
      {scan.data?.status === "ready" ? (
        <BubblePage
          key={page.id + scan.data.revision}
          page={page}
          scan={scan.data}
          initialBubble={initialBubble}
          onDirty={setDirty}
          disabled={!!status.data?.active}
          onSave={async (reviewed) => {
            client.setQueryData(
              ["bubble-scan", page.id, current?.bubble_scan_status],
              reviewed,
            );
            setDirty(false);
            await status.refetch();
          }}
          onTranslate={onTranslate}
        />
      ) : (
        <div className="bubble-stage">
          <img src={page.original} alt={page.name} />
          {current?.bubble_scan_status === "failed" ? (
            <div role="alert">
              <strong>Bubble Scan Failed</strong>
              <p>
                {scan.data?.reason ||
                  "The detector could not finish this scan."}
              </p>
              <Button
                variant="outline"
                disabled={scanning || status.data?.active}
                onClick={() => void detect([page.id])}
              >
                Retry bubble scan
              </Button>
            </div>
          ) : (
            <p role="status">
              {current?.bubble_scan_status === "unscanned" && !scanning
                ? "The page is waiting for a scan."
                : "Detecting bubble outlines…"}
            </p>
          )}
          {current?.bubble_scan_status === "unscanned" && !scanning && (
            <Button
              variant="outline"
              disabled={status.data?.active}
              onClick={() => void detect([page.id])}
            >
              Detect bubbles
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

function BubblePage({
  page,
  scan,
  onSave,
  onDirty,
  disabled,
  onTranslate,
  initialBubble,
}: {
  page: Page;
  scan: Scan;
  onSave: (scan: Scan) => Promise<void>;
  onDirty: (dirty: boolean) => void;
  disabled: boolean;
  onTranslate?: (page: Page) => Promise<void>;
  initialBubble?: string;
}) {
  const [choices, setChoices] = useState(scan.bubbles);
  const [selected, select] = useState(
    Math.max(
      0,
      scan.bubbles.findIndex((item) => item.id === initialBubble),
    ),
  );
  const [drawing, setDrawing] = useState<"add" | "replace" | null>(null);
  const [points, setPoints] = useState<Point[]>([]);
  const [cursor, setCursor] = useState<Point>([
    Math.round(page.width / 2),
    Math.round(page.height / 2),
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const chosen = choices[selected];
  const count = choices.filter((item) => item.decision === "approved").length;
  const pending = choices.some((item) => item.decision === "pending");
  const locked = busy || disabled;

  function update(item: Bubble) {
    const copy = [...choices];
    copy[selected] = item;
    setChoices(copy);
    onDirty(true);
  }

  async function save(skip: boolean, translate = false) {
    setBusy(true);
    setError("");
    try {
      const reviewed = await api<Scan>("/pages/" + page.id + "/bubbles", {
        method: "PUT",
        body: JSON.stringify({
          revision: scan.revision,
          bubbles: choices,
          skip,
        }),
      });
      if (translate) {
        try {
          await onTranslate?.(page);
        } finally {
          await onSave(reviewed);
        }
      } else await onSave(reviewed);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function closeOutline() {
    if (drawing === "replace")
      update({
        ...chosen,
        polygon: points,
        decision: "pending",
        detection: "manual",
        confirmed: false,
      });
    else {
      setChoices([
        ...choices,
        { polygon: points, decision: "pending", detection: "manual" },
      ]);
      select(choices.length);
      onDirty(true);
    }
    setDrawing(null);
    setPoints([]);
    setNotice("Confirm this boundary to include the bubble.");
  }

  return (
    <>
      <div className="bubble-preview-grid">
        <div className="bubble-stage">
          <div className="bubble-canvas">
            <img
              src={page.original}
              alt={"Original page · " + page.name}
              draggable={false}
            />
            <svg
              viewBox={`0 0 ${page.width} ${page.height}`}
              aria-label="Speech bubble boundaries"
              className={drawing ? "drawing" : ""}
              tabIndex={drawing ? 0 : undefined}
              onKeyDown={(event) => {
                if (!drawing) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  if (points.length < 120) setPoints([...points, cursor]);
                }
                const delta: Record<string, Point> = {
                  ArrowUp: [0, -1],
                  ArrowDown: [0, 1],
                  ArrowLeft: [-1, 0],
                  ArrowRight: [1, 0],
                };
                if (!(event.key in delta)) return;
                event.preventDefault();
                const [x, y] = delta[event.key];
                const step = event.shiftKey ? 1 : 8;
                setCursor([
                  Math.max(0, Math.min(page.width - 1, cursor[0] + x * step)),
                  Math.max(0, Math.min(page.height - 1, cursor[1] + y * step)),
                ]);
              }}
              onClick={(event) => {
                if (!drawing || points.length >= 120) return;
                const rect = event.currentTarget.getBoundingClientRect();
                setPoints([
                  ...points,
                  [
                    Math.min(
                      page.width - 1,
                      Math.max(
                        0,
                        Math.round(
                          ((event.clientX - rect.left) * page.width) /
                            rect.width,
                        ),
                      ),
                    ),
                    Math.min(
                      page.height - 1,
                      Math.max(
                        0,
                        Math.round(
                          ((event.clientY - rect.top) * page.height) /
                            rect.height,
                        ),
                      ),
                    ),
                  ],
                ]);
              }}
            >
              {choices.map((item, i) => (
                <polygon
                  key={item.id ?? i}
                  points={item.polygon
                    .map((point) => point.join(","))
                    .join(" ")}
                  vectorEffect="non-scaling-stroke"
                  className={`bubble-outline ${item.decision} ${i === selected ? "selected" : ""}`}
                  onClick={() => {
                    if (!drawing) select(i);
                  }}
                />
              ))}
              {drawing && (
                <>
                  <polyline
                    className="bubble-outline draft"
                    vectorEffect="non-scaling-stroke"
                    points={points.map((point) => point.join(",")).join(" ")}
                  />
                  {points.map(([x, y], i) => (
                    <circle key={i} cx={x} cy={y} r={page.width / 180} />
                  ))}
                  <circle
                    className="bubble-cursor"
                    cx={cursor[0]}
                    cy={cursor[1]}
                    r={page.width / 130}
                  />
                </>
              )}
            </svg>
          </div>
        </div>
        <div className="bubble-review">
          <p role="status">
            <strong>
              {choices.length === 0
                ? "No Speech Bubbles Found"
                : count === 0
                  ? "No Bubbles Selected"
                  : `${count} selected`}
            </strong>
          </p>
          {choices.length > 0 && (
            <ol className="bubble-list">
              {choices.map((item, i) => (
                <li key={item.id ?? i}>
                  <button
                    type="button"
                    aria-pressed={i === selected}
                    disabled={!!drawing}
                    onClick={() => select(i)}
                  >
                    Bubble {i + 1}{" "}
                    <span>
                      {item.decision === "approved"
                        ? "Selected"
                        : item.decision === "dismissed"
                          ? "Deselected"
                          : "Needs Review"}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
          {chosen?.decision === "pending" && chosen.reason && (
            <p className="hint">{chosen.reason}</p>
          )}
          {drawing ? (
            <>
              <p className="hint">
                Place points just inside the outline, leaving out the tail. Use
                the arrow keys and Enter to place points with a keyboard.
              </p>
              <div className="actions">
                <Button disabled={points.length < 3} onClick={closeOutline}>
                  Close outline
                </Button>
                <Button
                  variant="outline"
                  disabled={!points.length}
                  onClick={() => setPoints(points.slice(0, -1))}
                >
                  Undo point
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setPoints([]);
                    setDrawing(null);
                  }}
                >
                  Cancel outline
                </Button>
              </div>
            </>
          ) : (
            <div className="actions">
              {chosen && (
                <>
                  <Button
                    variant="outline"
                    disabled={locked}
                    onClick={() => setDrawing("replace")}
                  >
                    Edit Bubble Boundary
                  </Button>
                  {chosen.decision !== "approved" && (
                    <Button
                      variant="outline"
                      disabled={locked}
                      onClick={() =>
                        update({
                          ...chosen,
                          decision: "approved",
                          confirmed: true,
                        })
                      }
                    >
                      Confirm speech bubble
                    </Button>
                  )}
                  {chosen.decision !== "dismissed" && (
                    <Button
                      variant="ghost"
                      disabled={locked}
                      onClick={() =>
                        update({ ...chosen, decision: "dismissed" })
                      }
                    >
                      Deselect bubble
                    </Button>
                  )}
                </>
              )}
              <Button
                variant="outline"
                disabled={locked || choices.length >= 100}
                onClick={() => setDrawing("add")}
              >
                Outline missed bubble
              </Button>
            </div>
          )}
          <p className="hint" role="status">
            {drawing ? "" : notice}
          </p>
        </div>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions bubble-preview-toolbar">
        <Button
          variant="outline"
          disabled={locked || !!drawing}
          onClick={() => void save(false)}
        >
          Save page selection
        </Button>
        {count === 0 && choices.length > 0 && !pending && (
          <Button
            variant="ghost"
            disabled={locked || !!drawing}
            onClick={() => void save(true, !!onTranslate)}
          >
            Skip this page
          </Button>
        )}
        {onTranslate && (
          <Button
            disabled={locked || !!drawing || (!count && choices.length > 0)}
            onClick={() => void save(false, true)}
          >
            {choices.length
              ? "Translate selected bubbles"
              : "Keep original page"}
          </Button>
        )}
        {scan.reviewed && <span className="hint">Selection saved</span>}
      </div>
    </>
  );
}

export function BubblePreviewDialog({
  projectId,
  pages,
  onClose,
  onReady,
  onTranslate,
  initialBubble,
  footer,
}: {
  projectId: string;
  pages: Page[];
  onClose: () => void;
  onReady?: (ready: boolean) => void;
  onTranslate?: (page: Page) => Promise<void>;
  initialBubble?: string;
  footer?: React.ReactNode;
}) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal bubble-modal">
          <Dialog.Title>Preview Detected Bubbles</Dialog.Title>
          <Dialog.Description>
            Review the outlines on the original page. Translation reads only the
            bubbles you approve.
          </Dialog.Description>
          <Dialog.Close className="modal-close icon-button" aria-label="Close">
            <X size={20} />
          </Dialog.Close>
          <BubblePreview
            projectId={projectId}
            pages={pages}
            onReady={onReady}
            onTranslate={onTranslate}
            initialBubble={initialBubble}
          />
          {footer}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
