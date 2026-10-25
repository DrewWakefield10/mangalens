"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api, Project } from "@/lib/api";
export function useProject(id: string) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["project", id],
    queryFn: () => api<Project>("/projects/" + id),
    refetchInterval: 5000,
  });
  useEffect(() => {
    let events: EventSource | undefined;
    let dead = false;
    api("/session", { method: "POST" })
      .then(() => {
        if (dead) return;
        events = new EventSource("/api/projects/" + id + "/events");
        events.onmessage = (e) => {
          try {
            client.setQueryData(["project", id], JSON.parse(e.data));
          } catch {}
        };
      })
      .catch(() => {});
    return () => {
      dead = true;
      events?.close();
    };
  }, [id, client]);
  return query;
}
