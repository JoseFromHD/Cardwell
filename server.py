from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import sqlite3
import time
import uuid


APP_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("CARDWELL_DATA_DIR", APP_DIR / "data"))
DB_PATH = DATA_DIR / "cardwell.sqlite3"
PORT = int(os.environ.get("PORT", "8080"))


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


def initialize_database():
    with connect() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS decks (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              created_at INTEGER NOT NULL
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

            CREATE INDEX IF NOT EXISTS idx_cards_deck_id ON cards(deck_id);
            CREATE INDEX IF NOT EXISTS idx_cards_due_at ON cards(due_at);
            """
        )

        deck_count = db.execute("SELECT COUNT(*) AS count FROM decks").fetchone()["count"]
        if deck_count == 0:
            seed_deck_id = new_id()
            timestamp = now_ms()
            db.execute(
                "INSERT INTO decks (id, name, created_at) VALUES (?, ?, ?)",
                (seed_deck_id, "General Knowledge", timestamp),
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


def get_state():
    with connect() as db:
        decks = [
            {"id": row["id"], "name": row["name"], "cards": []}
            for row in db.execute("SELECT id, name FROM decks ORDER BY created_at, name")
        ]
        cards_by_deck = {deck["id"]: deck["cards"] for deck in decks}
        rows = db.execute(
            """
            SELECT id, deck_id, front, back, interval, ease, due_at, reviews
            FROM cards
            ORDER BY created_at DESC
            """
        )
        for row in rows:
            card = {
                "id": row["id"],
                "front": row["front"],
                "back": row["back"],
                "interval": row["interval"],
                "ease": row["ease"],
                "dueAt": row["due_at"],
                "reviews": row["reviews"],
            }
            cards_by_deck.get(row["deck_id"], []).append(card)
    return {"decks": decks}


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
    try:
        return json.loads(handler.rfile.read(length).decode("utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError("Request body must be valid JSON") from error


def require_text(data, key):
    value = data.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} is required")
    return value.strip()


class CardwellHandler(SimpleHTTPRequestHandler):
    server_version = "Cardwell/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP_DIR), **kwargs)

    def do_GET(self):
        if self.path == "/api/health":
            self.send_json({"ok": True})
            return
        if self.path == "/api/state":
            self.send_json(get_state())
            return
        if self.path == "/api/export":
            body = json.dumps(get_state(), indent=2).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Disposition", "attachment; filename=cardwell-backup.json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def do_POST(self):
        try:
            if self.path == "/api/decks":
                self.create_deck()
                return
            if self.path == "/api/import":
                self.import_backup()
                return
            match = re.fullmatch(r"/api/decks/([^/]+)/cards", self.path)
            if match:
                self.create_card(match.group(1))
                return
            match = re.fullmatch(r"/api/cards/([^/]+)/review", self.path)
            if match:
                self.review_card(match.group(1))
                return
            self.send_error(HTTPStatus.NOT_FOUND)
        except ValueError as error:
            self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)

    def do_PATCH(self):
        try:
            match = re.fullmatch(r"/api/decks/([^/]+)", self.path)
            if match:
                self.rename_deck(match.group(1))
                return
            match = re.fullmatch(r"/api/cards/([^/]+)", self.path)
            if match:
                self.update_card(match.group(1))
                return
            self.send_error(HTTPStatus.NOT_FOUND)
        except ValueError as error:
            self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)

    def do_DELETE(self):
        match = re.fullmatch(r"/api/decks/([^/]+)", self.path)
        if match:
            self.delete_deck(match.group(1))
            return
        match = re.fullmatch(r"/api/cards/([^/]+)", self.path)
        if match:
            self.delete_card(match.group(1))
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def create_deck(self):
        data = read_json(self)
        deck_id = new_id()
        name = require_text(data, "name")
        with connect() as db:
            db.execute(
                "INSERT INTO decks (id, name, created_at) VALUES (?, ?, ?)",
                (deck_id, name, now_ms()),
            )
        self.send_json({"id": deck_id, "name": name, "cards": []}, HTTPStatus.CREATED)

    def rename_deck(self, deck_id):
        data = read_json(self)
        name = require_text(data, "name")
        with connect() as db:
            cursor = db.execute("UPDATE decks SET name = ? WHERE id = ?", (name, deck_id))
            if cursor.rowcount == 0:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
        self.send_json({"id": deck_id, "name": name})

    def delete_deck(self, deck_id):
        with connect() as db:
            cursor = db.execute("DELETE FROM decks WHERE id = ?", (deck_id,))
            if cursor.rowcount == 0:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
        self.send_json({"ok": True})

    def create_card(self, deck_id):
        data = read_json(self)
        front = require_text(data, "front")
        back = require_text(data, "back")
        card_id = new_id()
        timestamp = now_ms()
        with connect() as db:
            deck = db.execute("SELECT id FROM decks WHERE id = ?", (deck_id,)).fetchone()
            if not deck:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            db.execute(
                """
                INSERT INTO cards
                  (id, deck_id, front, back, interval, ease, due_at, reviews, created_at)
                VALUES (?, ?, ?, ?, 0, 2.5, ?, 0, ?)
                """,
                (card_id, deck_id, front, back, timestamp, timestamp),
            )
        self.send_json({"id": card_id}, HTTPStatus.CREATED)

    def update_card(self, card_id):
        data = read_json(self)
        front = require_text(data, "front")
        back = require_text(data, "back")
        with connect() as db:
            cursor = db.execute(
                "UPDATE cards SET front = ?, back = ? WHERE id = ?",
                (front, back, card_id),
            )
            if cursor.rowcount == 0:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
        self.send_json({"id": card_id})

    def delete_card(self, card_id):
        with connect() as db:
            cursor = db.execute("DELETE FROM cards WHERE id = ?", (card_id,))
            if cursor.rowcount == 0:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
        self.send_json({"ok": True})

    def review_card(self, card_id):
        data = read_json(self)
        rating = require_text(data, "rating")
        with connect() as db:
            card = db.execute(
                "SELECT interval, ease, reviews FROM cards WHERE id = ?",
                (card_id,),
            ).fetchone()
            if not card:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            next_values = apply_rating(card, rating)
            db.execute(
                """
                UPDATE cards
                SET interval = ?, ease = ?, due_at = ?, reviews = ?
                WHERE id = ?
                """,
                (
                    next_values["interval"],
                    next_values["ease"],
                    next_values["due_at"],
                    next_values["reviews"],
                    card_id,
                ),
            )
        self.send_json({"id": card_id, **next_values})

    def import_backup(self):
        data = read_json(self)
        decks = data.get("decks")
        if not isinstance(decks, list):
            raise ValueError("Backup must include a decks array")

        timestamp = now_ms()
        with connect() as db:
            db.execute("DELETE FROM cards")
            db.execute("DELETE FROM decks")
            for deck in decks:
                deck_id = deck.get("id") if isinstance(deck.get("id"), str) else new_id()
                name = deck.get("name") if isinstance(deck.get("name"), str) else "Untitled deck"
                db.execute(
                    "INSERT INTO decks (id, name, created_at) VALUES (?, ?, ?)",
                    (deck_id, name.strip() or "Untitled deck", timestamp),
                )
                cards = deck.get("cards") if isinstance(deck.get("cards"), list) else []
                for card in cards:
                    card_id = card.get("id") if isinstance(card.get("id"), str) else new_id()
                    db.execute(
                        """
                        INSERT INTO cards
                          (id, deck_id, front, back, interval, ease, due_at, reviews, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            card_id,
                            deck_id,
                            str(card.get("front", "")).strip(),
                            str(card.get("back", "")).strip(),
                            int(card.get("interval", 0)),
                            float(card.get("ease", 2.5)),
                            int(card.get("dueAt", timestamp)),
                            int(card.get("reviews", 0)),
                            timestamp,
                        ),
                    )
        self.send_json({"ok": True})

    def send_json(self, payload, status=HTTPStatus.OK):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        print("%s - %s" % (self.address_string(), format % args), flush=True)


if __name__ == "__main__":
    initialize_database()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), CardwellHandler)
    print(f"Cardwell listening on 0.0.0.0:{PORT}", flush=True)
    server.serve_forever()
