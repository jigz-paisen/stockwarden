/* ================================================
   StockWarden — server.js
   Express + MySQL2 Backend with Auth & RBAC
   ================================================

   Local setup:
     1. npm install
     2. Copy .env.example to .env and fill in your credentials
     3. Run schema.sql against your MySQL database
     4. node server.js

   Railway deployment:
     - Set DATABASE_URL and SESSION_SECRET in Railway env vars
     - Railway MySQL plugin provides DATABASE_URL automatically
     - PORT is also set automatically by Railway

   Default admin login (change after first login):
     Username: admin
     Password: Admin@1234

   ================================================ */

require('dotenv').config();
const express  = require('express');
const mysql    = require('mysql2/promise');
const bcrypt   = require('bcrypt');
const session  = require('express-session');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));


/* ================================================
   DATABASE — Connection Pool
   ================================================ */

const pool = process.env.DATABASE_URL
  ? mysql.createPool(process.env.DATABASE_URL)
  : mysql.createPool({
      host:     process.env.DB_HOST     || 'localhost',
      port:     process.env.DB_PORT     || 3306,
      user:     process.env.DB_USER     || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME     || 'stockwarden',
      charset:  'UTF8MB4_0900_AI_CI',
      waitForConnections: true,
      connectionLimit:    10,
    });

pool.getConnection()
  .then(conn => { console.log('✅ MySQL connected successfully'); conn.release(); })
  .catch(err  => { console.error('❌ MySQL connection failed:', err.message); process.exit(1); });


/* ================================================
   SESSION MIDDLEWARE
   ================================================ */

app.use(session({
  secret:            process.env.SESSION_SECRET || 'stockwarden-dev-secret-change-in-prod',
  resave:            false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    maxAge:   24 * 60 * 60 * 1000,   // 24 hours default
  },
}));


/* ================================================
   AUTH MIDDLEWARE
   ================================================ */

// requireAuth — any logged-in user
function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

// requireRole — restrict to specific roles
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to perform this action' });
    }
    next();
  };
}


/* ================================================
   STATIC FILES
   login.html is public; everything else requires auth
   ================================================ */

// Public: login page
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Protected: main app — redirect to login if not authenticated
app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve static assets (css, js) — but protect app.js route awareness via session check in app itself
app.use(express.static(path.join(__dirname, 'public')));


/* ================================================
   HELPER
   ================================================ */

const asyncHandler = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);


/* ================================================
   ROUTES — AUTH
   ================================================ */

// GET /auth/me — returns current session user (used by frontend on load)
app.get('/auth/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  res.json(req.session.user);
});

// POST /auth/login
app.post('/auth/login', asyncHandler(async (req, res) => {
  const { username, password, remember } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const [rows] = await pool.query(
    'SELECT * FROM users WHERE username = ? AND is_active = 1',
    [username]
  );

  if (rows.length === 0) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const user  = rows[0];
  const match = await bcrypt.compare(password, user.password);

  if (!match) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  // Extend session if "remember me" checked (30 days)
  if (remember) {
    req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
  }

  req.session.user = {
    id:       user.id,
    username: user.username,
    email:    user.email,
    role:     user.role,
  };

  res.json({ message: 'Login successful', user: req.session.user });
}));

// POST /auth/logout
app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ message: 'Logged out successfully' });
  });
});


/* ================================================
   ROUTES — USERS (admin only)
   ================================================ */

// GET /api/users
app.get('/api/users', requireRole('admin'), asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    'SELECT id, username, email, role, is_active, created_at FROM users ORDER BY id ASC'
  );
  res.json(rows);
}));

// POST /api/users — admin creates a new user
app.post('/api/users', requireRole('admin'), asyncHandler(async (req, res) => {
  const { username, email, password, role } = req.body;

  if (!username || !email || !password || !role) {
    return res.status(400).json({ error: 'username, email, password, and role are required' });
  }

  const validRoles = ['admin', 'manager', 'viewer'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: 'role must be admin, manager, or viewer' });
  }

  const hash = await bcrypt.hash(password, 10);

  const [result] = await pool.query(
    'INSERT INTO users (username, email, password, role) VALUES (?, ?, ?, ?)',
    [username, email, hash, role]
  );

  const [rows] = await pool.query(
    'SELECT id, username, email, role, is_active, created_at FROM users WHERE id = ?',
    [result.insertId]
  );
  res.status(201).json(rows[0]);
}));

