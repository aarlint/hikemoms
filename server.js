const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Setup multer for photo uploads
const multer = require('multer');
const UPLOAD_DIR = path.join(process.env.DATA_PATH || path.join(__dirname, 'data'), 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2,8)}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: (req, file, cb) => {
  if (/^image\/(jpeg|png|gif|webp|heic)$/i.test(file.mimetype)) cb(null, true);
  else cb(new Error('Only images allowed'));
}});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

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
    (SELECT COUNT(*) FROM rsvps WHERE user_id = u.id) as hike_count,
    (SELECT COALESCE(SUM(distance), 0) FROM hike_log WHERE user_id = u.id) as total_miles,
    (SELECT COALESCE(SUM(elevation), 0) FROM hike_log WHERE user_id = u.id) as total_elevation,
    (SELECT COUNT(*) FROM hike_log WHERE user_id = u.id) as logged_hikes
    FROM users u ORDER BY logged_hikes DESC, hike_count DESC`).all();
  res.json(members);
});

app.get('/api/members/:id', requireAuth, (req, res) => {
  const member = db.prepare(`SELECT u.id, u.display_name, u.kids_info, u.avatar_color, u.bio,
    (SELECT COUNT(*) FROM rsvps WHERE user_id = u.id) as hike_count,
    (SELECT COALESCE(SUM(distance), 0) FROM hike_log WHERE user_id = u.id) as total_miles,
    (SELECT COALESCE(SUM(elevation), 0) FROM hike_log WHERE user_id = u.id) as total_elevation,
    (SELECT COUNT(*) FROM hike_log WHERE user_id = u.id) as logged_hikes
    FROM users u WHERE u.id = ?`).get(req.params.id);
  if (!member) return res.status(404).json({ error: 'Not found' });
  const logs = db.prepare('SELECT * FROM hike_log WHERE user_id = ? ORDER BY date DESC LIMIT 20').all(req.params.id);
  res.json({ ...member, recent_hikes: logs });
});

// ---- Personal stats ----
app.get('/api/me/stats', requireAuth, (req, res) => {
  const userId = req.user.id;
  const total = db.prepare(`SELECT COUNT(*) as hikes, COALESCE(SUM(distance),0) as miles,
    COALESCE(SUM(elevation),0) as elevation FROM hike_log WHERE user_id = ?`).get(userId);

  const thisMonth = db.prepare(`SELECT COUNT(*) as hikes, COALESCE(SUM(distance),0) as miles,
    COALESCE(SUM(elevation),0) as elevation FROM hike_log WHERE user_id = ? AND date >= date('now','start of month')`).get(userId);

  const favTrail = db.prepare(`SELECT trail_name, COUNT(*) as cnt FROM hike_log WHERE user_id = ? GROUP BY trail_name ORDER BY cnt DESC LIMIT 1`).get(userId);

  // Calculate streak
  const dates = db.prepare('SELECT DISTINCT date FROM hike_log WHERE user_id = ? ORDER BY date DESC').all(userId).map(r => r.date);
  let streak = 0;
  if (dates.length > 0) {
    let d = new Date();
    d.setHours(0,0,0,0);
    // Check if hiked today or yesterday
    const today = d.toISOString().slice(0,10);
    const yesterday = new Date(d - 86400000).toISOString().slice(0,10);
    if (dates[0] === today || dates[0] === yesterday) {
      streak = 1;
      let prev = new Date(dates[0]);
      for (let i = 1; i < dates.length; i++) {
        const expected = new Date(prev - 86400000).toISOString().slice(0,10);
        if (dates[i] === expected) { streak++; prev = new Date(dates[i]); }
        else break;
      }
    }
  }

  // Streak in weeks (hiked at least once per week)
  let weekStreak = 0;
  if (dates.length > 0) {
    const now = new Date();
    const getWeek = (d) => { const dt = new Date(d); const start = new Date(dt.getFullYear(), 0, 1); return Math.ceil(((dt - start) / 86400000 + start.getDay() + 1) / 7); };
    const thisWeek = getWeek(now);
    const thisYear = now.getFullYear();
    // Simple week streak
    let checkWeek = thisWeek;
    let checkYear = thisYear;
    for (let w = 0; w < 52; w++) {
      const found = dates.some(d => {
        const dt = new Date(d + 'T00:00:00');
        return getWeek(dt) === checkWeek && dt.getFullYear() === checkYear;
      });
      if (found) { weekStreak++; checkWeek--; if (checkWeek < 1) { checkWeek = 52; checkYear--; } }
      else break;
    }
  }

  res.json({
    total_hikes: total.hikes,
    total_miles: Math.round(total.miles * 10) / 10,
    total_elevation: total.elevation,
    month_hikes: thisMonth.hikes,
    month_miles: Math.round(thisMonth.miles * 10) / 10,
    month_elevation: thisMonth.elevation,
    favorite_trail: favTrail?.trail_name || null,
    day_streak: streak,
    week_streak: weekStreak
  });
});

// ---- Hike log ----
app.get('/api/hike-log', requireAuth, (req, res) => {
  const logs = db.prepare('SELECT * FROM hike_log WHERE user_id = ? ORDER BY date DESC').all(req.user.id);
  res.json(logs);
});

app.post('/api/hike-log', requireAuth, (req, res) => {
  const { trail_id, trail_name, date, distance, elevation, duration_minutes, notes, rating } = req.body;
  if (!trail_name || !date) return res.status(400).json({ error: 'trail_name and date required' });
  const result = db.prepare(`INSERT INTO hike_log (user_id, trail_id, trail_name, date, distance, elevation, duration_minutes, notes, rating)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.user.id, trail_id || null, trail_name, date, distance || 0, elevation || 0, duration_minutes || null, notes || null, rating || null);
  const log = db.prepare('SELECT * FROM hike_log WHERE id = ?').get(result.lastInsertRowid);
  res.json(log);
});

