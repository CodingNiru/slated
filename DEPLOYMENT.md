# Deployment

The application targets Node.js 22.x. The Express app is the root
`server.js` entry point; Vercel serves files in `public/` from its CDN and runs
the Express app as a function.

## Vercel and multi-instance hosts

Local JSON files are suitable only for development or a single host with a
persistent disk. Vercel functions do not provide durable shared disk storage.
For Vercel or multiple application instances, configure:

- `DATABASE_URL`: a PostgreSQL connection string from your provider. Prefer the
  provider's pooled connection string for serverless deployments.
- `PERSISTENCE=postgres`: explicitly selects the shared database adapter.
- `SESSION_SECRET`: a stable, randomly generated secret with at least 32
  characters. Keep the same value across instances and deployments.
- `APP_ENCRYPTION_KEY`: optional 64-character hexadecimal key. It takes
  precedence over `SESSION_SECRET` and can preserve data encrypted with an
  existing local `.data/master.key`.

Run `npm run db:migrate` once with `DATABASE_URL` set before serving traffic.
The database role needs permission to create the storage table and index.
Never commit either environment variable or paste its value into an issue.
If a Canvas token or application secret was ever committed, rotate it; removing
the file from the current revision does not remove it from repository history.

If storage configuration is missing or invalid at startup, the site can still
serve its static page, while API requests return HTTP 503 and the function logs
include the initialization error. Ensure these variables are set for the
deployment's Production environment, not only Preview.

If existing encrypted records in `.data/` must be preserved, the deployment
must use the same encryption key used to create them. Use the original
`SESSION_SECRET`, or set `APP_ENCRYPTION_KEY` to the original 64-character
`.data/master.key` value. Then run `npm run db:import-local` with `DATA_DIR`
pointing to the existing data directory. The import is additive and does not
overwrite records already in PostgreSQL. Do not copy the files to Vercel's
function filesystem; that filesystem is not a durable store.

## Other hosts and Docker

Set `DATABASE_URL`, `PERSISTENCE=postgres`, and `SESSION_SECRET` for durable
shared state on any host.
Without `DATABASE_URL`, non-Vercel hosts use local `.data/` files; mount a
persistent volume there and use one application instance if choosing that mode.
For Docker, mount the persistent volume at `/app/.data` when using file storage.

Build static assets with `npm run build`; Vercel uses `npm run vercel-build`.
The optional static Canvas snapshot is disabled by default. To explicitly
request one, set `BUILD_CANVAS_SNAPSHOT=true` and provide `CANVAS_API_TOKEN`
only in the build environment.
