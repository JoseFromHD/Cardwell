import tempfile
import unittest
from pathlib import Path

import server


class CardwellSecurityTests(unittest.TestCase):
    def setUp(self):
        self.originals = {
            "DATA_DIR": server.DATA_DIR,
            "DB_PATH": server.DB_PATH,
            "DEFAULT_ADMIN_USERNAME": server.DEFAULT_ADMIN_USERNAME,
            "DEFAULT_ADMIN_PASSWORD": server.DEFAULT_ADMIN_PASSWORD,
            "ALLOW_DEFAULT_ADMIN_PASSWORD": server.ALLOW_DEFAULT_ADMIN_PASSWORD,
            "PASSWORD_ITERATIONS": server.PASSWORD_ITERATIONS,
        }
        self.temp_dir = tempfile.TemporaryDirectory()
        data_dir = Path(self.temp_dir.name)
        server.DATA_DIR = data_dir
        server.DB_PATH = data_dir / "cardwell.sqlite3"
        server.DEFAULT_ADMIN_USERNAME = "admin"
        server.DEFAULT_ADMIN_PASSWORD = "unit-test-password"
        server.ALLOW_DEFAULT_ADMIN_PASSWORD = False
        server.FAILED_LOGIN_ATTEMPTS.clear()

    def tearDown(self):
        for key, value in self.originals.items():
            setattr(server, key, value)
        server.FAILED_LOGIN_ATTEMPTS.clear()
        self.temp_dir.cleanup()

    def test_first_start_refuses_unsafe_default_admin_password(self):
        server.DEFAULT_ADMIN_PASSWORD = server.UNSAFE_DEFAULT_ADMIN_PASSWORD

        with self.assertRaises(RuntimeError):
            server.initialize_database()

    def test_import_allocates_new_ids_and_does_not_grant_existing_deck_access(self):
        server.initialize_database()
        timestamp = server.now_ms()

        with server.connect() as db:
            attacker_id = server.new_id()
            db.execute(
                """
                INSERT INTO users (id, username, password_hash, is_admin, created_at)
                VALUES (?, ?, ?, 0, ?)
                """,
                (attacker_id, "attacker", server.hash_password("unit-test-password"), timestamp),
            )
            original_deck = db.execute("SELECT id FROM decks LIMIT 1").fetchone()
            original_card = db.execute(
                "SELECT id, front FROM cards WHERE deck_id = ? LIMIT 1",
                (original_deck["id"],),
            ).fetchone()

            imported_deck_ids = server.import_decks_for_user(
                db,
                attacker_id,
                [
                    {
                        "id": original_deck["id"],
                        "name": "Imported Copy",
                        "cards": [
                            {
                                "id": original_card["id"],
                                "front": "Tampered front",
                                "back": "Tampered back",
                                "interval": 3,
                                "ease": 2.4,
                                "dueAt": timestamp,
                                "reviews": 2,
                            }
                        ],
                    }
                ],
                timestamp,
            )

            self.assertEqual(len(imported_deck_ids), 1)
            self.assertNotEqual(imported_deck_ids[0], original_deck["id"])

            attacker_original_access = db.execute(
                "SELECT role FROM deck_access WHERE deck_id = ? AND user_id = ?",
                (original_deck["id"], attacker_id),
            ).fetchone()
            self.assertIsNone(attacker_original_access)

            unchanged_card = db.execute(
                "SELECT front FROM cards WHERE id = ?",
                (original_card["id"],),
            ).fetchone()
            self.assertEqual(unchanged_card["front"], original_card["front"])

            imported_card = db.execute(
                "SELECT id, front FROM cards WHERE deck_id = ?",
                (imported_deck_ids[0],),
            ).fetchone()
            self.assertIsNotNone(imported_card)
            self.assertNotEqual(imported_card["id"], original_card["id"])
            self.assertEqual(imported_card["front"], "Tampered front")

    def test_origin_check_rejects_cross_origin_requests(self):
        self.assertTrue(
            server.request_origin_is_allowed(
                {"Host": "cardwell.example", "Origin": "https://cardwell.example"}
            )
        )
        self.assertFalse(
            server.request_origin_is_allowed(
                {"Host": "cardwell.example", "Origin": "https://evil.example"}
            )
        )
        self.assertFalse(
            server.request_origin_is_allowed(
                {"Host": "cardwell.example", "Sec-Fetch-Site": "cross-site"}
            )
        )

    def test_password_rehash_helper_upgrades_older_work_factor(self):
        server.initialize_database()
        current_iterations = server.PASSWORD_ITERATIONS
        try:
            server.PASSWORD_ITERATIONS = 1_000
            old_hash = server.hash_password("unit-test-password")
        finally:
            server.PASSWORD_ITERATIONS = current_iterations

        self.assertTrue(server.password_needs_rehash(old_hash))

        with server.connect() as db:
            user = db.execute("SELECT id FROM users WHERE username = 'admin'").fetchone()
            db.execute(
                "UPDATE users SET password_hash = ? WHERE id = ?",
                (old_hash, user["id"]),
            )

            changed = server.refresh_password_hash_if_needed(
                db, user["id"], "unit-test-password", old_hash
            )
            stored = db.execute(
                "SELECT password_hash FROM users WHERE id = ?",
                (user["id"],),
            ).fetchone()

        self.assertTrue(changed)
        self.assertEqual(server.password_hash_iterations(stored["password_hash"]), current_iterations)
        self.assertTrue(server.verify_password("unit-test-password", stored["password_hash"]))

    def test_session_lookup_uses_hashed_database_ids(self):
        server.initialize_database()
        timestamp = server.now_ms()
        session_id = "raw-session-token"
        session_record_id = server.hash_session_id(session_id)

        with server.connect() as db:
            user = db.execute("SELECT id FROM users WHERE username = 'admin'").fetchone()
            db.execute(
                "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
                (session_record_id, user["id"], timestamp + 60_000, timestamp),
            )

        self.assertNotEqual(session_record_id, session_id)
        self.assertTrue(session_record_id.startswith("sha256$"))
        self.assertEqual(server.get_user_by_session(session_id)["username"], "admin")
        self.assertIsNone(server.get_user_by_session(session_record_id))

    def test_login_rate_limit_tracks_failed_attempts(self):
        for _ in range(server.LOGIN_MAX_ATTEMPTS):
            server.record_failed_login("admin", "127.0.0.1")

        self.assertTrue(server.login_is_rate_limited("admin", "127.0.0.1"))

        server.clear_failed_login("admin")
        self.assertTrue(server.login_is_rate_limited("admin", "127.0.0.1"))

    def test_reset_password_updates_hash_and_clears_other_sessions(self):
        server.initialize_database()
        timestamp = server.now_ms()

        with server.connect() as db:
            user = db.execute("SELECT id, username FROM users WHERE username = 'admin'").fetchone()
            db.execute(
                "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
                ("keep-session", user["id"], timestamp + 60_000, timestamp),
            )
            db.execute(
                "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
                ("drop-session", user["id"], timestamp + 60_000, timestamp),
            )
            server.record_failed_login(user["username"], "127.0.0.1")

            target = server.reset_password_for_user(db, user["id"], "new-unit-password", "keep-session")

            self.assertEqual(target["username"], user["username"])
            stored = db.execute("SELECT password_hash FROM users WHERE id = ?", (user["id"],)).fetchone()
            self.assertTrue(server.verify_password("new-unit-password", stored["password_hash"]))
            sessions = [
                row["id"]
                for row in db.execute("SELECT id FROM sessions WHERE user_id = ?", (user["id"],))
            ]
            self.assertEqual(sessions, ["keep-session"])
            self.assertNotIn(("user", user["username"].lower()), server.FAILED_LOGIN_ATTEMPTS)


if __name__ == "__main__":
    unittest.main()