app.delete('/api/hike-log/:id', requireAuth, (req, res) => {
  const log = db.prepare('SELECT * FROM hike_log WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!log) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM hike_log WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---- Leaderboard ----
app.get('/api/leaderboard', requireAuth, (req, res) => {
  const period = req.query.period || 'all'; // all, month, year
  let dateFilter = '';
  if (period === 'month') dateFilter = "AND date >= date('now','start of month')";
  else if (period === 'year') dateFilter = "AND date >= date('now','start of year')";

  const leaders = db.prepare(`SELECT u.id, u.display_name, u.avatar_color,
    COUNT(*) as hikes, COALESCE(SUM(hl.distance),0) as miles, COALESCE(SUM(hl.elevation),0) as elevation
    FROM hike_log hl JOIN users u ON hl.user_id = u.id WHERE 1=1 ${dateFilter}
    GROUP BY u.id ORDER BY miles DESC LIMIT 20`).all();
  res.json(leaders);
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

app.get('/api/hikes/:id', requireAuth, (req, res) => {
  const hike = db.prepare(`SELECT h.*, u.display_name as creator_name FROM hikes h
    LEFT JOIN users u ON h.created_by = u.id WHERE h.id = ?`).get(req.params.id);
  if (!hike) return res.status(404).json({ error: 'Not found' });

  const attendees = db.prepare(`SELECT u.id, u.display_name, u.avatar_color, r.status
    FROM rsvps r JOIN users u ON r.user_id = u.id WHERE r.hike_id = ?`).all(hike.id);

  const carpools = db.prepare(`SELECT co.*, u.display_name as driver_name, u.avatar_color as driver_color
    FROM carpool_offers co JOIN users u ON co.driver_id = u.id WHERE co.hike_id = ?`).all(hike.id);

  res.json({
    ...hike,
    tags: JSON.parse(hike.tags || '[]'),
    attendees,
    carpools,
    user_rsvp: attendees.find(a => a.id === req.user.id)?.status || null
  });
});

app.post('/api/hikes', requireAuth, (req, res) => {
  const { name, trail, trail_id, description, date, time, distance, elevation, duration, difficulty, meetup_location, tags } = req.body;
  if (!name || !trail || !date || !time) return res.status(400).json({ error: 'name, trail, date, time required' });

  const result = db.prepare(`INSERT INTO hikes (name, trail, trail_id, description, date, time, distance, elevation, duration, difficulty, meetup_location, tags, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(name, trail, trail_id || null, description, date, time, distance, elevation, duration, difficulty || 'easy', meetup_location, JSON.stringify(tags || []), req.user.id);
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
    (SELECT COUNT(*) FROM trail_reports WHERE trail_id = t.id) as report_count,
    (SELECT condition FROM trail_reports WHERE trail_id = t.id ORDER BY reported_at DESC LIMIT 1) as latest_condition,
    (SELECT reported_at FROM trail_reports WHERE trail_id = t.id ORDER BY reported_at DESC LIMIT 1) as latest_report_date
    FROM trails t ORDER BY t.name ASC`).all();
  res.json(trails.map(t => ({ ...t, tags: JSON.parse(t.tags || '[]') })));
});

app.get('/api/trails/:id', requireAuth, (req, res) => {
  const trail = db.prepare(`SELECT t.*,
    (SELECT AVG(rating) FROM trail_reports WHERE trail_id = t.id) as avg_rating,
    (SELECT COUNT(*) FROM trail_reports WHERE trail_id = t.id) as report_count,
    (SELECT condition FROM trail_reports WHERE trail_id = t.id ORDER BY reported_at DESC LIMIT 1) as latest_condition,
    (SELECT reported_at FROM trail_reports WHERE trail_id = t.id ORDER BY reported_at DESC LIMIT 1) as latest_report_date
    FROM trails t WHERE t.id = ?`).get(req.params.id);
  if (!trail) return res.status(404).json({ error: 'Not found' });

  const reports = db.prepare(`SELECT tr.*, u.display_name, u.avatar_color FROM trail_reports tr
    JOIN users u ON tr.user_id = u.id WHERE tr.trail_id = ? ORDER BY tr.reported_at DESC LIMIT 10`).all(req.params.id);

  const photos = db.prepare(`SELECT p.*, u.display_name FROM photos p
    JOIN users u ON p.user_id = u.id WHERE p.trail_id = ? ORDER BY p.created_at DESC LIMIT 20`).all(req.params.id);

  res.json({ ...trail, tags: JSON.parse(trail.tags || '[]'), reports, photos });
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

// ---- Photo upload ----
app.post('/api/photos', requireAuth, upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { trail_id, hike_id, caption } = req.body;
  const result = db.prepare('INSERT INTO photos (trail_id, hike_id, user_id, caption, filename) VALUES (?, ?, ?, ?, ?)')
    .run(trail_id || null, hike_id || null, req.user.id, caption || null, req.file.filename);
  const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get(result.lastInsertRowid);
  res.json(photo);
});

app.get('/api/photos', requireAuth, (req, res) => {
  const { trail_id, hike_id } = req.query;
  let query = 'SELECT p.*, u.display_name FROM photos p JOIN users u ON p.user_id = u.id';
  const params = [];
  if (trail_id) { query += ' WHERE p.trail_id = ?'; params.push(trail_id); }
  else if (hike_id) { query += ' WHERE p.hike_id = ?'; params.push(hike_id); }
  query += ' ORDER BY p.created_at DESC LIMIT 50';
  res.json(db.prepare(query).all(...params));
});

// ---- Seed data (run once) ----
function seedIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) as count FROM trails').get().count;
  if (count > 0) return;

  const trails = [
    {
      name: "Rattlesnake Creek Trail",
      location: "Rattlesnake National Recreation Area",
      distance: 4.0,
      elevation: 400,
      difficulty: "easy",
      tags: ["kid","dog"],
      description: "A gorgeous out-and-back trail following Rattlesnake Creek through a forested valley. The wide, mostly flat path winds alongside the clear creek with multiple access points for water play. Wildflowers bloom along the trail in spring and summer. The gentle grade makes this ideal for families with young children. Watch for deer, osprey, and the occasional moose.",
      lat: 46.9287,
      lng: -113.9817,
      trailhead_directions: "From I-90, take the Van Buren St exit north. Continue on Rattlesnake Dr for about 4 miles to the main trailhead parking area at the gate.",
      seasonal_notes: "Best May–October. Trail can be muddy in spring. Snow-packed December–March but great for snowshoeing. Creek crossings may be impassable during peak spring runoff (late May/early June).",
      elevation_profile: "Gentle, steady climb along the creek valley. Mostly flat with gradual 2-3% grade."
    },
    {
      name: "Blue Mountain Nature Trail",
      location: "Blue Mountain Recreation Area",
      distance: 2.6,
      elevation: 750,
      difficulty: "moderate",
      tags: ["dog"],
      description: "A popular loop trail climbing through Douglas fir and ponderosa pine forest to the Blue Mountain fire lookout. The lookout tower offers spectacular 360-degree views of the Bitterroot Valley, Missoula, and the surrounding mountain ranges. Multiple trail options allow you to extend or shorten the hike.",
      lat: 46.8347,
      lng: -114.1233,
      trailhead_directions: "From Missoula, head south on US-93. Turn right on Blue Mountain Rd and follow signs to the recreation area. Trailhead parking is well-marked.",
      seasonal_notes: "Accessible year-round. Can be icy in winter — bring traction devices. Wildflowers peak in June. Hot and exposed on south-facing slopes in summer; go early. Lookout tower typically staffed June–September.",
      elevation_profile: "Steady climb from trailhead with a few steep switchbacks in the middle. Final push to lookout is moderate."
    },
    {
      name: "Kim Williams Nature Trail",
      location: "Kim Williams Nature Area / Clark Fork River",
      distance: 5.6,
      elevation: 120,
      difficulty: "easy",
      tags: ["kid","stroller","dog"],
      description: "A beloved paved multi-use path following the Clark Fork River and an old railroad grade. This is Missoula's most accessible trail — flat, wide, and perfect for strollers, bikes, and wheelchairs. It connects to the larger Missoula trail system and runs from Higgins Ave to the base of Mount Sentinel. Great bird watching along the river.",
      lat: 46.8559,
      lng: -113.9856,
      trailhead_directions: "Access from Caras Park downtown, the Van Buren St footbridge, or the Higgins Ave bridge. Parking available at Caras Park or the UM campus.",
      seasonal_notes: "Year-round trail. Plowed in winter for walking/running. Occasionally floods briefly during high water in spring. Shaded portions make it comfortable in summer heat.",
      elevation_profile: "Virtually flat along the old Milwaukee Railroad grade. Slight rise only at the eastern end approaching Hellgate Canyon."
    },
    {
      name: "Pattee Canyon Recreation Area",
      location: "Pattee Canyon",
      distance: 5.5,
      elevation: 950,
      difficulty: "moderate",
      tags: ["dog"],
      description: "A network of forested trails in the hills just southeast of Missoula. The main loop climbs through mixed conifer forest to overlooks with views of the Missoula Valley. Well-maintained trails with good signage. Popular with mountain bikers on weekdays, so stay alert. Picnic area and restrooms at the trailhead.",
      lat: 46.8425,
      lng: -113.9342,
      trailhead_directions: "From Higgins Ave, head south and turn left on Pattee Canyon Dr. Follow it about 3.5 miles to the recreation area parking lot.",
      seasonal_notes: "Best April–November. Cross-country ski trails in winter (groomed). Muddy during spring thaw — typically mid-March through April. Excellent fall colors in October.",
      elevation_profile: "Moderate, steady climb from the picnic area with rolling terrain on the ridge. A few steeper sections on the upper loop."
    },
    {
      name: "Waterworks Hill",
      location: "North Hills / Waterworks Hill",
      distance: 2.0,
      elevation: 500,
      difficulty: "easy",
      tags: ["kid","dog"],
      description: "A short but rewarding climb to one of Missoula's best viewpoints. Open grassland hillside with panoramic views of the entire Missoula Valley, the Clark Fork River, and surrounding mountains. Wildflowers carpet the hillside in spring. Popular sunset spot. Dogs love the wide-open space.",
      lat: 46.8880,
      lng: -114.0020,
      trailhead_directions: "Park along Cherry St or at the small pullout on the north end of Orange St. The trail starts at the obvious hill north of downtown.",
      seasonal_notes: "Year-round access. Very exposed — bring sun protection in summer and wind layers in winter. Snow melts early due to south-facing slope. Gorgeous in May when balsamroot blankets the hillside.",
      elevation_profile: "Short, moderately steep climb from the base. Gets steeper in the middle third, then levels out along the ridge."
    },
    {
      name: "Mount Sentinel – M Trail",
      location: "University of Montana / Mount Sentinel",
      distance: 1.5,
      elevation: 620,
      difficulty: "moderate",
      tags: [],
      description: "The iconic hike to the concrete 'M' on Mount Sentinel, visible from all over Missoula. Eleven switchbacks climb steeply through grassland with improving views at every turn. At the M (elevation 4,768 ft), enjoy sweeping views of Missoula, Hellgate Canyon, and the Bitterroot Mountains. Continue past the M to the summit for a longer adventure.",
      lat: 46.8529,
      lng: -113.9753,
      trailhead_directions: "Park at the University of Montana campus near the trailhead at the east end of Campus Drive. Limited parking; consider biking or walking from campus.",
      seasonal_notes: "Year-round. Very icy in winter — traction devices essential. Hot and exposed in summer; go early morning or evening. Closed intermittently in spring for elk calving (typically April–May). The M is whitewashed by freshmen each fall.",
      elevation_profile: "Relentless steep switchbacks gaining 620 ft in just 0.75 miles. No flat sections until the M. Quad burner!"
    },
    {
      name: "Maclay Flat Nature Trail",
      location: "Maclay Flat Recreation Area",
      distance: 1.5,
      elevation: 50,
      difficulty: "easy",
      tags: ["kid","stroller","dog"],
      description: "A gentle, mostly flat loop through cottonwood forest along the Bitterroot River. Sandy beach access for wading in summer. Bird watching is excellent — look for great blue herons, bald eagles, and songbirds. The wide gravel path is stroller-friendly. A perfect first hike for toddlers and babies.",
      lat: 46.8186,
      lng: -114.0825,
      trailhead_directions: "From Missoula, take US-93 south to Blue Mountain Rd, then turn right on Maclay Flat Rd. Well-signed parking area.",
      seasonal_notes: "Year-round. River beach is best July–September when water warms up. Spring flooding can submerge low sections of trail. Mosquitoes can be thick June–July near the river.",
      elevation_profile: "Essentially flat loop with only minor undulations along the riverbank."
    },
    {
      name: "Crazy Canyon Trail",
      location: "Pattee Canyon / Crazy Canyon",
      distance: 3.8,
      elevation: 700,
      difficulty: "moderate",
      tags: ["dog"],
      description: "A quiet, less-traveled canyon trail through old-growth Douglas fir forest. The trail follows a small creek through a narrow canyon with lush understory. Feels wilder and more remote than other Missoula trails despite being close to town. Good chance of spotting wildlife including deer, wild turkeys, and woodpeckers.",
      lat: 46.8380,
      lng: -113.9250,
      trailhead_directions: "Access from the Pattee Canyon Recreation Area. Take the Crazy Canyon Trail junction about 0.5 miles from the main trailhead.",
      seasonal_notes: "Best May–October. Trail can be overgrown in late summer. Snow lingers in the canyon through April. Cooler temps in the canyon make it a good summer option.",
      elevation_profile: "Moderate climb up the canyon with some steeper pitches. Rolling terrain with creek crossings."
    },
    {
      name: "Stuart Peak",
      location: "Rattlesnake Wilderness",
      distance: 11.0,
      elevation: 3400,
      difficulty: "hard",
      tags: ["dog"],
      description: "A challenging full-day hike to the highest peak in the Rattlesnake Wilderness (7,960 ft). The trail climbs through dense forest, alpine meadows, and finally rocky terrain above treeline. Stunning views of the Mission Mountains, Flathead Reservation, and Glacier Park on clear days. Bring plenty of water and start early.",
      lat: 47.0120,
      lng: -113.8680,
      trailhead_directions: "Start from the Rattlesnake main trailhead. Follow the Rattlesnake Creek Trail north, then take the Stuart Peak spur trail at approximately mile 4.",
      seasonal_notes: "Summit accessible July–September only. Snow on upper portions through June. Afternoon thunderstorms common in July–August — plan to be off the summit by noon. No water above treeline.",
      elevation_profile: "Gradual first 4 miles along the creek, then steep sustained climb gaining 2,800 ft in the final 3 miles to the summit."
    },
    {
      name: "Clark Fork Riverfront Trail",
      location: "Downtown Missoula / Clark Fork River",
      distance: 3.5,
      elevation: 50,
      difficulty: "easy",
      tags: ["kid","stroller","dog"],
      description: "Missoula's urban trail along the Clark Fork River connecting parks, bridges, and public art. Paved and flat, this trail passes Caras Park, Brennan's Wave (a surfing wave!), and multiple pedestrian bridges. Great for an evening walk, morning jog, or weekend family stroll. Food trucks and events at Caras Park in summer.",
      lat: 46.8693,
      lng: -114.0050,
      trailhead_directions: "Multiple access points downtown. Caras Park (near Higgins Ave bridge), McCormick Park, or Kiwanis Park all have parking.",
      seasonal_notes: "Year-round, paved and maintained. Plowed in winter. Busiest on summer evenings and during events like Out to Lunch and Downtown Tonight. Watch the surfers at Brennan's Wave!",
      elevation_profile: "Flat riverside path with no significant elevation change."
    },
    {
      name: "Mount Jumbo – L Trail",
      location: "Mount Jumbo / East Missoula",
      distance: 3.0,
      elevation: 850,
      difficulty: "moderate",
      tags: ["dog"],
      description: "A scenic trail climbing the south face of Mount Jumbo to the large 'L' (for Loyola High School). Similar vibe to the M Trail but less crowded. Grassland hillside with views of Hellgate Canyon, the Blackfoot Valley, and Missoula. Elk are frequently spotted on Jumbo, especially in winter.",
      lat: 46.8780,
      lng: -113.9610,
      trailhead_directions: "Access from the east end of East Broadway near the Lincoln Hills trailhead. Park along the residential streets or at the small trailhead lot.",
      seasonal_notes: "CLOSED December 1 – March 14 annually for elk winter range protection. Open the rest of the year. Very hot and exposed in summer. Best in spring and fall.",
      elevation_profile: "Steady climb on switchbacks up the south face. Moderate to steep grade throughout."
    },
    {
      name: "Lolo Peak",
      location: "Lolo National Forest / Bitterroot Range",
      distance: 8.0,
      elevation: 3200,
      difficulty: "hard",
      tags: [],
      description: "A strenuous climb to one of the most prominent peaks visible from Missoula (9,096 ft). The trail ascends through forest, meadows, and eventually rocky alpine terrain. Panoramic summit views span from the Bitterroot Range to the Mission Mountains. This is a serious hike requiring good fitness and preparation.",
      lat: 46.7500,
      lng: -114.0800,
      trailhead_directions: "From Missoula, take US-12 west to Lolo. Turn south on US-93, then take Mormon Creek Rd (FR 612) to the trailhead. High-clearance vehicle recommended for the last mile.",
      seasonal_notes: "Summit accessible late June through September. Snow on upper portions into July. Start before dawn to avoid afternoon lightning. Carry extra water — limited sources above mile 4.",
      elevation_profile: "Relentless climb from start. First 3 miles through forest are moderate, then very steep above treeline with some scrambling near the summit."
    },
    {
      name: "Greenough Park",
      location: "Rattlesnake / Greenough Park",
      distance: 1.2,
      elevation: 80,
      difficulty: "easy",
      tags: ["kid","stroller","dog"],
      description: "A charming loop through Missoula's beloved in-town park along Rattlesnake Creek. Towering ponderosa pines, a babbling creek, and well-maintained paths make this perfect for young families. Kids love throwing rocks in the creek and spotting squirrels. Connected to the larger Rattlesnake trail system.",
      lat: 46.8830,
      lng: -113.9880,
      trailhead_directions: "Located at the intersection of Monroe St and Greenough Dr in central Missoula. Street parking available along Monroe St and Locust St.",
      seasonal_notes: "Year-round. Paths can be icy in winter. Creek is fun for wading in summer. Beautiful fall colors from the cottonwoods in October.",
      elevation_profile: "Nearly flat loop along the creek. Gentle as it gets."
    },
    {
      name: "Sentinel Meadows – East Ridge",
      location: "Mount Sentinel / South Hills",
      distance: 6.0,
      elevation: 1800,
      difficulty: "moderate",
      tags: ["dog"],
      description: "An extension beyond the M Trail continuing up Mount Sentinel's ridge through rolling meadows with expansive views. Once past the M, the crowds thin dramatically. The meadows are spectacular with wildflowers in June. Look for raptors soaring on thermals and elk in the early morning.",
      lat: 46.8470,
      lng: -113.9600,
      trailhead_directions: "Same as M Trail — start from the University of Montana campus trailhead. Continue past the M on the obvious ridge trail.",
      seasonal_notes: "Best May–October. Upper portions can be snow-covered into May. Hot and exposed in summer. No water on the ridge — carry plenty. Closed sections may apply during elk calving.",
      elevation_profile: "Steep switchbacks to the M, then more gradual rolling terrain along the ridge. Several ups and downs before the final push to the summit."
    },
    {
      name: "South Hills Spur Trail",
      location: "South Hills / Pattee Canyon",
      distance: 4.0,
      elevation: 650,
      difficulty: "moderate",
      tags: ["kid","dog"],
      description: "A network of interconnected trails in the South Hills neighborhood above the University. Popular with runners and mountain bikers. The trails wind through open ponderosa pine forest with good views of the Missoula Valley. Multiple loops possible for different distances and abilities.",
      lat: 46.8400,
      lng: -113.9550,
      trailhead_directions: "Multiple access points from the South Hills neighborhood. Most popular: park at the Deer Creek Rd trailhead or access from the University via the M Trail system.",
      seasonal_notes: "Year-round access. Some trails may be muddy in spring. Shared with mountain bikers — stay alert, especially on weekends. Good winter hiking when snow is packed.",
      elevation_profile: "Rolling terrain with moderate ups and downs. No single big climb; instead, a series of gentle hills."
    },
    {
      name: "Bitterroot River Trail – Kelly Island",
      location: "Kelly Island / South Missoula",
      distance: 2.0,
      elevation: 30,
      difficulty: "easy",
      tags: ["kid","stroller","dog"],
      description: "A flat, family-friendly loop on Kelly Island along the Bitterroot River. The trail weaves through cottonwood groves and past river access points perfect for wading and picnicking. Great blue herons nest on the island. One of the best spots near Missoula for an easy nature walk with small children.",
      lat: 46.8150,
      lng: -114.0500,
      trailhead_directions: "From Reserve St, head south and turn right on Old US-93. Access the trailhead from the Fort Missoula area or Chief Charlo School.",
      seasonal_notes: "Best April–October. Some flooding possible in late spring. Excellent fall foliage. Can be buggy near the river in June–July.",
      elevation_profile: "Flat loop with negligible elevation change."
    },
    {
      name: "Blue Mountain Summit Loop",
      location: "Blue Mountain Recreation Area",
      distance: 6.5,
      elevation: 1250,
      difficulty: "moderate",
      tags: ["dog"],
      description: "A longer loop option in the Blue Mountain area that traverses the full summit ridge. Combines the Nature Trail with the summit connector for a more complete Blue Mountain experience. Views stretch from the Bitterroot Range to the Rattlesnake Wilderness. Well-signed junctions make navigation easy.",
      lat: 46.8300,
      lng: -114.1200,
      trailhead_directions: "Same as Blue Mountain Nature Trail. Start from the main Blue Mountain Recreation Area parking lot on Blue Mountain Rd.",
      seasonal_notes: "Best May–November. Upper ridge can be windy. Snow lingers on north-facing slopes into April. Mountain bikers use these trails heavily on weekends.",
      elevation_profile: "Steady climb to the summit with a rolling ridge traverse. Descent on the back side is moderate with good switchbacks."
    },
    {
      name: "Council Grove State Park",
      location: "Council Grove / West Missoula",
      distance: 1.0,
      elevation: 20,
      difficulty: "easy",
      tags: ["kid","stroller"],
      description: "A short, interpretive loop through a beautiful grove of old cottonwood trees at the confluence of the Clark Fork and Bitterroot Rivers. Historic site where the Hellgate Treaty was signed in 1855. Interpretive signs explain the area's cultural and natural history. Benches and shade make it perfect for a peaceful family outing.",
      lat: 46.8530,
      lng: -114.0970,
      trailhead_directions: "Located on Mullan Rd west of Reserve St. Well-signed parking area on the north side of the road.",
      seasonal_notes: "Year-round. Short enough to enjoy in any season. Beautiful snow-covered cottonwoods in winter. Lovely spring wildflowers. Some mosquitoes near the river in summer.",
      elevation_profile: "Completely flat interpretive loop."
    },
    {
      name: "Woods Gulch Trail",
      location: "Rattlesnake / Woods Gulch",
      distance: 3.0,
      elevation: 600,
      difficulty: "moderate",
      tags: ["kid","dog"],
      description: "A moderately steep trail through shady forest in the Rattlesnake neighborhood. Less crowded than the main Rattlesnake Creek Trail. The trail follows a small seasonal creek through a quiet gulch. Good for building hiking stamina with older kids. Connects to the larger Rattlesnake trail network for longer options.",
      lat: 46.9000,
      lng: -113.9900,
      trailhead_directions: "From the Rattlesnake, take Sawmill Gulch Rd. Trailhead is at the end of the road with limited parking.",
      seasonal_notes: "Best April–November. Can be muddy in spring. Shady canyon stays cool in summer. Some downed trees after winter storms.",
      elevation_profile: "Moderate climb up the gulch with a few steeper pitches. Mostly in forest shade."
    },
    {
      name: "Hellgate Canyon Trail",
      location: "East Missoula / Hellgate Canyon",
      distance: 2.5,
      elevation: 200,
      difficulty: "easy",
      tags: ["kid","dog"],
      description: "A scenic trail through the dramatic Hellgate Canyon where the Clark Fork River carved through the mountains. Rocky canyon walls tower above the trail. Watch for bighorn sheep on the cliff faces. The trail follows an old road grade, making it wide and gentle. Great views of the river and interesting geology.",
      lat: 46.8700,
      lng: -113.9400,
      trailhead_directions: "Access from East Broadway in East Missoula, near the Hellgate Canyon trailhead just past the I-90 interchange.",
      seasonal_notes: "Year-round. Canyon can be windy. Ice forms on the trail in winter from canyon walls. Watch for loose rocks. Spring runoff makes the river dramatic and loud.",
      elevation_profile: "Gentle grade along the old road. Minor ups and downs but nothing significant."
    }
  ];

  const insertTrail = db.prepare(`INSERT INTO trails (name, location, distance, elevation, difficulty, tags, description, lat, lng, trailhead_directions, seasonal_notes, elevation_profile)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const seed = db.transaction(() => {
    trails.forEach(t => insertTrail.run(t.name, t.location, t.distance, t.elevation, t.difficulty, JSON.stringify(t.tags), t.description, t.lat, t.lng, t.trailhead_directions, t.seasonal_notes, t.elevation_profile));
  });
  seed();

  // No seeded hikes - users create their own
  console.log('Seeded database with 20 real Missoula trails');
}

seedIfEmpty();

// Serve the SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Missoula Family Hikes running on :${PORT}`));
