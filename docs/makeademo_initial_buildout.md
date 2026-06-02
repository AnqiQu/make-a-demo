# Goal

A website that:

- Takes in your codebase and a description of what your product video is   
- Makes a video demo of it automatically

## V1 Scope

- Target users: hackathon participants and early founders making small projects
- Supported projects: browser-accessible JavaScript/TypeScript web apps only
- Output: a short text-led demo video using captured product footage, display text, and generic background music
- Not in v1: voiceover videos, CLI tools, mobile apps, desktop apps, and API-only projects

# The Architecture

## Agent

Needs to accept:

- GitHub repo URL
- Demo run command, such as `npm run demo`
- Key product features to demo

Output: A demo video that cover—
- What the product does  
- The main differentiating features of the product
- Display text instead of narration
- Background music from a generic library

Repo execution contract:
- The submitted repo should expose a dedicated demo run command, such as `npm run demo`
- The submitted repo should include a tiny `makeademo.config.json` declaring only the demo command and local URL
- The demo run command should start the app in a deterministic demo mode
- Dependency installation may use the network
- Demo mode should run without runtime network access, external APIs, external databases, environment files, secrets, paid services, OAuth, or manual setup
- After dependency installation, any inbound or outbound network communication across the sandbox boundary is a hard validation failure
- Demo data should be seeded or mocked automatically
- If the repo does not satisfy this contract, MakeADemo should provide a copy-paste preparation prompt for the maker to use with their own coding agent
- MakeADemo should not directly modify the maker's repo in v1

–
- Typescript monorepo  
- Tanstack start (starter, basically nextjs+template but not nextjs)  
- Deployed on Railway (better Vercel)

### Backend

- BetterAuth (if we need auth) (optional)
- Tanstack db (if we need better load times) (optional)
- ElectricSQL (just for better sql, if we need it)(optional)
- Drizzle ORM (better prisma)  
- HonoAPI (for frontend-backend comms)
- Postgres  
- Cloudflare R2 storage (better AWS S3)  
- Pino (dead simple observability logging)

Agent stuff:

- Docker sandbox  
- PreMotion  
- Playwright
- Repo validation should run as a backend job in an isolated Docker sandbox

### Frontend

- Tailwind CSS  
- React  
- UploadThing

# Buildout Roadmap

This document is the overall planning roadmap. The fine-grained Stage 1 PRD lives in `docs/prd/makeademo_stage1_prd.md`.

## Stage 1: Prepare, Validate, Script, and Capture Raw Scenes

Goal: prove that MakeADemo can take a prepared JavaScript/TypeScript web app, validate that it satisfies the Demo Run Contract, generate a read-only Video Script, and produce raw Scene footage for each Scene Description.

Stage 1 intentionally stops before final compositing and user editing semantics.

### Modules to build

- Preparation Prompt Generator: produces the copy-paste prompt the maker gives to their coding agent.
- Project Intake: captures the GitHub repo URL and key product features to demo.
- MakeADemo Config Loader: reads and validates the tiny `makeademo.config.json` from the submitted repo.
- Install Plan Inference: chooses the dependency install command from standard JavaScript lockfiles.
- Sandbox Runner: clones the repo, installs dependencies, seals the sandbox network boundary, runs the demo command, and extracts artifacts.
- Project Validation: verifies that the repo satisfies the Demo Run Contract before any LLM script generation.
- Browser Validation: runs Playwright inside the sandbox to load the configured local URL, detect obvious broken states, and capture screenshot proof.
- Script Generator: generates the read-only Video Script from key product features and validated repo context.
- Capture Script Generator: creates one Playwright Capture Script for each Scene Description.
- Scene Recorder: runs each Capture Script in the sandbox and produces one raw Scene per Scene Description.
- Artifact Store: stores logs, screenshots, Capture Scripts, and raw Scene videos.
- Pipeline Job Orchestrator: coordinates the linear Stage 1 flow without owning each module's internal logic.

### Stage 1 user flow

#### 1. Prepare Demo Command
- MakeADemo gives the user a copy-paste prompt for their coding agent.
- The prompt asks the user's coding agent to add a demo run command, such as `npm run demo`, that satisfies the Demo Run Contract.
- The prompt asks the user's coding agent to add `makeademo.config.json` with the demo command and local URL.
- The user applies the change in their own repo and pushes it before submitting repo details to MakeADemo.

