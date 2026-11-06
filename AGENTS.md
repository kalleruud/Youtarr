# Youtarr for Svetflix

## Goal and specifications

Complete the backlog in [roadmap #1](https://github.com/kalleruud/Youtarr/issues/1) for the fork [kalleruud/Youtarr](https://github.com/kalleruud/Youtarr):

- Readable captions, recoverable repair of existing tracks, and caption provenance.
- A Jellyfin TV library: channel → show, publication year → season, video → stable episode.
- TV metadata, portrait show posters, landscape episode thumbnails, and safe migration of existing downloads and user state.
- Independent per-channel video and livestream policies, on-demand streaming, and stable STRM publication.
- Reliable live discovery and recording, honest partial-capture/gap reporting, and replay reconciliation.
- Acquisition health, bounded resources, regression coverage, and reversible release checks.

Read the assigned issue, its comments and dependencies, the roadmap, `CLAUDE.md`, and `/home/agent/.agents/AGENTS.md`. Issue acceptance criteria define completion; missing dependencies or unperformed manual checks must remain explicit. Apply the reliability and release requirements in #18 and #19 throughout the feature work.

## Repository guidance

- Source: `/mnt/user/appdata/t3-code/.t3/projects/youtarr`, also available as `/home/agent/.t3/projects/youtarr`.
- Extend the existing React/TypeScript frontend, Node/Express backend, Sequelize/MariaDB persistence, and yt-dlp/FFmpeg pipeline. Follow `CLAUDE.md` for implementation, security, testing, and documentation standards.
- This fork targets `kalleruud/Youtarr:main`; upstream's `dev` branch/release convention does not apply.
- Keep changes focused on the assigned issue. Preserve upstream notices and unrelated edits; avoid incidental dependency upgrades, adjacent refactors, and stack-script redesigns.
- The canonical checkout's uncommitted Dockerfile and `.dockerignore` changes are intentional. Preserve them. Production's manual rebuild uses this checkout: do not switch its branch, reset it, clean it, or pull feature code into it during development.
- The owner confirmed that the fork builds and runs in Svetflix. The Dockerfile builds the frontend inside Docker; do not introduce host npm requirements or build helper scripts.
- Foundation issue #2 must make inherited publishing workflows fork-safe while preserving useful CI. Do not trigger upstream releases or configure production publishing credentials.

## Data and production boundaries

- Backlog implementation, focused commits, branch pushes, PRs, and qualifying merges are authorized. Production deployment, container restarts, live data repair/migration, and production Compose changes require separate authorization.
- Keep the existing Svetflix stack and Jellyfin instance. Preserve `youtarr-db`, its MariaDB image, and its named volume. Application migrations must be reviewed, additive where possible, and tested using disposable data.
- Never run a development app or upstream dev Compose against the production database. Use fixtures, mocks, temporary directories, and disposable services. Keep one application writer against production.
- Never commit credentials, cookies, tokens, private environment files, runtime configuration, downloaded media, or database contents.
- Runtime settings belong in service-specific `env_file` files: Youtarr and its database share private `.env.youtarr`. Compose interpolation inputs, shared paths, ports, and UID/GID belong in the private stack `.env`. Do not create example environment files for this fork.
- Production currently uses a build-only `youtarr` service with the canonical checkout as its default context, without an explicit app image tag or pull policy. Inspect effective stack configuration before proposing changes.
- T3 has no Docker CLI/socket. Use CI for image builds and disposable container checks; host builds, rollback rehearsals, and Jellyfin/JellySee validation require separately authorized host operations. Do not expose Docker access incidentally.
- Before a schema-changing deployment, retain a recoverable prior app image and matching database/config backup. Image rollback alone does not reverse a database migration. Never delete appdata or volumes as a troubleshooting shortcut.
