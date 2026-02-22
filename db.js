const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'hikes.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    display_name TEXT,
    kids_info TEXT,
    avatar_color TEXT,
    bio TEXT,
    emergency_contact TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS hikes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    trail TEXT NOT NULL,
    trail_id INTEGER REFERENCES trails(id),
    description TEXT,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    distance REAL,
    elevation INTEGER,
    duration TEXT,
    difficulty TEXT DEFAULT 'easy',
    meetup_location TEXT,
    tags TEXT DEFAULT '[]',
    created_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS rsvps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hike_id INTEGER NOT NULL REFERENCES hikes(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    status TEXT DEFAULT 'going',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(hike_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS carpool_offers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hike_id INTEGER NOT NULL REFERENCES hikes(id) ON DELETE CASCADE,
    driver_id INTEGER NOT NULL REFERENCES users(id),
    vehicle TEXT,
    total_seats INTEGER DEFAULT 4,
    pickup_location TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(hike_id, driver_id)
  );

  CREATE TABLE IF NOT EXISTS carpool_riders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    offer_id INTEGER NOT NULL REFERENCES carpool_offers(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(offer_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS trails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    location TEXT,
    distance REAL,
    elevation INTEGER,
    difficulty TEXT DEFAULT 'easy',
    description TEXT,
    tags TEXT DEFAULT '[]',
    lat REAL,
    lng REAL,
    trailhead_directions TEXT,
    seasonal_notes TEXT,
    elevation_profile TEXT,
    added_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS trail_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trail_id INTEGER NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    condition TEXT,
    rating REAL,
    notes TEXT,
    reported_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hike_id INTEGER REFERENCES hikes(id),
    trail_id INTEGER REFERENCES trails(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    caption TEXT,
    filename TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS hike_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    trail_id INTEGER REFERENCES trails(id),
    trail_name TEXT NOT NULL,
    date TEXT NOT NULL,
    distance REAL,
    elevation INTEGER,
    duration_minutes INTEGER,
    notes TEXT,
    rating REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Add columns if they don't exist (migration-safe)
try { db.exec('ALTER TABLE trails ADD COLUMN trailhead_directions TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE trails ADD COLUMN seasonal_notes TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE trails ADD COLUMN elevation_profile TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE hikes ADD COLUMN trail_id INTEGER REFERENCES trails(id)'); } catch(e) {}

module.exports = db;
