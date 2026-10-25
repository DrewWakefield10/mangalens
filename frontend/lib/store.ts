"use client";
import { create } from "zustand";
import { persist } from "zustand/middleware";
type Preferences = {
  theme: "dark" | "light";
  target: string;
  mode: "single" | "double" | "scroll";
  direction: "rtl" | "ltr";
  quality: string;
  style: string;
  fallback_provider: string;
};
export const usePreferences = create<
  Preferences & { set: (value: Partial<Preferences>) => void }
>()(
  persist(
    (set) => ({
      theme: "dark",
      target: "en",
      mode: "single",
      direction: "rtl",
      quality: "quality",
      style: "natural",
      fallback_provider: "",
      set: (value) => set(value),
    }),
    { name: "mangalens-preferences" },
  ),
);
