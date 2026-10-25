---
version: alpha
name: MangaLens
description: A quiet manga translation workbench with inspectable processing stages.
colors:
  primary: "#b8a6ff"
  background: "#101014"
  panel: "#19191f"
  text: "#f6f5f8"
  muted: "#92919e"
  border: "#2c2c35"
typography:
  sans:
    fontFamily: "Arial, Helvetica, sans-serif"
rounded:
  DEFAULT: "14px"
  control: "8px"
omitted:
  - section: spacing
    reason: Existing CSS owns component-specific spacing; no new spacing system introduced.
components:
  button: {}
  checkbox: {}
  diagnostics: {}
---

# MangaLens Design System

## Overview

Preserve the existing translation workbench: the manga page is the main visual reference. English UI supports multilingual page content; this does not establish a Japan-market product brief. This file mirrors the canonical runtime tokens in `app/globals.css`; it does not generate them. Existing user workflows and controls take precedence over a visual redesign.

## Colors

Dark neutral surfaces and lavender actions follow the tokens above. The existing light theme in globals.css remains supported. Status must have readable text alongside color. Region outlines are optional, so artwork can be inspected without overlays.

## Typography

Use the existing Arial/Helvetica UI stack, 14px base and 1.6 line height. Manga rendering uses the backend's separate CJK-capable fonts and bounded typesetting; do not substitute UI fonts into exported images.

## Layout

Keep the editor toolbar, image canvas and selected-region form. Reuse existing wrapping toolbar and responsive sidebar rules. Diagnostic text must wrap rather than expand the image area. No new route or navigation pattern is needed for stage inspection.

## Elevation & Depth

Use existing panel backgrounds and borders. Avoid additional shadows or decorative overlays over artwork. Proposed and applied masks retain their separate explanations.

## Shapes

Panels use the existing 14px radius; controls use 8px. The manga page itself remains rectangular.

## Components

Canonical actions use `components/ui/button.tsx`. Native labeled checkboxes use `.check-field`, including the session-local Show region boxes setting. Current stage results and chronological history share the existing `.region-diagnostics` disclosure. Settings reports server commitments separately from provider-confirmed usage.

## Do's and Don'ts

- Preserve stable region selection when overlays are hidden.
- Keep original, clean, translated and applied/proposed mask previews distinct.
- Report failures explicitly and retain original artwork when replacement cannot be rendered safely.
- Do not imply successful translation from a completed request or conceal partial coverage.
- Do not introduce a new visual system for these reliability changes.

## Hosted browser processing

The approved hosted variant preserves the existing visual identity. The shared
BrowserProcessor status panel uses panel/text/accent tokens and remains in normal
document flow on small screens. Browser exports and editor rendering use the same
CJK font as the backend, self-hosted with its OFL license. Native selects remain
platform-owned. UX-CONTRACT.md owns hosted progress, interruption, and recovery.
