from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import time
from urllib.parse import urlparse
import uuid


APP_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("CARDWELL_DATA_DIR", APP_DIR / "data"))
DB_PATH = DATA_DIR / "cardwell.sqlite3"
PORT = int(os.environ.get("PORT", "8080"))
SESSION_COOKIE = "cardwell_session"
SESSION_TTL_SECONDS = 60 * 60 * 24 * 14
PASSWORD_ITERATIONS = 260_000
UNSAFE_DEFAULT_ADMIN_PASSWORD = "change-me-now"
DEFAULT_ADMIN_USERNAME = os.environ.get("CARDWELL_ADMIN_USERNAME", "admin")
DEFAULT_ADMIN_PASSWORD = os.environ.get("CARDWELL_ADMIN_PASSWORD", UNSAFE_DEFAULT_ADMIN_PASSWORD)
ALLOW_DEFAULT_ADMIN_PASSWORD = (
    os.environ.get("CARDWELL_ALLOW_DEFAULT_ADMIN_PASSWORD", "false").lower() == "true"
)
COOKIE_SECURE = os.environ.get("CARDWELL_COOKIE_SECURE", "false").lower() == "true"
LOGIN_WINDOW_SECONDS = 15 * 60
LOGIN_MAX_ATTEMPTS = 8
ROLE_ORDER = {"viewer": 1, "editor": 2, "owner": 3}
USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9_.-]{3,80}$")
FAILED_LOGIN_ATTEMPTS = {}
PUBLIC_FILES = {
    "/": "index.html",
    "/index.html": "index.html",
    "/styles.css": "styles.css",
    "/app.js": "app.js",
}


def now_ms():
    return int(time.time() * 1000)


def new_id():
    return str(uuid.uuid4())


def connect():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = WAL")
    connection.execute("PRAGMA busy_timeout = 5000")
    return connection


def hash_password(password, salt=None):
    if salt is None:
        salt = secrets.token_bytes(16)
    password_hash = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS
    )
    return f"pbkdf2_sha256${PASSWORD_ITERATIONS}${salt.hex()}${password_hash.hex()}"


DUMMY_PASSWORD_HASH = hash_password("cardwell-invalid-password")


def verify_password(password, stored_hash):
    try:
        algorithm, iterations, salt_hex, expected_hex = stored_hash.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        actual = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            bytes.fromhex(salt_hex),
            int(iterations),
        ).hex()
        return hmac.compare_digest(actual, expected_hex)
    except (ValueError, TypeError):
        return False


