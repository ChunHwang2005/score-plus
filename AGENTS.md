# ScorePlus workspace instructions

- The Next.js application lives in `frontend/`. Apply the Next.js documentation and generated-agent-file guidance in `frontend/AGENTS.md` when changing it.
- The planned tutor API, model code, data, training, and evaluation live in `ai-service/`; keep AI-specific dependencies and commands there rather than in the static frontend.
- Keep the frontend package static and compatible with the AI-Portal ZIP installer unless the user requests a deployment architecture change.
