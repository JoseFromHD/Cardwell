# Cardwell

Cardwell is a self-hosted flashcard app with a small server API, SQLite storage, and a Docker Compose setup.

## First Login

The first admin account is created automatically when the database is initialized.
You must set a strong admin password before the first deploy:

```bash
CARDWELL_ADMIN_USERNAME=admin CARDWELL_ADMIN_PASSWORD='use-a-long-password' docker compose up --build
```

In Portainer, add these as stack environment variables:

```text
CARDWELL_ADMIN_USERNAME=admin
CARDWELL_ADMIN_PASSWORD=use-a-long-password
```

Cardwell refuses to create the first admin account with the built-in `change-me-now` fallback unless `CARDWELL_ALLOW_DEFAULT_ADMIN_PASSWORD=true` is set intentionally for a local throwaway test.

If the SQLite database already exists, changing these environment variables will not reset the existing admin password. Create a new admin user from the in-app Users panel or restore/recreate the volume intentionally.

If Cardwell is served only through HTTPS, set this too:

```text
CARDWELL_COOKIE_SECURE=true
```

Leave it as `false` for plain HTTP/LAN testing or the browser will not send the login cookie.

## Run With Docker

```bash
docker compose up --build
```

Then open:

```text
http://localhost:8080
```

Data is stored in the `cardwell_data` Docker volume at `/data/cardwell.sqlite3`.

## Deploy With Portainer From GitHub

Use the repository URL:

```text
https://github.com/JoseFromHD/Cardwell.git
```

In Portainer:

1. Go to **Stacks**.
2. Choose **Add stack**.
3. Select **Repository** as the build method.
4. Paste the repository URL above.
5. Set the compose path to:

```text
docker-compose.yml
```

6. Deploy the stack.

The stack builds the app from the included `Dockerfile`, exposes the app on port `8080`, and stores data in the named Docker volume `cardwell_data`.

If Portainer reports `failed to read dockerfile: open Dockerfile: no such file or directory`, use one of these fixes:

- Confirm the repository has `Dockerfile` at the repository root.
- In Portainer's Git/repository deployment, set **Compose path** to `docker-compose.yml`.
- If you are pasting a stack into Portainer's Web Editor instead of deploying from a repository, use `portainer-stack.yml`; it points the Docker build context directly at the GitHub repo.

If port `8080` is already used on your host, edit the left side of the port mapping in `docker-compose.yml`:

```yaml
ports:
  - "8090:8080"
```

Then open `http://your-server-ip:8090`.

## Push This Project To GitHub

From this folder:

```bash
git init
git branch -M main
git remote add origin https://github.com/JoseFromHD/Cardwell.git
git add .
git commit -m "Initial Cardwell self-hosted app"
git push -u origin main
```

Local runtime data such as `data/cardwell.sqlite3` is ignored and should not be committed.

## Run Locally Without Docker

```bash
python3 server.py
```

Then open:

```text
http://localhost:8080
```

Local data is stored in `./data/cardwell.sqlite3` unless `CARDWELL_DATA_DIR` is set.

## Backups

Use the in-app **Export** button to download a JSON backup. Use **Import** to restore a backup into the server database.

Imported decks and cards receive fresh internal IDs. This prevents a crafted backup from overwriting existing cards or granting access to an existing deck by reusing known IDs.

## Security Notes

- State-changing API calls require a same-origin request plus Cardwell's request verification header.
- Login attempts are throttled in-process by username and IP address.
- Session cookies are `HttpOnly` and `SameSite=Lax`; set `CARDWELL_COOKIE_SECURE=true` when serving only through HTTPS.
- The Docker Compose files run the app as a non-root user, drop Linux capabilities, set `no-new-privileges`, and keep the container filesystem read-only except for the mounted `/data` volume and `/tmp`.

## Tests

```bash
python3 -m unittest discover -s tests
```

## Access Control

Cardwell supports three deck roles:

- `owner`: rename/delete decks, manage sharing, and edit cards.
- `editor`: rename decks and edit cards.
- `viewer`: study cards only.

Admins can create study users, create additional owner accounts, and reset account passwords from the Accounts panel. Deck owners can share decks with existing users from the Access panel.

Study progress is tracked per user, so shared decks can be studied independently without one user's review history changing another user's due cards.

## Scaling Notes

This version is containerized and mostly stateless at the web process level, with persistent data mounted separately. Sessions, users, deck access, and cards live in SQLite. SQLite is excellent for a small self-hosted install, but it is still a single-writer database. For heavier multi-user use, the next step is to move storage to Postgres and run multiple app containers behind a reverse proxy such as Caddy, Traefik, or Nginx.