def initialize_database():
    with connect() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
              id TEXT PRIMARY KEY,
              username TEXT NOT NULL UNIQUE COLLATE NOCASE,
              password_hash TEXT NOT NULL,
              is_admin INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
              id TEXT PRIMARY KEY,
              user_id TEXT NOT NULL,
              expires_at INTEGER NOT NULL,
              created_at INTEGER NOT NULL,
              FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS decks (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS deck_access (
              deck_id TEXT NOT NULL,
              user_id TEXT NOT NULL,
              role TEXT NOT NULL CHECK(role IN ('owner', 'editor', 'viewer')),
              created_at INTEGER NOT NULL,
              PRIMARY KEY(deck_id, user_id),
              FOREIGN KEY(deck_id) REFERENCES decks(id) ON DELETE CASCADE,
              FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS cards (
              id TEXT PRIMARY KEY,
              deck_id TEXT NOT NULL,
              front TEXT NOT NULL,
              back TEXT NOT NULL,
              interval INTEGER NOT NULL DEFAULT 0,
              ease REAL NOT NULL DEFAULT 2.5,
              due_at INTEGER NOT NULL,
              reviews INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL,
              FOREIGN KEY(deck_id) REFERENCES decks(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS user_card_progress (
              user_id TEXT NOT NULL,
              card_id TEXT NOT NULL,
              interval INTEGER NOT NULL DEFAULT 0,
              ease REAL NOT NULL DEFAULT 2.5,
              due_at INTEGER NOT NULL,
              reviews INTEGER NOT NULL DEFAULT 0,
              updated_at INTEGER NOT NULL,
              PRIMARY KEY(user_id, card_id),
              FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
              FOREIGN KEY(card_id) REFERENCES cards(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
            CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
            CREATE INDEX IF NOT EXISTS idx_deck_access_user_id ON deck_access(user_id);
            CREATE INDEX IF NOT EXISTS idx_cards_deck_id ON cards(deck_id);
            CREATE INDEX IF NOT EXISTS idx_cards_due_at ON cards(due_at);
            CREATE INDEX IF NOT EXISTS idx_user_card_progress_card_id ON user_card_progress(card_id);
            """
        )

        timestamp = now_ms()
        admin = db.execute("SELECT id FROM users WHERE is_admin = 1 LIMIT 1").fetchone()
        if not admin:
            if (
                DEFAULT_ADMIN_PASSWORD == UNSAFE_DEFAULT_ADMIN_PASSWORD
                and not ALLOW_DEFAULT_ADMIN_PASSWORD
            ):
                raise RuntimeError(
                    "Set CARDWELL_ADMIN_PASSWORD before first startup. "
                    "The built-in default password is disabled for safety."
                )
            admin_id = new_id()
            db.execute(
                """
                INSERT INTO users (id, username, password_hash, is_admin, created_at)
                VALUES (?, ?, ?, 1, ?)
                """,
                (
                    admin_id,
                    DEFAULT_ADMIN_USERNAME,
                    hash_password(DEFAULT_ADMIN_PASSWORD),
                    timestamp,
                ),
            )
        else:
            admin_id = admin["id"]

        deck_count = db.execute("SELECT COUNT(*) AS count FROM decks").fetchone()["count"]
        if deck_count == 0:
            seed_deck_id = new_id()
            db.execute(
                "INSERT INTO decks (id, name, created_at) VALUES (?, ?, ?)",
                (seed_deck_id, "General Knowledge", timestamp),
            )
            db.execute(
                """
                INSERT INTO deck_access (deck_id, user_id, role, created_at)
                VALUES (?, ?, 'owner', ?)
                """,
                (seed_deck_id, admin_id, timestamp),
            )
            seed_cards = [
                (
                    new_id(),
                    seed_deck_id,
                    "What does spaced repetition optimize?",
                    "Review timing, so cards reappear when they are most useful to remember.",
                    0,
                    2.5,
                    timestamp,
                    0,
                    timestamp,
                ),
                (
                    new_id(),
                    seed_deck_id,
                    "Where does the Docker version store data?",
                    "In a SQLite database mounted at /data/cardwell.sqlite3.",
                    0,
                    2.5,
                    timestamp,
                    0,
                    timestamp,
                ),
            ]
            db.executemany(
                """
                INSERT INTO cards
                  (id, deck_id, front, back, interval, ease, due_at, reviews, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                seed_cards,
            )
        else:
            db.execute(
                """
                INSERT OR IGNORE INTO deck_access (deck_id, user_id, role, created_at)
                SELECT id, ?, 'owner', ? FROM decks
                WHERE id NOT IN (SELECT deck_id FROM deck_access)
                """,
                (admin_id, timestamp),
            )

        db.execute(
            """
            INSERT OR IGNORE INTO user_card_progress
              (user_id, card_id, interval, ease, due_at, reviews, updated_at)
            SELECT deck_access.user_id, cards.id, cards.interval, cards.ease, cards.due_at, cards.reviews, ?
            FROM cards
            JOIN deck_access ON deck_access.deck_id = cards.deck_id
            """,
            (timestamp,),
        )
        db.execute("DELETE FROM sessions WHERE expires_at <= ?", (now_ms(),))


def get_user_by_session(session_id):
    if not session_id:
        return None
    with connect() as db:
        row = db.execute(
            """
            SELECT users.id, users.username, users.is_admin
            FROM sessions
            JOIN users ON users.id = sessions.user_id
            WHERE sessions.id = ? AND sessions.expires_at > ?
            """,
            (session_id, now_ms()),
        ).fetchone()
    if not row:
        return None
    return {"id": row["id"], "username": row["username"], "isAdmin": bool(row["is_admin"])}


def public_user(row):
    return {"id": row["id"], "username": row["username"], "isAdmin": bool(row["is_admin"])}


def get_state(user):
    with connect() as db:
        decks = [
            {
                "id": row["id"],
                "name": row["name"],
                "role": row["role"],
                "cards": [],
                "access": [],
            }
            for row in db.execute(
                """
                SELECT decks.id, decks.name, deck_access.role, decks.created_at
                FROM decks
                JOIN deck_access ON deck_access.deck_id = decks.id
                WHERE deck_access.user_id = ?
                ORDER BY decks.created_at, decks.name
                """,
                (user["id"],),
            )
        ]
        cards_by_deck = {deck["id"]: deck["cards"] for deck in decks}
        access_by_deck = {deck["id"]: deck["access"] for deck in decks}

        if decks:
            deck_ids = [deck["id"] for deck in decks]
            placeholders = ",".join("?" for _ in deck_ids)
            for row in db.execute(
                f"""
                SELECT
                  cards.id,
                  cards.deck_id,
                  cards.front,
                  cards.back,
                  COALESCE(user_card_progress.interval, cards.interval) AS interval,
                  COALESCE(user_card_progress.ease, cards.ease) AS ease,
                  COALESCE(user_card_progress.due_at, cards.due_at) AS due_at,
                  COALESCE(user_card_progress.reviews, cards.reviews) AS reviews
                FROM cards
                LEFT JOIN user_card_progress
                  ON user_card_progress.card_id = cards.id
                  AND user_card_progress.user_id = ?
                WHERE deck_id IN ({placeholders})
                ORDER BY cards.created_at DESC
                """,
                [user["id"], *deck_ids],
            ):
                cards_by_deck[row["deck_id"]].append(
                    {
                        "id": row["id"],
                        "front": row["front"],
                        "back": row["back"],
                        "interval": row["interval"],
                        "ease": row["ease"],
                        "dueAt": row["due_at"],
                        "reviews": row["reviews"],
                    }
                )
            owner_deck_ids = [deck["id"] for deck in decks if deck["role"] == "owner"]
            if not owner_deck_ids:
                return {"user": user, "decks": decks}
            owner_placeholders = ",".join("?" for _ in owner_deck_ids)
            for row in db.execute(
                f"""
                SELECT deck_access.deck_id, users.id, users.username, deck_access.role
                FROM deck_access
                JOIN users ON users.id = deck_access.user_id
                WHERE deck_access.deck_id IN ({owner_placeholders})
                ORDER BY users.username
                """,
                owner_deck_ids,
            ):
                access_by_deck[row["deck_id"]].append(
                    {"userId": row["id"], "username": row["username"], "role": row["role"]}
                )
    return {"user": user, "decks": decks}


def apply_rating(card, rating):
    interval = int(card["interval"])
    ease = float(card["ease"])
    ratings = {
        "again": (0, -0.2),
        "hard": (max(1, round(interval * 1.2)), -0.05),
        "good": (1 if interval == 0 else round(interval * ease), 0),
        "easy": (4 if interval == 0 else round(interval * (ease + 0.6)), 0.15),
    }
    if rating not in ratings:
        raise ValueError("Unsupported review rating")

    next_interval, ease_delta = ratings[rating]
    next_ease = max(1.3, round(ease + ease_delta, 2))
    return {
        "interval": next_interval,
        "ease": next_ease,
        "due_at": now_ms() + next_interval * 24 * 60 * 60 * 1000,
        "reviews": int(card["reviews"]) + 1,
    }


def read_json(handler):
    length = int(handler.headers.get("content-length", "0"))
    if length == 0:
        return {}
    if length > 2_000_000:
        raise ValueError("Request body is too large")
    try:
        return json.loads(handler.rfile.read(length).decode("utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError("Request body must be valid JSON") from error


def require_text(data, key, max_length=240):
    value = data.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} is required")
    value = value.strip()
    if len(value) > max_length:
        raise ValueError(f"{key} must be {max_length} characters or less")
    return value


def require_password(data):
    password = data.get("password")
    if not isinstance(password, str) or len(password) < 8:
        raise ValueError("password must be at least 8 characters")
    if len(password) > 512:
        raise ValueError("password is too long")
    return password


def require_username(data):
    username = require_text(data, "username", 80)
    if not USERNAME_PATTERN.fullmatch(username):
        raise ValueError("username must be 3-80 characters using letters, numbers, dots, dashes, or underscores")
    return username


def prune_login_attempts(key):
    cutoff = time.time() - LOGIN_WINDOW_SECONDS
    attempts = [attempt for attempt in FAILED_LOGIN_ATTEMPTS.get(key, []) if attempt >= cutoff]
    if attempts:
        FAILED_LOGIN_ATTEMPTS[key] = attempts
    else:
        FAILED_LOGIN_ATTEMPTS.pop(key, None)
    return attempts


def login_rate_keys(username, ip_address):
    normalized_username = username.lower()
    return (("user", normalized_username), ("ip", ip_address))


def login_is_rate_limited(username, ip_address):
    return any(
        len(prune_login_attempts(key)) >= LOGIN_MAX_ATTEMPTS
        for key in login_rate_keys(username, ip_address)
    )


def record_failed_login(username, ip_address):
    timestamp = time.time()
    for key in login_rate_keys(username, ip_address):
        attempts = prune_login_attempts(key)
        attempts.append(timestamp)
        FAILED_LOGIN_ATTEMPTS[key] = attempts[-LOGIN_MAX_ATTEMPTS:]


def clear_failed_login(username):
    FAILED_LOGIN_ATTEMPTS.pop(("user", username.lower()), None)


def same_origin(headers, candidate):
    host = headers.get("Host")
    if not host or not candidate:
        return True
    parsed = urlparse(candidate)
    return parsed.scheme in {"http", "https"} and parsed.netloc.lower() == host.lower()


def request_origin_is_allowed(headers):
    origin = headers.get("Origin")
    if origin:
        return same_origin(headers, origin)
    referer = headers.get("Referer")
    if referer:
        return same_origin(headers, referer)
    return True


def clean_import_text(value, key, max_length, default=None):
    if not isinstance(value, str):
        return default
    value = value.strip()
    if not value:
        return default
    if len(value) > max_length:
        raise ValueError(f"{key} must be {max_length} characters or less")
    return value


def clean_import_int(value, default, minimum, maximum, key):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    if number < minimum or number > maximum:
        raise ValueError(f"{key} must be between {minimum} and {maximum}")
    return number


def clean_import_float(value, default, minimum, maximum, key):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if number < minimum or number > maximum:
        raise ValueError(f"{key} must be between {minimum} and {maximum}")
    return number


def import_decks_for_user(db, user_id, decks, timestamp):
    imported_deck_ids = []

    for deck in decks:
        if not isinstance(deck, dict):
            continue

        deck_id = new_id()
        name = clean_import_text(deck.get("name"), "deck name", 240, "Untitled deck")
        db.execute(
            "INSERT INTO decks (id, name, created_at) VALUES (?, ?, ?)",
            (deck_id, name, timestamp),
        )
        db.execute(
            """
            INSERT INTO deck_access (deck_id, user_id, role, created_at)
            VALUES (?, ?, 'owner', ?)
            """,
            (deck_id, user_id, timestamp),
        )
        imported_deck_ids.append(deck_id)

        cards = deck.get("cards") if isinstance(deck.get("cards"), list) else []
        for card in cards:
            if not isinstance(card, dict):
                continue
            front = clean_import_text(card.get("front"), "front", 4000)
            back = clean_import_text(card.get("back"), "back", 4000)
            if not front or not back:
                continue

            card_id = new_id()
            interval = clean_import_int(card.get("interval", 0), 0, 0, 36500, "interval")
            ease = clean_import_float(card.get("ease", 2.5), 2.5, 1.3, 5.0, "ease")
            due_at = clean_import_int(card.get("dueAt", timestamp), timestamp, 0, 4_102_444_800_000, "dueAt")
            reviews = clean_import_int(card.get("reviews", 0), 0, 0, 1_000_000, "reviews")
            db.execute(
                """
                INSERT INTO cards
                  (id, deck_id, front, back, interval, ease, due_at, reviews, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    card_id,
                    deck_id,
                    front,
                    back,
                    interval,
                    ease,
                    due_at,
                    reviews,
                    timestamp,
                ),
            )
            db.execute(
                """
                INSERT INTO user_card_progress
                  (user_id, card_id, interval, ease, due_at, reviews, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (user_id, card_id, interval, ease, due_at, reviews, timestamp),
            )

    return imported_deck_ids


class CardwellHandler(SimpleHTTPRequestHandler):
    server_version = "Cardwell/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP_DIR), **kwargs)

    @property
    def route(self):
        return urlparse(self.path).path

    def require_request_integrity(self):
        if not request_origin_is_allowed(self.headers):
            self.send_error_json(HTTPStatus.FORBIDDEN, "Cross-origin requests are not allowed")
            return False
        if self.headers.get("X-Cardwell-CSRF") != "1":
            self.send_error_json(HTTPStatus.FORBIDDEN, "Missing request verification header")
            return False
        return True

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Content-Security-Policy", "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'")
        self.send_header("Cache-Control", "no-store" if self.route.startswith("/api/") else "public, max-age=60")
        super().end_headers()

    def do_GET(self):
        if self.route == "/api/health":
            self.send_json({"ok": True})
            return
        if self.route == "/api/me":
            user = self.require_user()
            if not user:
                return
            self.send_json({"user": user})
            return
        if self.route == "/api/state":
            user = self.require_user()
            if not user:
                return
            self.send_json(get_state(user))
            return
        if self.route == "/api/users":
            user = self.require_user()
            if not user:
                return
            if not user["isAdmin"]:
                self.send_error_json(HTTPStatus.FORBIDDEN, "Only admins can view users")
                return
            self.list_users()
            return
        if self.route == "/api/export":
            user = self.require_user()
            if not user:
                return
            body = json.dumps(get_state(user), indent=2).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Disposition", "attachment; filename=cardwell-backup.json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        match = re.fullmatch(r"/api/decks/([^/]+)/access", self.route)
        if match:
            user = self.require_user()
            if not user:
                return
            self.list_deck_access(user, match.group(1))
            return
        self.serve_static()

    def do_POST(self):
        if not self.require_request_integrity():
            return
        try:
            if self.route == "/api/login":
                self.login()
                return
            if self.route == "/api/logout":
                self.logout()
                return

            user = self.require_user()
            if not user:
                return
            if self.route == "/api/decks":
                self.create_deck(user)
                return
            if self.route == "/api/import":
                self.import_backup(user)
                return
            if self.route == "/api/users":
                self.create_user(user)
                return
            match = re.fullmatch(r"/api/decks/([^/]+)/cards", self.route)
            if match:
                self.create_card(user, match.group(1))
                return
            match = re.fullmatch(r"/api/decks/([^/]+)/access", self.route)
            if match:
                self.grant_deck_access(user, match.group(1))
                return
            match = re.fullmatch(r"/api/cards/([^/]+)/review", self.route)
            if match:
                self.review_card(user, match.group(1))
                return
            self.send_error_json(HTTPStatus.NOT_FOUND, "Not found")
        except ValueError as error:
            self.send_error_json(HTTPStatus.BAD_REQUEST, str(error))

    def do_PATCH(self):
        if not self.require_request_integrity():
            return
        try:
            user = self.require_user()
            if not user:
                return
            match = re.fullmatch(r"/api/decks/([^/]+)", self.route)
            if match:
                self.rename_deck(user, match.group(1))
                return
            match = re.fullmatch(r"/api/cards/([^/]+)", self.route)
            if match:
                self.update_card(user, match.group(1))
                return
            self.send_error_json(HTTPStatus.NOT_FOUND, "Not found")
        except ValueError as error:
            self.send_error_json(HTTPStatus.BAD_REQUEST, str(error))

    def do_DELETE(self):
        if not self.require_request_integrity():
            return
        user = self.require_user()
        if not user:
            return
        match = re.fullmatch(r"/api/decks/([^/]+)", self.route)
        if match:
            self.delete_deck(user, match.group(1))
            return
        match = re.fullmatch(r"/api/cards/([^/]+)", self.route)
        if match:
            self.delete_card(user, match.group(1))
            return
        match = re.fullmatch(r"/api/decks/([^/]+)/access/([^/]+)", self.route)
        if match:
            self.revoke_deck_access(user, match.group(1), match.group(2))
            return
        self.send_error_json(HTTPStatus.NOT_FOUND, "Not found")

    def serve_static(self):
        filename = PUBLIC_FILES.get(self.route)
        if not filename:
            self.send_error_json(HTTPStatus.NOT_FOUND, "Not found")
            return
        path = APP_DIR / filename
        content_types = {
            ".css": "text/css; charset=utf-8",
            ".html": "text/html; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
        }
        body = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_types[path.suffix])
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def current_user(self):
        cookie = SimpleCookie(self.headers.get("Cookie"))
        morsel = cookie.get(SESSION_COOKIE)
        return get_user_by_session(morsel.value if morsel else None)

    def require_user(self):
        user = self.current_user()
        if not user:
            self.send_error_json(HTTPStatus.UNAUTHORIZED, "Login required")
            return None
        return user

    def require_deck_role(self, user, deck_id, minimum_role):
        with connect() as db:
            row = db.execute(
                "SELECT role FROM deck_access WHERE deck_id = ? AND user_id = ?",
                (deck_id, user["id"]),
            ).fetchone()
        if not row or ROLE_ORDER[row["role"]] < ROLE_ORDER[minimum_role]:
            return None
        return row["role"]

    def require_card_role(self, user, card_id, minimum_role):
        with connect() as db:
            row = db.execute(
                """
                SELECT cards.deck_id, deck_access.role
                FROM cards
                JOIN deck_access ON deck_access.deck_id = cards.deck_id
                WHERE cards.id = ? AND deck_access.user_id = ?
                """,
                (card_id, user["id"]),
            ).fetchone()
        if not row or ROLE_ORDER[row["role"]] < ROLE_ORDER[minimum_role]:
            return None
        return row

    def login(self):
        data = read_json(self)
        username = require_text(data, "username", 80)
        password = data.get("password")
        if not isinstance(password, str):
            raise ValueError("password is required")
        ip_address = self.client_address[0]
        if login_is_rate_limited(username, ip_address):
            self.send_error_json(
                HTTPStatus.TOO_MANY_REQUESTS,
                "Too many failed login attempts. Try again later.",
            )
            return

        with connect() as db:
            row = db.execute(
                "SELECT id, username, password_hash, is_admin FROM users WHERE username = ?",
                (username,),
            ).fetchone()
            password_hash = row["password_hash"] if row else DUMMY_PASSWORD_HASH
            if not verify_password(password, password_hash) or not row:
                record_failed_login(username, ip_address)
                self.send_error_json(HTTPStatus.UNAUTHORIZED, "Invalid username or password")
                return
            session_id = secrets.token_urlsafe(32)
            db.execute(
                "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
                (session_id, row["id"], now_ms() + SESSION_TTL_SECONDS * 1000, now_ms()),
            )
            clear_failed_login(username)

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        secure_attr = "; Secure" if COOKIE_SECURE else ""
        self.send_header(
            "Set-Cookie",
            f"{SESSION_COOKIE}={session_id}; HttpOnly; SameSite=Lax; Path=/; Max-Age={SESSION_TTL_SECONDS}{secure_attr}",
        )
        body = json.dumps({"user": public_user(row)}).encode("utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def logout(self):
        cookie = SimpleCookie(self.headers.get("Cookie"))
        morsel = cookie.get(SESSION_COOKIE)
        if morsel:
            with connect() as db:
                db.execute("DELETE FROM sessions WHERE id = ?", (morsel.value,))
        secure_attr = "; Secure" if COOKIE_SECURE else ""
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self.send_header("Set-Cookie", f"{SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0{secure_attr}")
        body = b'{"ok": true}'
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def list_users(self):
        with connect() as db:
            users = [public_user(row) for row in db.execute("SELECT id, username, is_admin FROM users ORDER BY username")]
        self.send_json({"users": users})

    def create_user(self, current_user):
        if not current_user["isAdmin"]:
            self.send_error_json(HTTPStatus.FORBIDDEN, "Only admins can create users")
            return
        data = read_json(self)
        username = require_username(data)
        password = require_password(data)
        is_admin = 1 if bool(data.get("isAdmin")) else 0
        user_id = new_id()
        try:
            with connect() as db:
                db.execute(
                    """
                    INSERT INTO users (id, username, password_hash, is_admin, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (user_id, username, hash_password(password), is_admin, now_ms()),
                )
        except sqlite3.IntegrityError as error:
            raise ValueError("username is already in use") from error
        self.send_json({"id": user_id, "username": username, "isAdmin": bool(is_admin)}, HTTPStatus.CREATED)

    def create_deck(self, user):
        data = read_json(self)
        deck_id = new_id()
        name = require_text(data, "name")
        with connect() as db:
            db.execute(
                "INSERT INTO decks (id, name, created_at) VALUES (?, ?, ?)",
                (deck_id, name, now_ms()),
            )
            db.execute(
                "INSERT INTO deck_access (deck_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
                (deck_id, user["id"], now_ms()),
            )
        self.send_json({"id": deck_id, "name": name, "cards": [], "role": "owner"}, HTTPStatus.CREATED)

    def rename_deck(self, user, deck_id):
        if not self.require_deck_role(user, deck_id, "editor"):
            self.send_error_json(HTTPStatus.FORBIDDEN, "Editor access required")
            return
        data = read_json(self)
        name = require_text(data, "name")
        with connect() as db:
            cursor = db.execute("UPDATE decks SET name = ? WHERE id = ?", (name, deck_id))
            if cursor.rowcount == 0:
                self.send_error_json(HTTPStatus.NOT_FOUND, "Deck not found")
                return
        self.send_json({"id": deck_id, "name": name})

    def delete_deck(self, user, deck_id):
        if not self.require_deck_role(user, deck_id, "owner"):
            self.send_error_json(HTTPStatus.FORBIDDEN, "Owner access required")
            return
        with connect() as db:
            cursor = db.execute("DELETE FROM decks WHERE id = ?", (deck_id,))
            if cursor.rowcount == 0:
                self.send_error_json(HTTPStatus.NOT_FOUND, "Deck not found")
                return
        self.send_json({"ok": True})

    def create_card(self, user, deck_id):
        if not self.require_deck_role(user, deck_id, "editor"):
            self.send_error_json(HTTPStatus.FORBIDDEN, "Editor access required")
            return
        data = read_json(self)
        front = require_text(data, "front", 4000)
        back = require_text(data, "back", 4000)
        card_id = new_id()
        timestamp = now_ms()
        with connect() as db:
            db.execute(
                """
                INSERT INTO cards
                  (id, deck_id, front, back, interval, ease, due_at, reviews, created_at)
                VALUES (?, ?, ?, ?, 0, 2.5, ?, 0, ?)
                """,
                (card_id, deck_id, front, back, timestamp, timestamp),
            )
        self.send_json({"id": card_id}, HTTPStatus.CREATED)

    def update_card(self, user, card_id):
        if not self.require_card_role(user, card_id, "editor"):
            self.send_error_json(HTTPStatus.FORBIDDEN, "Editor access required")
            return
        data = read_json(self)
        front = require_text(data, "front", 4000)
        back = require_text(data, "back", 4000)
        with connect() as db:
            cursor = db.execute(
                "UPDATE cards SET front = ?, back = ? WHERE id = ?",
                (front, back, card_id),
            )
            if cursor.rowcount == 0:
                self.send_error_json(HTTPStatus.NOT_FOUND, "Card not found")
                return
        self.send_json({"id": card_id})

    def delete_card(self, user, card_id):
        if not self.require_card_role(user, card_id, "editor"):
            self.send_error_json(HTTPStatus.FORBIDDEN, "Editor access required")
            return
        with connect() as db:
            cursor = db.execute("DELETE FROM cards WHERE id = ?", (card_id,))
            if cursor.rowcount == 0:
                self.send_error_json(HTTPStatus.NOT_FOUND, "Card not found")
                return
        self.send_json({"ok": True})

    def review_card(self, user, card_id):
        access = self.require_card_role(user, card_id, "viewer")
        if not access:
            self.send_error_json(HTTPStatus.FORBIDDEN, "Deck access required")
            return
        data = read_json(self)
        rating = require_text(data, "rating")
        with connect() as db:
            card = db.execute(
                """
                SELECT
                  COALESCE(user_card_progress.interval, cards.interval) AS interval,
                  COALESCE(user_card_progress.ease, cards.ease) AS ease,
                  COALESCE(user_card_progress.reviews, cards.reviews) AS reviews
                FROM cards
                LEFT JOIN user_card_progress
                  ON user_card_progress.card_id = cards.id
                  AND user_card_progress.user_id = ?
                WHERE cards.id = ?
                """,
                (user["id"], card_id),
            ).fetchone()
            if not card:
                self.send_error_json(HTTPStatus.NOT_FOUND, "Card not found")
                return
            next_values = apply_rating(card, rating)
            db.execute(
                """
                INSERT INTO user_card_progress
                  (user_id, card_id, interval, ease, due_at, reviews, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(user_id, card_id) DO UPDATE SET
                  interval = excluded.interval,
                  ease = excluded.ease,
                  due_at = excluded.due_at,
                  reviews = excluded.reviews,
                  updated_at = excluded.updated_at
                """,
                (
                    user["id"],
                    card_id,
                    next_values["interval"],
                    next_values["ease"],
                    next_values["due_at"],
                    next_values["reviews"],
                    now_ms(),
                ),
            )
        self.send_json({"id": card_id, **next_values})

    def list_deck_access(self, user, deck_id):
        if not self.require_deck_role(user, deck_id, "viewer"):
            self.send_error_json(HTTPStatus.FORBIDDEN, "Deck access required")
            return
        with connect() as db:
            rows = list(db.execute(
                """
                SELECT users.id, users.username, deck_access.role
                FROM deck_access
                JOIN users ON users.id = deck_access.user_id
                WHERE deck_access.deck_id = ?
                ORDER BY users.username
                """,
                (deck_id,),
            ))
        self.send_json(
            {"access": [{"userId": row["id"], "username": row["username"], "role": row["role"]} for row in rows]}
        )

    def grant_deck_access(self, user, deck_id):
        if not self.require_deck_role(user, deck_id, "owner"):
            self.send_error_json(HTTPStatus.FORBIDDEN, "Owner access required")
            return
        data = read_json(self)
        username = require_username(data)
        role = require_text(data, "role", 16)
        if role not in ROLE_ORDER:
            raise ValueError("role must be owner, editor, or viewer")
        with connect() as db:
            target = db.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
            if not target:
                self.send_error_json(HTTPStatus.NOT_FOUND, "User not found")
                return
            if target["id"] == user["id"] and role != "owner":
                self.send_error_json(HTTPStatus.BAD_REQUEST, "Owners cannot downgrade their own access")
                return
            db.execute(
                """
                INSERT INTO deck_access (deck_id, user_id, role, created_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(deck_id, user_id) DO UPDATE SET role = excluded.role
                """,
                (deck_id, target["id"], role, now_ms()),
            )
        self.send_json({"ok": True})

    def revoke_deck_access(self, user, deck_id, target_user_id):
        if not self.require_deck_role(user, deck_id, "owner"):
            self.send_error_json(HTTPStatus.FORBIDDEN, "Owner access required")
            return
        if target_user_id == user["id"]:
            self.send_error_json(HTTPStatus.BAD_REQUEST, "Owners cannot remove their own access")
            return
        with connect() as db:
            cursor = db.execute(
                "DELETE FROM deck_access WHERE deck_id = ? AND user_id = ?",
                (deck_id, target_user_id),
            )
            if cursor.rowcount == 0:
                self.send_error_json(HTTPStatus.NOT_FOUND, "Access entry not found")
                return
        self.send_json({"ok": True})

    def import_backup(self, user):
        data = read_json(self)
        decks = data.get("decks")
        if not isinstance(decks, list):
            raise ValueError("Backup must include a decks array")

        timestamp = now_ms()
        with connect() as db:
            imported_deck_ids = import_decks_for_user(db, user["id"], decks, timestamp)
        self.send_json({"ok": True, "deckIds": imported_deck_ids})

    def send_json(self, payload, status=HTTPStatus.OK):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, status, message):
        self.send_json({"error": message}, status)

    def log_message(self, format, *args):
        print("%s - %s" % (self.address_string(), format % args), flush=True)


if __name__ == "__main__":
    initialize_database()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), CardwellHandler)
    print(f"Cardwell listening on 0.0.0.0:{PORT}", flush=True)
    print(f"Initial admin username: {DEFAULT_ADMIN_USERNAME}", flush=True)
    server.serve_forever()
