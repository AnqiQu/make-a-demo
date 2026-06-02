# Organize Product Modules Around the Linear Pipeline

MakeADemo product modules should be organized around the user-facing pipeline stages: Context Gathering, Project Validation, Script Generation with Footage Capture, Compositing, and final output. We chose stage-first modules over capability-first modules because the product is a linear demo-production workflow; capabilities such as sandbox execution, browser automation, model calls, artifact storage, and rendering should sit behind interfaces used by those stage modules rather than becoming the top-level product architecture.

The initial buildout should gather context, verify repo runnability, and generate a read-only Video Script with one raw Scene per Scene Description. Later buildout should add script editing semantics and bare-bones compositing from those Scenes, then make compositing production-ready with polished text, transitions, and effects.
