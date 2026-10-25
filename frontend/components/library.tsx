"use client";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { BookOpen, Plus, ArrowUpRight } from "lucide-react";
import { api, Project, languages } from "@/lib/api";
export default function Library({ history = false }: { history?: boolean }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api<Project[]>("/projects"),
    refetchInterval: 5000,
  });
  return (
    <main className="workspace">
      <div className="page-heading">
        <div>
          <div className="eyebrow">A WORLD OF STORIES, YOUR WAY</div>
          <h1>{history ? "Translation history" : "Your library."}</h1>
          <p className="lead">
            {history
              ? "Every chapter you’ve brought across languages."
              : "Pick up where you left off. Or begin somewhere new."}
          </p>
        </div>
        <Link className="button primary" href="/translate">
          <Plus size={17} /> New translation
        </Link>
      </div>
      {isLoading && <p className="loading">Opening your library…</p>}
      {error && <div className="error">{error.message}</div>}
      {data?.length === 0 && (
        <div className="empty panel">
          <BookOpen size={42} />
          <h2>A story is waiting for you.</h2>
          <p>Your imported chapters will appear here.</p>
          <Link href="/translate" className="button outline">
            Import your first chapter <ArrowUpRight size={16} />
          </Link>
        </div>
      )}
      <div className="project-grid">
        {data?.map((p) => (
          <Link href={"/projects/" + p.id} key={p.id} className="project-card">
            <div className="project-cover">
              <img src={p.pages[0]?.thumbnail} alt={p.title} />
              <span className="badge">
                {p.active
                  ? "Processing"
                  : p.ready === p.pages.length
                    ? "Ready to read"
                    : p.ready + " / " + p.pages.length + " ready"}
              </span>
            </div>
            <div className="project-info">
              <div className="eyebrow">
                {languages[p.source_lang]} → {languages[p.target_lang]}
              </div>
              <h3>{p.title}</h3>
              <p>
                {p.pages.length} pages <span>·</span>{" "}
                {new Date(p.created * 1000).toLocaleDateString()}
              </p>
              <div className="progress-track">
                <span
                  style={{ width: (100 * p.ready) / p.pages.length + "%" }}
                />
              </div>
            </div>
          </Link>
        ))}
      </div>
    </main>
  );
}
