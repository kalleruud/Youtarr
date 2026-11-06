# Svetflix fork: build and release

These are instructions for a future separately authorized host operation, not evidence of a deployment. The owner confirmed the existing local build runs. PR CI builds a clean checkout, tests context filtering and runs the image with disposable MariaDB; it does not validate the Svetflix stack, host filesystem, Jellyfin or rollback. T3 has no Docker access. Complete the wider release checks in #19, including client checks and a restore rehearsal, before release.

The existing stack has a **build-only** `youtarr` service, with context `${YOUTARR_SOURCE_PATH:-/mnt/user/appdata/t3-code/.t3/projects/youtarr}`; it has no explicit app image or pull policy. The frontend builds inside Docker. Pulling a stack can skip build-only services: it does not build this image. Check installed Compose Manager behavior and the effective Compose files before use. Do not change the database service, its image or volume, runtime env file, UID/GID, mounts or paths. Never run a development stack against the production database.

## Build identity

The Dockerfile accepts optional `SOURCE_REVISION` and `SOURCE_STATE` build arguments, stored in OCI labels `org.opencontainers.image.revision` and `org.opencontainers.image.version`. Both default to `unknown`; they are caller assertions, not automatically verified. A revision by itself does not prove the build is clean. Record the resulting image ID as well as the labels. Do not put secrets, environment contents, filenames, or private data in labels.

For the normal build from the existing checkout, treat the source as **unverified**, even when Git reports clean: ignored or untracked inputs may be sent to Docker. Generate a fresh unique identifier for each build, including retries, and record it with the checkout's base revision. This identifies the build without hashing or exposing private runtime data; it is not a content digest and does not establish reproducibility. Inspect changes and untracked build inputs privately before building. Avoid modifying source while the build runs.

From the existing stack directory, after reviewing its effective Compose configuration and preserving the previous image as described below:

```sh
source_revision=$(git -C /mnt/user/appdata/t3-code/.t3/projects/youtarr rev-parse HEAD)
source_state="unverified-$(cat /proc/sys/kernel/random/uuid)"
docker compose --progress plain build --build-arg "SOURCE_REVISION=$source_revision" --build-arg "SOURCE_STATE=$source_state" youtarr
docker compose up -d --no-deps --no-build youtarr
app_container=$(docker compose ps -q youtarr)
docker inspect --format 'Image ID: {{.Image}}' "$app_container"
docker image inspect --format 'Revision: {{index .Config.Labels "org.opencontainers.image.revision"}}; source state: {{index .Config.Labels "org.opencontainers.image.version"}}' "$(docker inspect --format '{{.Image}}' "$app_container")"
```

Use the actual stack's Compose file selection and project name consistently for all commands. The known-working fallback without metadata is `docker compose --progress plain build youtarr` followed by `docker compose up -d --no-deps --no-build youtarr`; its identity labels are `unknown`. The build does not change the running container until the `up` command. A clean-revision assertion is appropriate only when building an immutable, reviewed export of that revision with no added inputs; ordinary checkout builds above do not make that assertion. External base images and downloaded tools are not pinned by source revision, so retain the actual image ID.

To build a verified clean source tree instead, export the reviewed commit to a new temporary directory, build only from that export, and record the exact full revision. This omits all working-tree changes, including untracked or ignored inputs. Inspect the export and ensure it contains all required source before building; never copy private runtime files into it. The source revision identifies the export, not the external downloads used by the build. From the stack directory, with the previous image already retained:

```sh
source_revision=$(git -C /mnt/user/appdata/t3-code/.t3/projects/youtarr rev-parse HEAD)
source_export=$(mktemp -d)
git -C /mnt/user/appdata/t3-code/.t3/projects/youtarr archive "$source_revision" | tar -x -C "$source_export"
YOUTARR_SOURCE_PATH="$source_export" docker compose --progress plain build --build-arg "SOURCE_REVISION=$source_revision" --build-arg SOURCE_STATE=clean youtarr
rm -rf "$source_export"
```

Only use `clean` for this immutable export procedure after reviewing the revision and export. Then use the app-only `up` and image inspection commands above. If the build fails, remove the temporary export after inspection; it contains source, not persistent app data.

## Before update and rollback

Before any authorized update, capture the running app container's image ID and tag that ID with a unique local rollback tag **before** any update or pruning. Record the app's effective UID/GID, mounts, paths and configuration, and record the database container and volume identity. Take and verify a consistent, matching database and configuration backup before schema-changing deployment; retain it alongside the image and record the schema revision. Protect backups and configuration as private data. Do not delete volumes or use `compose down -v`.

```sh
app_container=$(docker compose ps -q youtarr)
previous_image=$(docker inspect --format '{{.Image}}' "$app_container")
rollback_tag="youtarr-local-rollback:$(date -u +%Y%m%dT%H%M%SZ)"
docker tag "$previous_image" "$rollback_tag"
printf 'Previous app image: %s\nRollback tag: %s\n' "$previous_image" "$rollback_tag"
docker compose ps youtarr-db
docker inspect --format '{{.Id}} {{range .Mounts}}{{if eq .Destination "/var/lib/mysql"}}{{.Type}} {{.Name}} {{.Source}}{{end}}{{end}}' "$(docker compose ps -q youtarr-db)"
```

Confirm the tag and backups are retained before building. After updating, record the new image ID and verify app health, logs, database identity, paths and the relevant Jellyfin/JellySee behavior. A previous image alone cannot reverse a database migration; for an incompatible schema, stop and follow the tested matching database/config restore plan before returning to the older application. Restoring data requires separate authorization and a verified backup.

For an authorized app-only rollback, create a temporary Compose override outside the persistent stack configuration containing the retained tag. Use the exact base Compose file selection and project name used by the stack; the example assumes a single `compose.yml` base file, which must be replaced with the actual selection. Verify the rendered service privately before applying it. `--no-deps` preserves the database container and `--no-build --pull never` uses the retained local image. Remove only the temporary override afterward; the running app continues using the prior image.

```sh
rollback_override=$(mktemp)
printf 'services:\n  youtarr:\n    image: %s\n' "$rollback_tag" > "$rollback_override"
docker compose -f compose.yml -f "$rollback_override" config --quiet
docker compose -f compose.yml -f "$rollback_override" up -d --no-deps --no-build --pull never youtarr
rm -f "$rollback_override"
```

Verify the running image ID equals the recorded previous ID, check app/database health and confirm the database container and volume identities are unchanged. The next normal build/update uses the persistent stack configuration again. Do not prune the rollback image until the release and recovery window have passed.