// PUT /api/users/:id — admin updates user role or active status
app.put('/api/users/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const { role, is_active } = req.body;

  const [existing] = await pool.query('SELECT id FROM users WHERE id = ?', [req.params.id]);
  if (existing.length === 0) return res.status(404).json({ error: 'User not found' });

  // Prevent admin from deactivating themselves
  if (parseInt(req.params.id) === req.session.user.id && is_active === 0) {
    return res.status(400).json({ error: 'You cannot deactivate your own account' });
  }

  await pool.query(
    'UPDATE users SET role = ?, is_active = ? WHERE id = ?',
    [role, is_active, req.params.id]
  );

  const [rows] = await pool.query(
    'SELECT id, username, email, role, is_active, created_at FROM users WHERE id = ?',
    [req.params.id]
  );
  res.json(rows[0]);
}));

// DELETE /api/users/:id
app.delete('/api/users/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  if (parseInt(req.params.id) === req.session.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account' });
  }

  const [existing] = await pool.query('SELECT id, username FROM users WHERE id = ?', [req.params.id]);
  if (existing.length === 0) return res.status(404).json({ error: 'User not found' });

  await pool.query('DELETE FROM users WHERE id = ?', [req.params.id]);
  res.json({ message: `User "${existing[0].username}" deleted` });
}));

// PUT /api/users/:id/password — change own password
app.put('/api/users/:id/password', requireAuth, asyncHandler(async (req, res) => {
  const { current_password, new_password } = req.body;

  // Users can only change their own password (admin can change anyone's)
  if (parseInt(req.params.id) !== req.session.user.id && req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'You can only change your own password' });
  }

  const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'User not found' });

  // Non-admins must provide current password
  if (req.session.user.role !== 'admin') {
    const match = await bcrypt.compare(current_password, rows[0].password);
    if (!match) return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const hash = await bcrypt.hash(new_password, 10);
  await pool.query('UPDATE users SET password = ? WHERE id = ?', [hash, req.params.id]);
  res.json({ message: 'Password updated successfully' });
}));


/* ================================================
   ROUTES — PRODUCTS
   ================================================ */

app.get('/api/products', requireAuth, asyncHandler(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM v_inventory_status ORDER BY id ASC');
  res.json(rows);
}));

app.get('/api/products/:id', requireAuth, asyncHandler(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM v_inventory_status WHERE id = ?', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Product not found' });
  res.json(rows[0]);
}));

app.post('/api/products', requireRole('admin', 'manager'), asyncHandler(async (req, res) => {
  const { sku, name, description, category_id, quantity, reorder_point, price, cost, supplier, location } = req.body;
  if (!sku || !name) return res.status(400).json({ error: 'sku and name are required' });

  const [result] = await pool.query(
    `INSERT INTO products (sku, name, description, category_id, quantity, reorder_point, price, cost, supplier, location)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [sku, name, description || null, category_id || null,
     quantity || 0, reorder_point || 10, price || 0, cost || 0,
     supplier || null, location || null]
  );

  const [rows] = await pool.query('SELECT * FROM v_inventory_status WHERE id = ?', [result.insertId]);
  res.status(201).json(rows[0]);
}));

app.put('/api/products/:id', requireRole('admin', 'manager'), asyncHandler(async (req, res) => {
  const { sku, name, description, category_id, quantity, reorder_point, price, cost, supplier, location } = req.body;

  const [existing] = await pool.query('SELECT id FROM products WHERE id = ?', [req.params.id]);
  if (existing.length === 0) return res.status(404).json({ error: 'Product not found' });

  await pool.query(
    `UPDATE products SET sku=?, name=?, description=?, category_id=?, quantity=?,
     reorder_point=?, price=?, cost=?, supplier=?, location=? WHERE id=?`,
    [sku, name, description || null, category_id || null,
     quantity || 0, reorder_point || 10, price || 0, cost || 0,
     supplier || null, location || null, req.params.id]
  );

  const [rows] = await pool.query('SELECT * FROM v_inventory_status WHERE id = ?', [req.params.id]);
  res.json(rows[0]);
}));

app.delete('/api/products/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const [existing] = await pool.query('SELECT id, name FROM products WHERE id = ?', [req.params.id]);
  if (existing.length === 0) return res.status(404).json({ error: 'Product not found' });

  await pool.query('DELETE FROM products WHERE id = ?', [req.params.id]);
  res.json({ message: `Product "${existing[0].name}" deleted` });
}));


/* ================================================
   ROUTES — CATEGORIES
   ================================================ */

app.get('/api/categories', requireAuth, asyncHandler(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM categories ORDER BY id ASC');
  res.json(rows);
}));

app.post('/api/categories', requireRole('admin', 'manager'), asyncHandler(async (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const [result] = await pool.query(
    'INSERT INTO categories (name, description) VALUES (?, ?)',
    [name, description || null]
  );

  const [rows] = await pool.query('SELECT * FROM categories WHERE id = ?', [result.insertId]);
  res.status(201).json(rows[0]);
}));

app.put('/api/categories/:id', requireRole('admin', 'manager'), asyncHandler(async (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const [existing] = await pool.query('SELECT id FROM categories WHERE id = ?', [req.params.id]);
  if (existing.length === 0) return res.status(404).json({ error: 'Category not found' });

  await pool.query('UPDATE categories SET name=?, description=? WHERE id=?',
    [name, description || null, req.params.id]);

  const [rows] = await pool.query('SELECT * FROM categories WHERE id = ?', [req.params.id]);
  res.json(rows[0]);
}));

app.delete('/api/categories/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const [existing] = await pool.query('SELECT id, name FROM categories WHERE id = ?', [req.params.id]);
  if (existing.length === 0) return res.status(404).json({ error: 'Category not found' });

  const [products] = await pool.query('SELECT id FROM products WHERE category_id = ?', [req.params.id]);
  if (products.length > 0) {
    return res.status(400).json({ error: `Cannot delete — ${products.length} product(s) are assigned to this category` });
  }

  await pool.query('DELETE FROM categories WHERE id = ?', [req.params.id]);
  res.json({ message: `Category "${existing[0].name}" deleted` });
}));


/* ================================================
   ROUTES — TRANSACTIONS
   ================================================ */

app.get('/api/transactions', requireAuth, asyncHandler(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM v_transactions ORDER BY created_at DESC');
  res.json(rows);
}));

app.post('/api/transactions', requireRole('admin', 'manager'), asyncHandler(async (req, res) => {
  const { product_id, type, quantity, note } = req.body;

  if (!product_id || !type || !quantity) {
    return res.status(400).json({ error: 'product_id, type, and quantity are required' });
  }

  const validTypes = ['stock_in', 'stock_out', 'adjustment', 'return'];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` });
  }

  const qtyChange  = type === 'stock_out' ? -Math.abs(quantity) : Math.abs(quantity);
  const created_by = req.session.user.username;

  await pool.query('CALL adjust_stock(?, ?, ?, ?, ?)',
    [product_id, qtyChange, type, note || null, created_by]);

  const [rows] = await pool.query(
    'SELECT * FROM v_transactions WHERE product_id = ? ORDER BY created_at DESC LIMIT 1',
    [product_id]
  );
  res.status(201).json(rows[0]);
}));