#### 2. Gather Context
- The user provides a GitHub repo URL.
- The user lists the key product features the demo should show.
- MakeADemo reads the demo command and local URL from `makeademo.config.json` in the submitted repo.

#### 3. Validate Repo Runnability
- MakeADemo programmatically checks whether the repo can be installed and started with the demo run command.
- MakeADemo infers the dependency install command from standard lockfiles and installs dependencies with network access allowed.
- MakeADemo runs the demo command in a backend Docker sandbox without LLM API calls.
- Any inbound or outbound network communication across the sandbox boundary after dependency installation fails validation.
- MakeADemo runs Playwright inside the same isolated sandbox and opens the running app locally inside that sandbox.
- Validation succeeds when the app is responsive, interactable, and capturable in a browser.
- Validation should capture proof, such as a screenshot, and report clear failure reasons when the repo cannot be run.
- If the repo is not ready, MakeADemo gives the user a preparation prompt to paste into their own coding agent.

#### 4. Generate Script and Raw Scene Footage
- MakeADemo generates a read-only Video Script from the key product features and validated repo context.
- The Video Script is organized into Script Sections containing Scene Descriptions.
- Each Scene Description has user-readable Browser Actions and a generated Playwright Capture Script.
- MakeADemo runs each Capture Script in a Docker sandbox to produce one raw Scene per Scene Description.
- Each Scene is shown to the user as a Companion Video alongside its Scene Description.

## Stage 2: Editable Script and Bare-Bones Compositing

Goal: turn the Stage 1 output into a basic final video, while introducing the first version of user editing semantics.

Stage 2 should not try to make the video beautiful. It should prove that approved Scene footage can be assembled into a coherent text-led demo video.

### Modules to build or extend

- Script Editor: lets the user rename/reorder Script Sections, revise Scene Descriptions, and adjust Browser Actions through a structured UI.
- Script Revision Flow: regenerates affected Capture Scripts and Scenes when the user changes a Scene Description or Browser Actions.
- Scene Approval: lets the user accept a Companion Video or request regeneration for that Scene.
- Bare-Bones Timeline Builder: orders approved Scenes into a linear demo timeline.
- Basic Compositor: stitches raw Scenes together, trims obvious dead time, and adds simple text overlays from the Video Script.
- Render Job Runner: runs the basic composition job and produces a downloadable video artifact.
- Revision Tracking: records which Script Sections, Scene Descriptions, Capture Scripts, and Scenes belong to a given generated output.

### Stage 2 rough flow

- The user reviews the generated Video Script and Companion Videos.
- The user edits high-level script content through the structured script UI.
- MakeADemo regenerates only the affected Capture Scripts and Scenes.
- The user approves the Scenes to include in the final video.
- MakeADemo assembles the approved Scenes into a bare-bones timeline.
- MakeADemo renders a simple text-led demo video with basic cuts and captions.
- The user downloads the rendered video.

## Stage 3: Production-Ready Compositing

Goal: make the final demo video feel polished enough to ship publicly.

Stage 3 should improve presentation quality without changing the core repo validation and capture contract.

### Modules to build or extend

- Timeline Editor: gives the user lightweight control over scene order, trims, captions, and timing.
- Text and Caption System: applies consistent typography, hierarchy, positioning, and pacing for display text.
- Transition System: adds tasteful transitions between Scenes.
- Visual Effects System: adds polished effects such as zooms, highlights, cursor emphasis, callouts, and motion.
- Music Bed: adds generic background music with simple volume balancing.
- Theme Presets: provides a small set of visual styles for different demo tones.
- Render Quality Profiles: supports different export settings for quick previews and final renders.
- Render Preview Flow: lets the user preview before final export.

### Stage 3 rough flow

- The user starts from the bare-bones composited video.
- MakeADemo applies a default production-ready theme.
- The user can make lightweight timeline and caption adjustments.
- MakeADemo renders preview versions quickly.
- The user exports the final polished demo video.

## Later Possibilities

- Support non-JavaScript/TypeScript web apps.
- Support richer uploaded source material such as pitch decks and product videos.
- Support voiceover generation.
- Support direct GitHub PR creation for demo run command preparation.
- Support team workspaces, saved projects, and multiple generated versions.
- Support a library of reusable demo themes and music beds.
