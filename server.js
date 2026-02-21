const express = require('express');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- Auth middleware (Cloudflare Access) ----
function getUser(req) {
  const email = req.headers['cf-access-authenticated-user-email'];
  if (!email) return null;

  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    const name = email.split('@')[0].replace(/[._-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const colors = ['#4a7c59','#c4956a','#5b9bd5','#b5577a','#8a7e6f','#e07c4f','#6ba368','#a48bdb'];
    const color = colors[Math.floor(Math.random() * colors.length)];
    const result = db.prepare('INSERT INTO users (email, display_name, avatar_color) VALUES (?, ?, ?)').run(email, name, color);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
  }
  return user;
}

function requireAuth(req, res, next) {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  req.user = user;
  next();
}

// ---- User routes ----
app.get('/api/me', requireAuth, (req, res) => {
  const hikeCount = db.prepare('SELECT COUNT(*) as count FROM rsvps WHERE user_id = ?').get(req.user.id).count;
  res.json({ ...req.user, hike_count: hikeCount });
});

app.put('/api/me', requireAuth, (req, res) => {
  const { display_name, kids_info, bio, emergency_contact } = req.body;
  db.prepare(`UPDATE users SET display_name = COALESCE(?, display_name), kids_info = COALESCE(?, kids_info),
    bio = COALESCE(?, bio), emergency_contact = COALESCE(?, emergency_contact), updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(display_name, kids_info, bio, emergency_contact, req.user.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json(user);
});

app.get('/api/members', requireAuth, (req, res) => {
  const members = db.prepare(`SELECT u.id, u.display_name, u.kids_info, u.avatar_color, u.bio,
    (SELECT COUNT(*) FROM rsvps WHERE user_id = u.id) as hike_count FROM users u ORDER BY hike_count DESC`).all();
  res.json(members);
});

// ---- Hike routes ----
app.get('/api/hikes', requireAuth, (req, res) => {
  const hikes = db.prepare(`SELECT h.*, u.display_name as creator_name FROM hikes h
    LEFT JOIN users u ON h.created_by = u.id ORDER BY h.date ASC`).all();

  const hikeIds = hikes.map(h => h.id);
  const rsvps = hikeIds.length ? db.prepare(`SELECT r.hike_id, r.status, u.id as user_id, u.display_name, u.avatar_color
    FROM rsvps r JOIN users u ON r.user_id = u.id WHERE r.hike_id IN (${hikeIds.map(() => '?').join(',')})`)
    .all(...hikeIds) : [];

  const rsvpMap = {};
  rsvps.forEach(r => {
    if (!rsvpMap[r.hike_id]) rsvpMap[r.hike_id] = [];
    rsvpMap[r.hike_id].push(r);
  });

  res.json(hikes.map(h => ({
    ...h,
    tags: JSON.parse(h.tags || '[]'),
    attendees: rsvpMap[h.id] || [],
    user_rsvp: (rsvpMap[h.id] || []).find(r => r.user_id === req.user.id)?.status || null
  })));
});

app.post('/api/hikes', requireAuth, (req, res) => {
  const { name, trail, description, date, time, distance, elevation, duration, difficulty, meetup_location, tags } = req.body;
  if (!name || !trail || !date || !time) return res.status(400).json({ error: 'name, trail, date, time required' });

  const result = db.prepare(`INSERT INTO hikes (name, trail, description, date, time, distance, elevation, duration, difficulty, meetup_location, tags, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(name, trail, description, date, time, distance, elevation, duration, difficulty || 'easy', meetup_location, JSON.stringify(tags || []), req.user.id);
  const hike = db.prepare('SELECT * FROM hikes WHERE id = ?').get(result.lastInsertRowid);
  res.json({ ...hike, tags: JSON.parse(hike.tags || '[]'), attendees: [], user_rsvp: null });
});

app.delete('/api/hikes/:id', requireAuth, (req, res) => {
  const hike = db.prepare('SELECT * FROM hikes WHERE id = ?').get(req.params.id);
  if (!hike) return res.status(404).json({ error: 'Not found' });
  if (hike.created_by !== req.user.id) return res.status(403).json({ error: 'Not your hike' });
  db.prepare('DELETE FROM hikes WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---- RSVP routes ----
app.post('/api/hikes/:id/rsvp', requireAuth, (req, res) => {
  const hikeId = parseInt(req.params.id);
  const existing = db.prepare('SELECT * FROM rsvps WHERE hike_id = ? AND user_id = ?').get(hikeId, req.user.id);

  if (existing) {
    db.prepare('DELETE FROM rsvps WHERE id = ?').run(existing.id);
    res.json({ status: null });
  } else {
    db.prepare('INSERT INTO rsvps (hike_id, user_id, status) VALUES (?, ?, ?)').run(hikeId, req.user.id, 'going');
    res.json({ status: 'going' });
  }
});

// ---- Carpool routes ----
app.get('/api/hikes/:id/carpool', requireAuth, (req, res) => {
  const hikeId = parseInt(req.params.id);
  const offers = db.prepare(`SELECT co.*, u.display_name as driver_name, u.avatar_color as driver_color
    FROM carpool_offers co JOIN users u ON co.driver_id = u.id WHERE co.hike_id = ?`).all(hikeId);

  const offerIds = offers.map(o => o.id);
  const riders = offerIds.length ? db.prepare(`SELECT cr.offer_id, u.id as user_id, u.display_name
    FROM carpool_riders cr JOIN users u ON cr.user_id = u.id WHERE cr.offer_id IN (${offerIds.map(() => '?').join(',')})`)
    .all(...offerIds) : [];

  const riderMap = {};
  riders.forEach(r => {
    if (!riderMap[r.offer_id]) riderMap[r.offer_id] = [];
    riderMap[r.offer_id].push(r);
  });

  res.json(offers.map(o => ({
    ...o,
    riders: riderMap[o.id] || [],
    seats_taken: (riderMap[o.id] || []).length,
    user_riding: (riderMap[o.id] || []).some(r => r.user_id === req.user.id)
  })));
});

app.post('/api/hikes/:id/carpool', requireAuth, (req, res) => {
  const { vehicle, total_seats, pickup_location, notes } = req.body;
  const hikeId = parseInt(req.params.id);

  try {
    db.prepare('INSERT INTO carpool_offers (hike_id, driver_id, vehicle, total_seats, pickup_location, notes) VALUES (?, ?, ?, ?, ?, ?)')
      .run(hikeId, req.user.id, vehicle, total_seats || 4, pickup_location, notes);
    res.json({ ok: true });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Already offering a ride' });
    throw e;
  }
});

app.post('/api/carpool/:offerId/join', requireAuth, (req, res) => {
  const offerId = parseInt(req.params.offerId);
  const offer = db.prepare('SELECT * FROM carpool_offers WHERE id = ?').get(offerId);
  if (!offer) return res.status(404).json({ error: 'Offer not found' });

  const riderCount = db.prepare('SELECT COUNT(*) as count FROM carpool_riders WHERE offer_id = ?').get(offerId).count;
  if (riderCount >= offer.total_seats) return res.status(400).json({ error: 'No seats available' });

  const existing = db.prepare('SELECT * FROM carpool_riders WHERE offer_id = ? AND user_id = ?').get(offerId, req.user.id);
  if (existing) {
    db.prepare('DELETE FROM carpool_riders WHERE id = ?').run(existing.id);
    res.json({ riding: false });
  } else {
    db.prepare('INSERT INTO carpool_riders (offer_id, user_id) VALUES (?, ?)').run(offerId, req.user.id);
    res.json({ riding: true });
  }
});

// ---- Trail routes ----
app.get('/api/trails', requireAuth, (req, res) => {
  const trails = db.prepare(`SELECT t.*,
    (SELECT AVG(rating) FROM trail_reports WHERE trail_id = t.id) as avg_rating,
    (SELECT COUNT(*) FROM trail_reports WHERE trail_id = t.id) as report_count
    FROM trails t ORDER BY avg_rating DESC NULLS LAST`).all();
  res.json(trails.map(t => ({ ...t, tags: JSON.parse(t.tags || '[]') })));
});

app.post('/api/trails', requireAuth, (req, res) => {
  const { name, location, distance, elevation, difficulty, description, tags, lat, lng } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  const result = db.prepare(`INSERT INTO trails (name, location, distance, elevation, difficulty, description, tags, lat, lng, added_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(name, location, distance, elevation, difficulty || 'easy', description, JSON.stringify(tags || []), lat, lng, req.user.id);
  const trail = db.prepare('SELECT * FROM trails WHERE id = ?').get(result.lastInsertRowid);
  res.json({ ...trail, tags: JSON.parse(trail.tags || '[]') });
});

// ---- Trail reports ----
app.post('/api/trails/:id/report', requireAuth, (req, res) => {
  const { condition, rating, notes } = req.body;
  db.prepare('INSERT INTO trail_reports (trail_id, user_id, condition, rating, notes) VALUES (?, ?, ?, ?, ?)')
    .run(req.params.id, req.user.id, condition, rating, notes);
  res.json({ ok: true });
});

app.get('/api/trails/:id/reports', requireAuth, (req, res) => {
  const reports = db.prepare(`SELECT tr.*, u.display_name, u.avatar_color FROM trail_reports tr
    JOIN users u ON tr.user_id = u.id WHERE tr.trail_id = ? ORDER BY tr.reported_at DESC LIMIT 20`).all(req.params.id);
  res.json(reports);
});

// ---- Seed data (run once) ----
function seedIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) as count FROM trails').get().count;
  if (count > 0) return;

  const trails = [
    { name: "Rattlesnake Creek Trail", location: "Rattlesnake NRA", distance: 4.2, elevation: 450, difficulty: "easy", tags: ["kid","dog"], description: "Gentle creek-side trail with lots of water crossings." },
    { name: "Blue Mountain Lookout", location: "Blue Mountain Rec Area", distance: 6.1, elevation: 1200, difficulty: "moderate", tags: ["dog"], description: "Fire lookout tower with panoramic Bitterroot views." },
    { name: "Kim Williams Nature Trail", location: "South Hills", distance: 5.6, elevation: 120, difficulty: "easy", tags: ["kid","stroller","dog"], description: "Paved riverside trail. Perfect for strollers and bikes." },
    { name: "Pattee Canyon Overlook", location: "Pattee Canyon", distance: 5.5, elevation: 900, difficulty: "moderate", tags: ["dog"], description: "Forest trail with excellent viewpoints." },
    { name: "Waterworks Hill", location: "North Hills", distance: 2.4, elevation: 500, difficulty: "easy", tags: ["kid","dog"], description: "Quick city overlook hike. Great for sunset." },
    { name: "Mount Sentinel - M Trail", location: "University Area", distance: 1.6, elevation: 620, difficulty: "moderate", tags: [], description: "Iconic Missoula hike to the M. Steep but short." },
    { name: "Stuart Peak", location: "Rattlesnake Wilderness", distance: 12.0, elevation: 3200, difficulty: "hard", tags: ["dog"], description: "Full-day wilderness adventure. Breathtaking alpine." },
    { name: "Maclay Flat Nature Trail", location: "Maclay Flat", distance: 1.5, elevation: 50, difficulty: "easy", tags: ["kid","stroller","dog"], description: "Flat riverfront loop. Sand beach access in summer." },
    { name: "Crazy Canyon", location: "Pattee Canyon", distance: 3.8, elevation: 700, difficulty: "moderate", tags: ["dog"], description: "Quiet canyon trail with old-growth forest." },
  ];

  const insertTrail = db.prepare('INSERT INTO trails (name, location, distance, elevation, difficulty, tags, description) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const seed = db.transaction(() => {
    trails.forEach(t => insertTrail.run(t.name, t.location, t.distance, t.elevation, t.difficulty, JSON.stringify(t.tags), t.description));
  });
  seed();

  // Seed a few upcoming hikes
  const hikes = [
    { name: "Rattlesnake Creek Loop", trail: "Rattlesnake NRA", description: "Beautiful creek-side trail. Perfect for littles!", date: "2026-02-24", time: "9:00 AM", distance: 4.2, elevation: 450, duration: "2.5 hrs", difficulty: "easy", meetup_location: "Rattlesnake Trailhead parking", tags: ["kid","dog"] },
    { name: "Blue Mountain Lookout", trail: "Blue Mountain Recreation Area", description: "Stunning valley views from the lookout tower.", date: "2026-03-01", time: "9:30 AM", distance: 6.1, elevation: 1200, duration: "3.5 hrs", difficulty: "moderate", meetup_location: "Blue Mountain Trailhead", tags: ["dog","carpool"] },
    { name: "Kim Williams Stroller Walk", trail: "Kim Williams Trail", description: "Flat paved trail along the river. Stroller-friendly!", date: "2026-03-05", time: "10:00 AM", distance: 2.8, elevation: 120, duration: "1.5 hrs", difficulty: "easy", meetup_location: "Caras Park", tags: ["kid","stroller"] },
  ];

  const insertHike = db.prepare('INSERT INTO hikes (name, trail, description, date, time, distance, elevation, duration, difficulty, meetup_location, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const seedHikes = db.transaction(() => {
    hikes.forEach(h => insertHike.run(h.name, h.trail, h.description, h.date, h.time, h.distance, h.elevation, h.duration, h.difficulty, h.meetup_location, JSON.stringify(h.tags)));
  });
  seedHikes();

  console.log('Seeded database with trails and hikes');
}

seedIfEmpty();

// Serve the SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Missoula Trail Moms running on :${PORT}`));
