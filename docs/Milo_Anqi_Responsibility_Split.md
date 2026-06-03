# Milo and Anqi Responsibility Split

## Split Summary

Milo owns the MakeADemo pipeline up to the **Video Script Package**.

Anqi owns everything after the **Video Script Package**, including turning the script into raw videos, compositing, effects, and final rendering.

## Handoff Boundary

The handoff artifact is the **Video Script Package**: the complete output of Script Generation before footage capture begins.

A Video Script Package contains:

- The read-only Video Script
- Script Sections
- Scene Descriptions
- Browser Actions
- Project Validation artifacts, such as logs, warnings, screenshots, and blocked network attempts
- Any script-generation assumptions, warnings, or unresolved capture risks

## Milo Ownership

Milo owns:

- Preparation Prompt Generator
- Context Gathering
- Project Intake
- MakeADemo Config loading and validation
- Demo Run Contract validation
- Dependency install inference
- Sandbox Runner
- Network Isolation Policy
- Project Validation
- Browser Validation
- Script Generation
- Video Script Package creation

Milo's milestone is: generate a complete Video Script Package from a prepared JavaScript/TypeScript web app.

## Anqi Ownership

Anqi owns:

- Compositing
- Capture Script Generation
- Scene Recording
- Companion Videos
- Raw Scene footage
- Timeline assembly
- Text overlays and captions
- Transitions
- Visual effects
- Music bed and audio balancing
- Render preview flow
- Final video rendering
- Export quality and presentation polish

Anqi's milestone is: turn a Video Script Package into raw Scene footage and then compose it into a polished final demo video.

## Interface Between Workstreams

Anqi's video generation work should consume Video Script Packages rather than reaching back into repo validation or script generation internals.

The Video Script Package interface should be stable enough that Milo can iterate on context gathering, validation, and script generation without forcing Anqi to rewrite capture or compositing logic.

The Video Script Package should be explicit about Script Sections, Scene Descriptions, and Browser Actions so that Anqi can generate Capture Scripts, raw Scenes, timeline assembly, captions, and effects predictably.

## Main Risk

The main risk is an unclear handoff boundary. If Anqi receives only loose prose, she inherits script interpretation uncertainty. If Milo provides a structured Video Script Package with Scene Descriptions and Browser Actions, Anqi can focus on video generation and craft: Capture Scripts, raw Scene footage, assembly, effects, polish, and final rendering.
