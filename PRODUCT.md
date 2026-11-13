# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Mixed audience, with solo short-form creators as the primary day-to-day user:
one person with a raw clip and a deadline, on a laptop, asking in plain language
for the cut a social platform needs. Secondary: small marketing/social teams
producing client or campaign cuts. Tertiary: developers consuming the HTTP API,
including the separate Android Skills client.

## Product Purpose

Upload a clip, describe the change in chat, get a real rendered file back.
Success is a usable cut produced in one conversation, without learning a
timeline editor.

## Positioning

A free-form request becomes a real server-side render. It works with any
supported LLM key or with no key at all (offline local engine), and it runs
self-hosted. A browser-only editor or a provider-locked AI filter cannot
truthfully claim the same.

## Operating Context

Laptop browser session with the clip at hand; one video stage beside one chat
panel. Renders are asynchronous and become versioned results. Media work runs
through committed static ffmpeg binaries plus an optional Python service for
detection, STT, and caption work; Remotion and OTIO cover the timeline path.
The separate Android client drives the same backend through the Skills API.

## Capabilities and Constraints

- Zero-dependency Node server, no build step, committed static ffmpeg/ffprobe
  per architecture.
- Chat-first single-page UI: free-form editing requests, plus quick chips and a
  caption composer.
- Auth gate via `AUTH_TOKEN` (login box; `/api/health` stays open).
- Job retention via `JOBS_TTL_HOURS` (default 24h); jobs persist on disk.
- Offline local engine fallback when no LLM key is configured.
- Android Skills API contract: stable skill IDs, bounded `context`, and health
  capability flags that the client depends on.
- Trimming, version preview/pin, A/B compare, overlays, captions (pasted script
  or auto-transcribe), projects list.

## Brand Commitments

Existing product name: AI Clip Studio. Existing UI voice is casual and
direct, with emoji used as functional labels. The name and voice are in use and
should not be replaced casually; no other brand assets are committed.

## Evidence on Hand

None. No public demo URL, screenshots, testimonials, customers, benchmark
numbers, pricing, or license claims exist in the repo. Future work must not
fabricate them. `images/` and `docs/` are empty.

## Product Principles

1. The conversation is the interface; the render is the answer.
2. Never dead-end on a missing provider key: degrade to the local engine.
3. Ship as one self-hostable unit with no build step or runtime dependency.
4. Every render is a version the user can compare, pin, or discard.
5. Platform-ready output (vertical ratio, captions, trim) beats generic filters.