/* ================================================
   ROUTES — DASHBOARD & REPORTS
   ================================================ */

app.get('/api/dashboard', requireAuth, asyncHandler(async (req, res) => {
  const [[stats]] = await pool.query(`
    SELECT COUNT(*) AS total_products, SUM(quantity * cost) AS total_value,
      SUM(CASE WHEN stock_status = 'low_stock'    THEN 1 ELSE 0 END) AS low_count,
      SUM(CASE WHEN stock_status = 'out_of_stock' THEN 1 ELSE 0 END) AS out_count
    FROM v_inventory_status
  `);

  const [alerts] = await pool.query(`
    SELECT id, sku, name, quantity, reorder_point, stock_status
    FROM v_inventory_status WHERE stock_status != 'in_stock' ORDER BY quantity ASC
  `);

  const [recentTx] = await pool.query(
    'SELECT * FROM v_transactions ORDER BY created_at DESC LIMIT 10'
  );

  res.json({ stats, alerts, recentTransactions: recentTx });
}));

app.get('/api/reports', requireAuth, asyncHandler(async (req, res) => {
  const [top5] = await pool.query(`
    SELECT name, sku, quantity, cost, (quantity * cost) AS stock_value
    FROM v_inventory_status ORDER BY stock_value DESC LIMIT 5
  `);

  const [byCat] = await pool.query(`
    SELECT c.name AS category_name, COUNT(p.id) AS product_count,
      SUM(p.quantity) AS total_qty, SUM(p.quantity*p.cost) AS total_value
    FROM categories c LEFT JOIN products p ON p.category_id = c.id
    GROUP BY c.id, c.name ORDER BY total_value DESC
  `);

  const [[txCount]]  = await pool.query('SELECT COUNT(*) AS count FROM transactions');
  const [[catCount]] = await pool.query('SELECT COUNT(*) AS count FROM categories');
  const [[avgStock]] = await pool.query('SELECT ROUND(AVG(quantity)) AS avg FROM products');

  res.json({ top5, byCat, txCount: txCount.count, catCount: catCount.count, avgStock: avgStock.avg });
}));


/* ================================================
   ERROR HANDLER
   ================================================ */

app.use((err, req, res, next) => {
  console.error('API error:', err.message);
  if (err.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({ error: 'A record with this value already exists' });
  }
  res.status(500).json({ error: err.message || 'Internal server error' });
});


/* ================================================
   START SERVER
   ================================================ */

app.listen(PORT, () => {
  console.log(`🚀 StockWarden running at http://localhost:${PORT}`);
});
