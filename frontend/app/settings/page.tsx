"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Check, Server, ShieldCheck } from "lucide-react";
import { api, Health, Usage, languages } from "@/lib/api";
import { usePreferences } from "@/lib/store";
import { Button } from "@/components/ui/button";
export default function Settings() {
  const pref = usePreferences();
  const { data: health, error } = useQuery({
    queryKey: ["health"],
    queryFn: () => api<Health>("/health"),
  });
  const { data: usage } = useQuery({
    queryKey: ["usage"],
    queryFn: () => api<Usage>("/usage"),
    refetchInterval: 60000,
  });
  const [message, setMessage] = useState("");
  return (
    <main className="workspace narrow">
      <div className="eyebrow">MAKE YOURSELF AT HOME</div>
      <h1>Your reading ritual.</h1>
      <p className="lead">
        A few preferences to make every chapter feel right.
      </p>
      <section className="panel settings-panel">
        <h2>General & reader</h2>
        <div className="form-grid">
          <label className="field">
            Appearance
            <select
              value={pref.theme}
              onChange={(e) =>
                pref.set({ theme: e.target.value as "dark" | "light" })
              }
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </label>
          <label className="field">
            Default target language
            <select
              value={pref.target}
              onChange={(e) => pref.set({ target: e.target.value })}
            >
              {Object.entries(languages)
                .filter(([k]) => k !== "auto")
                .map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
            </select>
          </label>
          <label className="field">
            Reading mode
            <select
              value={pref.mode}
              onChange={(e) =>
                pref.set({
                  mode: e.target.value as "single" | "double" | "scroll",
                })
              }
            >
              <option value="single">Single page</option>
              <option value="double">Double spread</option>
              <option value="scroll">Vertical scroll</option>
            </select>
          </label>
          <label className="field">
            Reading direction
            <select
              value={pref.direction}
              onChange={(e) =>
                pref.set({ direction: e.target.value as "rtl" | "ltr" })
              }
            >
              <option value="rtl">Right to left</option>
              <option value="ltr">Left to right</option>
            </select>
          </label>
          <label className="field">
            Processing profile
            <select
              value={pref.quality}
              onChange={(e) => pref.set({ quality: e.target.value })}
            >
              <option value="quality">Maximum Quality</option>
              <option value="balanced">Balanced</option>
              <option value="fast">Fast</option>
            </select>
          </label>
          <label className="field">
            Translation fallback
            <select
              value={pref.fallback_provider || ""}
              onChange={(e) => pref.set({ fallback_provider: e.target.value })}
            >
              <option value="">None</option>
              {["argos", "openai", "ollama", "google", "azure"].filter(
                (provider) => health?.providers[provider],
              ).map((provider) => (
                <option key={provider} value={provider}>{provider}</option>
              ))}
            </select>
          </label>
          <label className="field">
            Translation style
            <select
              value={pref.style}
              onChange={(e) => pref.set({ style: e.target.value })}
            >
              {["faithful", "natural", "literal", "concise"].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
        </div>
        <Button
          onClick={async () => {
            try {
              await api("/preferences", {
                method: "PUT",
                body: JSON.stringify({
                  theme: pref.theme,
                  target: pref.target,
                  mode: pref.mode,
                  direction: pref.direction,
                  quality: pref.quality,
                  style: pref.style,
                  fallback_provider: pref.fallback_provider || "",
                }),
              });
              setMessage("Preferences saved.");
            } catch (e) {
              setMessage((e as Error).message);
            }
          }}
        >
          <Check size={17} /> Save preferences
        </Button>
      </section>
      <section className="panel settings-panel">
        <h2>
          <Server size={21} /> Processing services
        </h2>
        <p>
          Provider credentials and endpoints are configured only on the server.
          Keys never pass through this interface.
        </p>
        {error && <div className="error">{error.message}</div>}
        <div className="provider-list">
          {Object.entries(health?.providers || {}).map(([p, enabled]) => (
            <div key={p}>
              <b>{p === "argos" ? "Argos · offline CPU" : p}</b>
              <span
                className={"status " + (enabled ? "completed" : "imported")}
              >
                {enabled ? "Configured" : "Unconfigured"}
              </span>
            </div>
          ))}
        </div>
        <p className="hint">
          Installed OCR languages:{" "}
          {health?.ocr_languages.join(", ") || "None detected"}
          <br />
          Cloud OCR: {health?.cloud_ocr_provider === "ocr_space" ? "OCR.space free endpoint" : "Google Cloud Vision"} · {health?.cloud_ocr_available ? "Configured" : "Not configured; local OCR active"}
          <br />
          Typesetting font:{" "}
          {health?.font_available ? "Available" : "Unavailable"}
        </p>
        {usage && <p className="hint">
          DeepL this billing period: {usage.deepl.account?.character_count.toLocaleString() ?? "Unavailable"}
          {usage.deepl.account && ` / ${usage.deepl.account.character_limit.toLocaleString()} characters`}
          <br />
          This browser session: {usage.deepl.requests} translation requests, {usage.deepl.characters_submitted.toLocaleString()} characters, {usage.deepl.failures} failures, {usage.deepl.rate_limits} rate limits.
          <br />
          Server monthly DeepL budget: {usage.deepl.local_characters_committed.toLocaleString()} / {usage.deepl.local_monthly_budget.toLocaleString()} characters committed, including pending requests and uncertain timeout outcomes. Provider-confirmed usage is shown above.
          <br />
          OCR.space on this server: {usage.ocr_space.requests_today}/{usage.ocr_space.daily_budget} daily requests, {usage.ocr_space.requests_month}/{usage.ocr_space.monthly_budget} monthly requests; Engine 3: {usage.ocr_space.engine_3_requests}/{usage.ocr_space.engine_3_monthly_budget}. {usage.ocr_space.rate_limits} rate limits. Each tile and retry counts.
          <br />
          Google Vision: {usage.cloud_ocr.requests} requests / {usage.cloud_ocr.local_monthly_budget} local monthly limit when explicitly selected on the server.
          {Object.entries(usage.providers).filter(([name]) => name !== "deepl").map(([name, counts]) => (
            <span key={name}><br />{name}: {counts.requests} requests, {counts.failures} failures.</span>
          ))}
        </p>}
        <p className="hint">
          Installed offline translation pairs:{" "}
          {health?.offline_pairs?.length
            ? health.offline_pairs
                .map(
                  (pair) =>
                    `${languages[pair.source] || pair.source} → ${languages[pair.target] || pair.target}`,
                )
                .join(", ")
            : "None reported. Restart the backend after upgrading to refresh model discovery."}
        </p>
        <div className="note">
          Configuration indicates installed models or credentials; external
          connectivity is checked during translation. Offline translation
          requires a model for the selected language pair.
        </div>
      </section>
      <section className="panel settings-panel">
        <h2>
          <ShieldCheck size={21} /> Privacy & storage
        </h2>
        <p>
          Projects and images expire after {health?.retention_days || 7} days.
          This browser’s temporary session is your access key; clearing cookies
          removes your access. Account registration is not enabled.
        </p>
        <div className="actions">
          <Button
            variant="outline"
            onClick={async () => {
              try {
                await api("/cache", { method: "DELETE" });
                setMessage(
                  "Your processing cache was cleared. Original projects are retained.",
                );
              } catch (e) {
                setMessage((e as Error).message);
              }
            }}
          >
            Clear processing cache
          </Button>
          <Link className="button outline" href="/projects">
            Manage & delete projects
          </Link>
          <Link className="text-link" href="/history">
            Translation history ↗
          </Link>
        </div>
      </section>
      {message && (
        <div role="status" className="note">
          {message}
        </div>
      )}
    </main>
  );
}
